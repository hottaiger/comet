import { promises as fs } from 'fs';
import path from 'path';
import { parseDocument } from 'yaml';
import { assertOpenSpecChangeName } from './classic-change-name.js';
import type { ClassicChangeDirectory } from './classic-paths.js';

export type CometArtifactLayoutKind = 'legacy' | 'docs';

export interface CometArtifactLayout {
  projectRoot: string;
  layout: CometArtifactLayoutKind;
  openSpec: {
    storeId?: string;
    storeRoot: string;
    artifactRoot: string;
    changesDir: string;
    specsDir: string;
    archiveDir: string;
    commandArgs: string[];
    commandCwd: string;
  };
  superpowers: {
    root: string;
    specsDir: string;
    plansDir: string;
    reportsDir: string;
  };
}

export interface ResolveCometArtifactLayoutOptions {
  explicitLayout?: CometArtifactLayoutKind;
}

export interface ResolveCometChangeDirectoryOptions extends ResolveCometArtifactLayoutOptions {}

export interface ResolvedClassicChangeDirectory extends ClassicChangeDirectory {
  layout: CometArtifactLayoutKind;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readYamlRecord(file: string): Promise<Record<string, unknown>> {
  if (!(await exists(file))) return {};
  const document = parseDocument(await fs.readFile(file, 'utf8'));
  if (document.errors.length > 0) return {};
  const value = document.toJS();
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nestedString(
  record: Record<string, unknown>,
  key: string,
  nested: string,
): string | undefined {
  const value = record[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const nestedValue = (value as Record<string, unknown>)[nested];
  return typeof nestedValue === 'string' && nestedValue.trim() ? nestedValue.trim() : undefined;
}

function safeRelativePath(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (/^(?:[A-Za-z]:|[\\/]|~)/u.test(value)) return fallback;
  if (value.split(/[\\/]/u).includes('..')) return fallback;
  return value.replaceAll('\\', '/').replace(/^\/+/u, '').replace(/\/+$/u, '');
}

async function isHealthyOpenSpecRoot(
  projectRoot: string,
  storeRootRelative: string,
): Promise<boolean> {
  const storeRoot = path.join(projectRoot, ...storeRootRelative.split('/').filter(Boolean));
  const openSpecRoot = path.join(storeRoot, 'openspec');
  const hasConfig =
    (await exists(path.join(openSpecRoot, 'config.yaml'))) ||
    (await exists(path.join(openSpecRoot, 'config.yml')));
  return (
    hasConfig &&
    (await exists(path.join(openSpecRoot, 'changes'))) &&
    (await exists(path.join(openSpecRoot, 'specs')))
  );
}

async function hasActiveChange(projectRoot: string, storeRootRelative: string): Promise<boolean> {
  const changesDir = path.join(
    projectRoot,
    ...storeRootRelative.split('/').filter(Boolean),
    'openspec',
    'changes',
  );
  if (!(await exists(changesDir))) return false;
  for (const entry of await fs.readdir(changesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'archive') continue;
    if (await exists(path.join(changesDir, entry.name, '.comet.yaml'))) return true;
  }
  return false;
}

async function configuredLayout(projectRoot: string): Promise<{
  layout?: CometArtifactLayoutKind;
  openspecRoot?: string;
  openspecStore?: string;
  superpowersRoot?: string;
}> {
  const config = await readYamlRecord(path.join(projectRoot, '.comet', 'config.yaml'));
  const rawLayout = config.artifact_layout;
  const layout = rawLayout === 'docs' || rawLayout === 'legacy' ? rawLayout : undefined;
  return {
    layout,
    openspecRoot: safeRelativePath(
      nestedString(config, 'openspec', 'root'),
      layout === 'docs' ? 'docs' : '.',
    ),
    openspecStore: nestedString(config, 'openspec', 'store'),
    superpowersRoot: safeRelativePath(
      nestedString(config, 'superpowers', 'root'),
      'docs/superpowers',
    ),
  };
}

function buildLayout(
  projectRoot: string,
  layout: CometArtifactLayoutKind,
  options: { openspecRoot?: string; openspecStore?: string; superpowersRoot?: string } = {},
): CometArtifactLayout {
  const openspecRoot = safeRelativePath(options.openspecRoot, layout === 'docs' ? 'docs' : '.');
  const storeRoot =
    openspecRoot === '.'
      ? projectRoot
      : path.join(projectRoot, ...openspecRoot.split('/').filter(Boolean));
  const artifactRoot = path.join(storeRoot, 'openspec');
  const superpowersRootRelative = safeRelativePath(options.superpowersRoot, 'docs/superpowers');
  const superpowersRoot = path.join(
    projectRoot,
    ...superpowersRootRelative.split('/').filter(Boolean),
  );

  return {
    projectRoot,
    layout,
    openSpec: {
      ...(options.openspecStore ? { storeId: options.openspecStore } : {}),
      storeRoot,
      artifactRoot,
      changesDir: path.join(artifactRoot, 'changes'),
      specsDir: path.join(artifactRoot, 'specs'),
      archiveDir: path.join(artifactRoot, 'changes', 'archive'),
      commandArgs: options.openspecStore ? ['--store', options.openspecStore] : [],
      commandCwd: options.openspecStore ? projectRoot : storeRoot,
    },
    superpowers: {
      root: superpowersRoot,
      specsDir: path.join(superpowersRoot, 'specs'),
      plansDir: path.join(superpowersRoot, 'plans'),
      reportsDir: path.join(superpowersRoot, 'reports'),
    },
  };
}

export async function resolveCometArtifactLayout(
  projectRootInput: string,
  options: ResolveCometArtifactLayoutOptions = {},
): Promise<CometArtifactLayout> {
  const projectRoot = path.resolve(projectRootInput);
  const configured = await configuredLayout(projectRoot);
  const explicit = options.explicitLayout ?? configured.layout;
  if (explicit) {
    return buildLayout(projectRoot, explicit, {
      openspecRoot: configured.openspecRoot,
      openspecStore: configured.openspecStore,
      superpowersRoot: configured.superpowersRoot,
    });
  }

  const docsHealthy = await isHealthyOpenSpecRoot(projectRoot, 'docs');
  const legacyHealthy = await isHealthyOpenSpecRoot(projectRoot, '.');
  if (docsHealthy && legacyHealthy) {
    const docsActive = await hasActiveChange(projectRoot, 'docs');
    const legacyActive = await hasActiveChange(projectRoot, '.');
    if (docsActive && legacyActive) {
      throw new Error(
        'Multiple artifact layouts contain active Comet changes. Configure artifact_layout or repair the project layout.',
      );
    }
    if (docsActive) {
      return buildLayout(projectRoot, 'docs', {
        superpowersRoot: configured.superpowersRoot,
      });
    }
    if (legacyActive) {
      return buildLayout(projectRoot, 'legacy', {
        superpowersRoot: configured.superpowersRoot,
      });
    }
    throw new Error(
      'Both docs and legacy OpenSpec roots exist. Pass --artifact-layout or configure .comet/config.yaml.',
    );
  }
  if (docsHealthy) {
    return buildLayout(projectRoot, 'docs', {
      superpowersRoot: configured.superpowersRoot,
    });
  }
  return buildLayout(projectRoot, 'legacy', {
    superpowersRoot: configured.superpowersRoot,
  });
}

export function projectRelativePath(projectRoot: string, absolutePath: string): string {
  return path.relative(path.resolve(projectRoot), path.resolve(absolutePath)).replaceAll('\\', '/');
}

async function resolveArchive(
  layout: CometArtifactLayout,
  name: string,
): Promise<ResolvedClassicChangeDirectory | null> {
  const exact = path.join(layout.openSpec.archiveDir, name);
  if (await exists(path.join(exact, '.comet.yaml'))) {
    return {
      label: projectRelativePath(layout.projectRoot, exact),
      directory: exact,
      layout: layout.layout,
    };
  }
  if (!(await exists(layout.openSpec.archiveDir))) return null;
  const matches: string[] = [];
  for (const entry of await fs.readdir(layout.openSpec.archiveDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(`-${name}`)) continue;
    const candidate = path.join(layout.openSpec.archiveDir, entry.name);
    if (await exists(path.join(candidate, '.comet.yaml'))) matches.push(candidate);
  }
  const latest = matches.sort((left, right) => right.localeCompare(left))[0];
  return latest
    ? {
        label: projectRelativePath(layout.projectRoot, latest),
        directory: latest,
        layout: layout.layout,
      }
    : null;
}

export async function resolveCometChangeDirectory(
  projectRoot: string,
  name: string,
  options: ResolveCometChangeDirectoryOptions = {},
): Promise<ResolvedClassicChangeDirectory> {
  assertOpenSpecChangeName(name);
  const layout = await resolveCometArtifactLayout(projectRoot, options);
  const active = path.join(layout.openSpec.changesDir, name);
  if (await exists(active)) {
    return {
      label: projectRelativePath(layout.projectRoot, active),
      directory: active,
      layout: layout.layout,
    };
  }
  const archived = await resolveArchive(layout, name);
  if (archived) return archived;
  return {
    label: projectRelativePath(layout.projectRoot, active),
    directory: active,
    layout: layout.layout,
  };
}
