import { promises as fs } from 'fs';
import path from 'path';
import { isMap, parseDocument } from 'yaml';
import {
  buildOpenSpecStoreRegisterInvocation,
  configureOpenSpecStore,
  createOpenSpecStoreId,
  getOpenSpecStoreRoot,
  isOpenSpecStoreRoot,
  unregisterOpenSpecStore,
} from '../../domains/integrations/openspec.js';

interface MigrateDocsOptions {
  dryRun?: boolean;
  apply?: boolean;
  repairStore?: boolean;
  includeActive?: boolean;
  openSpecStore?: string;
  log?: (line: string) => void;
}

interface ProjectConfig {
  content: string | undefined;
  storeId: string | undefined;
  layout: 'legacy' | 'docs' | undefined;
}

interface ActiveChangeStateBackup {
  path: string;
  content: string;
}

interface StoreMetadataBackup {
  metadataPath: string;
  metadataDirectory: string;
  directoryExisted: boolean;
  content: Buffer | undefined;
}

interface RootMergePlan {
  configPath: string;
  configContent: Buffer;
  moves: Array<{ source: string; target: string }>;
}

const LEGACY_CHANGE_PATH_PREFIX = 'openspec/changes/';

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

interface ActiveChanges {
  all: string[];
  comet: string[];
}

async function activeChanges(changesRoot: string): Promise<ActiveChanges> {
  if (!(await exists(changesRoot))) return { all: [], comet: [] };
  const all: string[] = [];
  const comet: string[] = [];
  for (const entry of await fs.readdir(changesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'archive') continue;
    all.push(entry.name);
    if (await exists(path.join(changesRoot, entry.name, '.comet.yaml'))) comet.push(entry.name);
  }
  return { all: all.sort(), comet: comet.sort() };
}

async function archivedChanges(changesRoot: string): Promise<string[]> {
  const archiveRoot = path.join(changesRoot, 'archive');
  if (!(await exists(archiveRoot))) return [];
  return (await fs.readdir(archiveRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function pathKind(target: string): Promise<'missing' | 'file' | 'directory' | 'other'> {
  try {
    const stat = await fs.stat(target);
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

class UnhealthyOpenSpecRootError extends Error {}

async function assertNoSymbolicLinks(directory: string, label: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new UnhealthyOpenSpecRootError(
        `Cannot migrate docs because ${path.relative(directory, target) || label} inside ${label}/ is a symbolic link or junction. Replace it with a real file or directory before migrating.`,
      );
    }
    if (entry.isDirectory()) await assertNoSymbolicLinks(target, label);
  }
}

async function assertHealthyOpenSpecRoot(rootPath: string, label: string): Promise<void> {
  const rootStat = await fs.lstat(rootPath);
  if (rootStat.isSymbolicLink()) {
    throw new UnhealthyOpenSpecRootError(
      `Cannot migrate docs because ${label}/ is a symbolic link or junction. Replace it with a real directory before migrating.`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new UnhealthyOpenSpecRootError(
      `Cannot migrate docs because ${label}/ is not a healthy OpenSpec root (missing or invalid: ${label}/).`,
    );
  }
  await assertNoSymbolicLinks(rootPath, label);
  const [root, configYaml, configYml, specs, changes, archive] = await Promise.all([
    pathKind(rootPath),
    pathKind(path.join(rootPath, 'config.yaml')),
    pathKind(path.join(rootPath, 'config.yml')),
    pathKind(path.join(rootPath, 'specs')),
    pathKind(path.join(rootPath, 'changes')),
    pathKind(path.join(rootPath, 'changes', 'archive')),
  ]);
  const missing: string[] = [];
  if (root !== 'directory') missing.push(`${label}/`);
  if (configYaml !== 'file' && configYml !== 'file') missing.push(`${label}/config.yaml`);
  if (specs !== 'directory') missing.push(`${label}/specs/`);
  if (changes !== 'directory') missing.push(`${label}/changes/`);
  if (archive !== 'directory') missing.push(`${label}/changes/archive/`);
  if (missing.length > 0) {
    throw new UnhealthyOpenSpecRootError(
      `Cannot migrate docs because ${label}/ is not a healthy OpenSpec root (missing or invalid: ${missing.join(', ')}).`,
    );
  }
}

export async function isHealthyOpenSpecRoot(
  rootPath: string,
  label = 'openspec',
): Promise<boolean> {
  try {
    await assertHealthyOpenSpecRoot(rootPath, label);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof UnhealthyOpenSpecRootError || code === 'ENOENT' || code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
}

async function repairableOpenSpecDirectories(rootPath: string, label: string): Promise<string[]> {
  const rootStat = await fs.lstat(rootPath);
  if (rootStat.isSymbolicLink()) {
    throw new Error(
      `Cannot repair ${label}/ because it is a symbolic link or junction. Replace it with a real directory first.`,
    );
  }
  await assertNoSymbolicLinks(rootPath, label);
  const root = await pathKind(rootPath);
  const configYaml = await pathKind(path.join(rootPath, 'config.yaml'));
  const configYml = await pathKind(path.join(rootPath, 'config.yml'));
  if (root !== 'directory' || (configYaml !== 'file' && configYml !== 'file')) {
    throw new Error(
      `Cannot repair ${label}/ because it must contain an OpenSpec config.yaml or config.yml file.`,
    );
  }
  const candidates = [
    path.join(rootPath, 'specs'),
    path.join(rootPath, 'changes'),
    path.join(rootPath, 'changes', 'archive'),
  ];
  const missing: string[] = [];
  for (const candidate of candidates) {
    const kind = await pathKind(candidate);
    if (kind === 'missing') missing.push(candidate);
    else if (kind !== 'directory') {
      throw new Error(
        `Cannot repair ${label}/ because ${path.relative(rootPath, candidate)} is not a directory.`,
      );
    }
  }
  return missing;
}

async function rootConfig(rootPath: string): Promise<{ path: string; content: Buffer }> {
  const yamlPath = path.join(rootPath, 'config.yaml');
  if ((await pathKind(yamlPath)) === 'file') {
    return { path: yamlPath, content: await fs.readFile(yamlPath) };
  }
  const ymlPath = path.join(rootPath, 'config.yml');
  return { path: ymlPath, content: await fs.readFile(ymlPath) };
}

async function entriesAt(directory: string): Promise<string[]> {
  return (await fs.readdir(directory, { withFileTypes: true })).map((entry) => entry.name).sort();
}

async function assertNoMergeConflicts(
  legacyDirectory: string,
  docsDirectory: string,
  label: string,
  excludedEntries: readonly string[] = [],
): Promise<void> {
  const conflictKey = (entry: string) =>
    process.platform === 'win32' ? entry.toLowerCase() : entry;
  const docsEntries = new Set((await entriesAt(docsDirectory)).map(conflictKey));
  const excluded = new Set(excludedEntries);
  const conflict = (await entriesAt(legacyDirectory)).find(
    (entry) => !excluded.has(entry) && docsEntries.has(conflictKey(entry)),
  );
  if (conflict) {
    throw new Error(`Cannot migrate docs because conflicting ${label} '${conflict}' exists.`);
  }
}

async function planRootMerge(legacyRoot: string, docsRoot: string): Promise<RootMergePlan> {
  const [legacyConfig, docsConfig] = await Promise.all([
    rootConfig(legacyRoot),
    rootConfig(docsRoot),
  ]);
  if (
    path.basename(legacyConfig.path) !== path.basename(docsConfig.path) ||
    !legacyConfig.content.equals(docsConfig.content)
  ) {
    throw new Error(
      'Cannot migrate docs because the legacy and docs OpenSpec config files differ.',
    );
  }

  const legacyChanges = path.join(legacyRoot, 'changes');
  const docsChanges = path.join(docsRoot, 'changes');
  await Promise.all([
    assertNoMergeConflicts(legacyRoot, docsRoot, 'root entry', [
      'config.yaml',
      'config.yml',
      'specs',
      'changes',
    ]),
    assertNoMergeConflicts(path.join(legacyRoot, 'specs'), path.join(docsRoot, 'specs'), 'spec', [
      '.gitkeep',
    ]),
    assertNoMergeConflicts(
      path.join(legacyChanges, 'archive'),
      path.join(docsChanges, 'archive'),
      'archive change',
      ['.gitkeep'],
    ),
    assertNoMergeConflicts(legacyChanges, docsChanges, 'active change', ['archive']),
  ]);

  const moves = [
    ...(await entriesAt(legacyRoot))
      .filter(
        (entry) =>
          entry !== 'config.yaml' &&
          entry !== 'config.yml' &&
          entry !== 'specs' &&
          entry !== 'changes',
      )
      .map((entry) => ({
        source: path.join(legacyRoot, entry),
        target: path.join(docsRoot, entry),
      })),
    ...(await entriesAt(path.join(legacyRoot, 'specs')))
      .filter((entry) => entry !== '.gitkeep')
      .map((entry) => ({
        source: path.join(legacyRoot, 'specs', entry),
        target: path.join(docsRoot, 'specs', entry),
      })),
    ...(await entriesAt(path.join(legacyChanges, 'archive')))
      .filter((entry) => entry !== '.gitkeep')
      .map((entry) => ({
        source: path.join(legacyChanges, 'archive', entry),
        target: path.join(docsChanges, 'archive', entry),
      })),
    ...(await entriesAt(legacyChanges))
      .filter((entry) => entry !== 'archive')
      .map((entry) => ({
        source: path.join(legacyChanges, entry),
        target: path.join(docsChanges, entry),
      })),
  ];
  return { configPath: legacyConfig.path, configContent: legacyConfig.content, moves };
}

async function restoreMergedLegacyRoot(
  legacyRoot: string,
  mergePlan: RootMergePlan,
): Promise<void> {
  await fs.mkdir(path.join(legacyRoot, 'changes', 'archive'), { recursive: true });
  await fs.mkdir(path.join(legacyRoot, 'specs'), { recursive: true });
  await fs.writeFile(mergePlan.configPath, mergePlan.configContent);
}

function isLegacyChangePath(value: string): boolean {
  return value.replaceAll('\\', '/').startsWith(LEGACY_CHANGE_PATH_PREFIX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidateLegacyRuntimeArtifactPaths(value: unknown): boolean {
  if (Array.isArray(value)) {
    let changed = false;
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const item = value[index];
      if (typeof item === 'string' && isLegacyChangePath(item)) {
        value.splice(index, 1);
        changed = true;
        continue;
      }
      changed = invalidateLegacyRuntimeArtifactPaths(item) || changed;
    }
    return changed;
  }
  if (!isRecord(value)) return false;

  let changed = false;
  for (const [key, artifact] of Object.entries(value)) {
    if (typeof artifact === 'string' && isLegacyChangePath(artifact)) {
      delete value[key];
      changed = true;
      continue;
    }
    changed = invalidateLegacyRuntimeArtifactPaths(artifact) || changed;
  }
  return changed;
}

async function runtimeArtifactFiles(runtimeRoot: string): Promise<string[]> {
  if (!(await exists(runtimeRoot))) return [];

  const files: string[] = [];
  for (const entry of await fs.readdir(runtimeRoot, { withFileTypes: true })) {
    const target = path.join(runtimeRoot, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await runtimeArtifactFiles(target)));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(target);
    }
  }
  return files.sort();
}

async function migrateActiveChangeRuntimeArtifacts(
  docsRoot: string,
  change: string,
  backups: ActiveChangeStateBackup[],
): Promise<void> {
  const changeRoot = path.join(docsRoot, 'changes', change);
  for (const artifactPath of await runtimeArtifactFiles(path.join(changeRoot, '.comet'))) {
    const content = await fs.readFile(artifactPath, 'utf8');
    let artifact: unknown;
    try {
      artifact = JSON.parse(content);
    } catch (error) {
      throw new Error(
        `Cannot migrate active change '${change}' because runtime artifact ${path.relative(changeRoot, artifactPath)} must be valid JSON.`,
        { cause: error },
      );
    }
    if (!isRecord(artifact)) {
      throw new Error(
        `Cannot migrate active change '${change}' because runtime artifact ${path.relative(changeRoot, artifactPath)} must be a JSON object.`,
      );
    }
    if (invalidateLegacyRuntimeArtifactPaths(artifact)) {
      backups.push({ path: artifactPath, content });
      await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    }
  }
}

async function migrateActiveChangeStates(
  docsRoot: string,
  changes: readonly string[],
  backups: ActiveChangeStateBackup[],
): Promise<void> {
  for (const change of changes) {
    const statePath = path.join(docsRoot, 'changes', change, '.comet.yaml');
    const content = await fs.readFile(statePath, 'utf8');
    const document = parseDocument(content, { uniqueKeys: false });
    if (document.errors.length > 0 || !isMap(document.contents)) {
      throw new Error(
        `Cannot migrate active change '${change}' because .comet.yaml must be a valid YAML mapping.`,
      );
    }

    backups.push({ path: statePath, content });
    document.set('artifact_layout', 'docs');
    document.set('openspec_root', 'docs');
    document.set('superpowers_root', 'docs/superpowers');
    // Handoff paths include the legacy change root. Regenerate them after the move.
    document.delete('handoff_context');
    document.delete('handoff_hash');
    const verificationReport = document.get('verification_report');
    if (typeof verificationReport === 'string' && isLegacyChangePath(verificationReport)) {
      document.delete('verification_report');
    }
    await fs.writeFile(statePath, document.toString(), 'utf8');
    await migrateActiveChangeRuntimeArtifacts(docsRoot, change, backups);
  }
}

async function restoreActiveChangeStates(
  backups: readonly ActiveChangeStateBackup[],
): Promise<void> {
  for (const backup of backups) {
    await fs.writeFile(backup.path, backup.content, 'utf8');
  }
}

function formatInvocation(invocation: { command: string; args: string[] }): string {
  return `${invocation.command} ${invocation.args.join(' ')}`;
}

function parseProjectConfig(content: string | undefined): ProjectConfig {
  if (content === undefined) {
    return { content, storeId: undefined, layout: undefined };
  }

  const document = parseDocument(content, { uniqueKeys: false });
  if (document.errors.length > 0 || !isMap(document.contents)) {
    throw new Error('Cannot migrate docs because .comet/config.yaml must be a valid YAML mapping.');
  }

  const config = document.toJS();
  const record = config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
  const openSpec =
    record.openspec && typeof record.openspec === 'object' && !Array.isArray(record.openspec)
      ? (record.openspec as Record<string, unknown>)
      : undefined;
  const configuredStore = openSpec?.store;

  return {
    content,
    storeId:
      typeof configuredStore === 'string' && configuredStore.trim().length > 0
        ? configuredStore.trim()
        : undefined,
    layout:
      record.artifact_layout === 'legacy' || record.artifact_layout === 'docs'
        ? record.artifact_layout
        : undefined,
  };
}

function renderDocsConfig(content: string | undefined, storeId: string | undefined): string {
  const document = parseDocument(content?.trim() ? content : '{}', { uniqueKeys: false });
  if (document.errors.length > 0 || !isMap(document.contents)) {
    throw new Error('Cannot migrate docs because .comet/config.yaml must be a valid YAML mapping.');
  }

  const openSpec = document.get('openspec', true);
  if (openSpec !== undefined && !isMap(openSpec)) {
    throw new Error('Cannot migrate docs because .comet/config.yaml openspec must be a mapping.');
  }
  if (openSpec === undefined) document.set('openspec', document.createNode({}));

  const superpowers = document.get('superpowers', true);
  if (superpowers !== undefined && !isMap(superpowers)) {
    throw new Error(
      'Cannot migrate docs because .comet/config.yaml superpowers must be a mapping.',
    );
  }
  if (superpowers === undefined) document.set('superpowers', document.createNode({}));

  document.set('artifact_layout', 'docs');
  document.setIn(['openspec', 'root'], 'docs');
  document.setIn(['superpowers', 'root'], 'docs/superpowers');
  if (storeId) {
    document.setIn(['openspec', 'store'], storeId);
  } else {
    document.deleteIn(['openspec', 'store']);
  }
  return document.toString();
}

async function restoreConfig(
  configPath: string,
  originalContent: string | undefined,
): Promise<void> {
  if (originalContent === undefined) {
    await fs.rm(configPath, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, originalContent, 'utf8');
}

async function cleanupCreatedDirectory(directory: string, existedBefore: boolean): Promise<void> {
  if (existedBefore) return;
  try {
    await fs.rmdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // The directory may legitimately hold other project artifacts.
    }
  }
}

async function snapshotStoreMetadata(docsDirectory: string): Promise<StoreMetadataBackup> {
  const metadataDirectory = path.join(docsDirectory, '.openspec-store');
  const metadataPath = path.join(metadataDirectory, 'store.yaml');
  const directoryExisted = (await pathKind(metadataDirectory)) !== 'missing';
  const metadataKind = await pathKind(metadataPath);
  if (metadataKind !== 'missing' && metadataKind !== 'file') {
    throw new Error('Cannot migrate docs because docs/.openspec-store/store.yaml must be a file.');
  }
  return {
    metadataPath,
    metadataDirectory,
    directoryExisted,
    content: metadataKind === 'file' ? await fs.readFile(metadataPath) : undefined,
  };
}

async function restoreStoreMetadata(backup: StoreMetadataBackup): Promise<void> {
  if (backup.content !== undefined) {
    await fs.mkdir(backup.metadataDirectory, { recursive: true });
    await fs.writeFile(backup.metadataPath, backup.content);
    return;
  }
  await fs.rm(backup.metadataPath, { force: true });
  if (!backup.directoryExisted) {
    await fs.rmdir(backup.metadataDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function currentLayout(
  config: ProjectConfig,
  legacyRootExists: boolean,
  docsRootExists: boolean,
): string {
  if (config.layout) return config.layout;
  if (docsRootExists) return 'docs';
  if (legacyRootExists) return 'legacy';
  return 'unknown';
}

export async function migrateDocsCommand(
  targetPath: string,
  options: MigrateDocsOptions = {},
): Promise<void> {
  const projectRoot = path.resolve(targetPath);
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const legacyRoot = path.join(projectRoot, 'openspec');
  const docsDirectory = path.join(projectRoot, 'docs');
  const docsRoot = path.join(docsDirectory, 'openspec');
  const configPath = path.join(projectRoot, '.comet', 'config.yaml');
  const configDirectory = path.dirname(configPath);
  const [legacyRootExists, docsRootExists, configExists] = await Promise.all([
    exists(legacyRoot),
    exists(docsRoot),
    exists(configPath),
  ]);
  const config = parseProjectConfig(
    configExists ? await fs.readFile(configPath, 'utf8') : undefined,
  );

  if (options.apply && options.dryRun) {
    throw new Error('--apply and --dry-run cannot be used together.');
  }

  if (legacyRootExists) await assertHealthyOpenSpecRoot(legacyRoot, 'openspec');
  const docsRepairDirectories =
    docsRootExists && options.repairStore && !legacyRootExists
      ? await repairableOpenSpecDirectories(docsRoot, 'docs/openspec')
      : [];
  if (docsRootExists && docsRepairDirectories.length === 0) {
    await assertHealthyOpenSpecRoot(docsRoot, 'docs/openspec');
  }

  const isMigration = legacyRootExists;
  const isMerge = legacyRootExists && docsRootExists;
  const mergePlan = isMerge ? await planRootMerge(legacyRoot, docsRoot) : undefined;

  const legacyActive = legacyRootExists
    ? await activeChanges(path.join(legacyRoot, 'changes'))
    : { all: [], comet: [] };
  const legacyArchived = legacyRootExists
    ? await archivedChanges(path.join(legacyRoot, 'changes'))
    : [];
  if (legacyActive.all.length > 0 && !options.includeActive) {
    throw new Error(
      `Active changes exist: ${legacyActive.all
        .map((name) => `openspec/changes/${name}`)
        .join(', ')}. Re-run with --include-active after review.`,
    );
  }

  const configuredStoreId = options.openSpecStore?.trim() || config.storeId;
  const storeId =
    configuredStoreId ??
    (isMigration && !options.repairStore ? createOpenSpecStoreId(projectRoot) : undefined);
  if (options.repairStore && !storeId) {
    throw new Error(
      'Cannot repair the OpenSpec store without an id. Pass --openspec-store <id> or configure openspec.store first.',
    );
  }

  const targetConfig =
    options.apply && (isMigration || options.repairStore)
      ? renderDocsConfig(config.content, storeId)
      : undefined;
  const registeredStoreRoot = storeId ? getOpenSpecStoreRoot(projectRoot, storeId) : undefined;
  if (registeredStoreRoot && !isOpenSpecStoreRoot(projectRoot, registeredStoreRoot)) {
    throw new Error(
      `OpenSpec store '${storeId}' is already registered to another root (${registeredStoreRoot}). Pass --openspec-store <new-id> before migrating.`,
    );
  }

  if (!options.apply) {
    log(`Current layout: ${currentLayout(config, legacyRootExists, docsRootExists)}`);
    log('Target layout: docs');
    log(`Legacy OpenSpec root: ${legacyRootExists ? 'present' : 'missing'}`);
    log(`Docs OpenSpec root: ${docsRootExists ? 'present' : 'missing'}`);
    log(`Active changes: ${legacyActive.all.length}`);
    log(`Archived changes: ${legacyArchived.length}`);
    if (isMerge) {
      log('Would merge: openspec -> docs/openspec');
    } else if (isMigration) {
      log('Would move: openspec -> docs/openspec');
    }
    if (storeId && (isMigration || options.repairStore)) {
      log(
        `Would run: ${formatInvocation(
          buildOpenSpecStoreRegisterInvocation(projectRoot, storeId),
        )}`,
      );
    }
    if (docsRootExists && !isMigration && options.repairStore) {
      log('Would repair the existing docs OpenSpec store registration.');
      for (const directory of docsRepairDirectories) {
        log(`Would create: ${path.relative(projectRoot, directory).replaceAll('\\', '/')}/`);
      }
    }
    log('No files were changed.');
    return;
  }

  if (!isMigration && !docsRootExists) {
    throw new Error('No legacy or docs OpenSpec root exists to migrate or repair.');
  }
  if (!isMigration && !options.repairStore) {
    log(
      'Docs OpenSpec root already exists; no migration was performed. Use --repair-store to register it.',
    );
    return;
  }

  const docsDirectoryExisted = await exists(docsDirectory);
  const configDirectoryExisted = await exists(configDirectory);
  const storeMetadataBackup = storeId ? await snapshotStoreMetadata(docsDirectory) : undefined;
  let movedLegacyRoot = false;
  const movedMergeEntries: Array<{ source: string; target: string }> = [];
  let registeredNewStore = false;
  const activeStateBackups: ActiveChangeStateBackup[] = [];
  const createdRepairDirectories: string[] = [];

  try {
    for (const directory of docsRepairDirectories) {
      if (!(await exists(directory))) {
        await fs.mkdir(directory, { recursive: true });
        createdRepairDirectories.push(directory);
      }
    }
    if (isMerge && mergePlan) {
      for (const move of mergePlan.moves) {
        await fs.rename(move.source, move.target);
        movedMergeEntries.push(move);
      }
      if (legacyActive.comet.length > 0) {
        await migrateActiveChangeStates(docsRoot, legacyActive.comet, activeStateBackups);
      }
    } else if (isMigration) {
      await fs.mkdir(docsDirectory, { recursive: true });
      await fs.rename(legacyRoot, docsRoot);
      movedLegacyRoot = true;
      if (legacyActive.comet.length > 0) {
        await migrateActiveChangeStates(docsRoot, legacyActive.comet, activeStateBackups);
      }
    }

    if (storeId) {
      const status = configureOpenSpecStore(projectRoot, storeId);
      if (status !== 'installed') {
        throw new Error(`OpenSpec store configuration failed for ${storeId}.`);
      }
      registeredNewStore = registeredStoreRoot === undefined;
    }

    await fs.mkdir(configDirectory, { recursive: true });
    await fs.writeFile(configPath, targetConfig!, 'utf8');

    if (isMerge && mergePlan) {
      await fs.rm(mergePlan.configPath, { force: true });
      await fs.rm(path.join(legacyRoot, 'changes', 'archive', '.gitkeep'), { force: true });
      await fs.rm(path.join(legacyRoot, 'specs', '.gitkeep'), { force: true });
      await fs.rmdir(path.join(legacyRoot, 'changes', 'archive'));
      await fs.rmdir(path.join(legacyRoot, 'changes'));
      await fs.rmdir(path.join(legacyRoot, 'specs'));
      await fs.rmdir(legacyRoot);
    }

    if (isMerge) log('Merged: openspec -> docs/openspec');
    else if (isMigration) log('Migrated: openspec -> docs/openspec');
    if (activeStateBackups.length > 0) {
      log(
        `Updated active change layout state and invalidated handoffs: ${legacyActive.comet.join(', ')}`,
      );
    }
    if (options.repairStore && storeId) log(`Registered OpenSpec store: ${storeId}`);
  } catch (error) {
    const rollbackErrors: string[] = [];
    try {
      await restoreActiveChangeStates(activeStateBackups);
    } catch (rollbackError) {
      rollbackErrors.push(`active change state: ${(rollbackError as Error).message}`);
    }
    if (mergePlan) {
      try {
        await restoreMergedLegacyRoot(legacyRoot, mergePlan);
        for (const move of [...movedMergeEntries].reverse()) {
          await fs.rename(move.target, move.source);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`legacy root: ${(rollbackError as Error).message}`);
      }
    }
    if (movedLegacyRoot && (await exists(docsRoot)) && !(await exists(legacyRoot))) {
      try {
        await fs.rename(docsRoot, legacyRoot);
      } catch (rollbackError) {
        rollbackErrors.push(`legacy root: ${(rollbackError as Error).message}`);
      }
    }
    if (registeredNewStore && unregisterOpenSpecStore(projectRoot, storeId!) === 'failed') {
      rollbackErrors.push(`store registry: unable to unregister ${storeId}`);
    }
    if (storeMetadataBackup) {
      try {
        await restoreStoreMetadata(storeMetadataBackup);
      } catch (rollbackError) {
        rollbackErrors.push(`store metadata: ${(rollbackError as Error).message}`);
      }
    }
    for (const directory of [...createdRepairDirectories].reverse()) {
      try {
        await fs.rmdir(directory);
      } catch (rollbackError) {
        if ((rollbackError as NodeJS.ErrnoException).code !== 'ENOENT') {
          rollbackErrors.push(
            `repair directory ${path.relative(projectRoot, directory)}: ${(rollbackError as Error).message}`,
          );
        }
      }
    }
    try {
      await restoreConfig(configPath, config.content);
    } catch (rollbackError) {
      rollbackErrors.push(`config: ${(rollbackError as Error).message}`);
    }
    await cleanupCreatedDirectory(configDirectory, configDirectoryExisted);
    await cleanupCreatedDirectory(docsDirectory, docsDirectoryExisted);
    if (rollbackErrors.length > 0) {
      throw new Error(
        `Migration failed: ${(error as Error).message}. Rollback also failed (${rollbackErrors.join('; ')}).`,
        { cause: error },
      );
    }
    throw error;
  }
}

export type { MigrateDocsOptions };
