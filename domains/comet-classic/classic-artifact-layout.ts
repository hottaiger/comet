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

interface ChangeDirectoryLookup {
  active: ResolvedClassicChangeDirectory | null;
  archived: ResolvedClassicChangeDirectory | null;
  fallback: ResolvedClassicChangeDirectory;
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

function relativeRepositoryPath(
  value: string | undefined,
  fallback: string,
  field: string,
): string {
  if (!value) return fallback;
  if (/^(?:[A-Za-z]:|[\\/]|~)/u.test(value)) {
    throw new Error(`${field} must be a relative repository path: ${value}`);
  }
  if (value.split(/[\\/]/u).includes('..')) {
    throw new Error(`${field} must be a relative repository path: ${value}`);
  }
  return value.replaceAll('\\', '/').replace(/^\/+/u, '').replace(/\/+$/u, '') || fallback;
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
    openspecRoot: relativeRepositoryPath(
      nestedString(config, 'openspec', 'root'),
      layout === 'docs' ? 'docs' : '.',
      'openspec.root',
    ),
    openspecStore: nestedString(config, 'openspec', 'store'),
    superpowersRoot: relativeRepositoryPath(
      nestedString(config, 'superpowers', 'root'),
      'docs/superpowers',
      'superpowers.root',
    ),
  };
}

function buildLayout(
  projectRoot: string,
  layout: CometArtifactLayoutKind,
  options: { openspecRoot?: string; openspecStore?: string; superpowersRoot?: string } = {},
): CometArtifactLayout {
  const openspecRoot = relativeRepositoryPath(
    options.openspecRoot,
    layout === 'docs' ? 'docs' : '.',
    'openspec.root',
  );
  const storeRoot =
    openspecRoot === '.'
      ? projectRoot
      : path.join(projectRoot, ...openspecRoot.split('/').filter(Boolean));
  const artifactRoot = path.join(storeRoot, 'openspec');
  const superpowersRootRelative = relativeRepositoryPath(
    options.superpowersRoot,
    'docs/superpowers',
    'superpowers.root',
  );
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

function canonicalOpenSpecRoot(layout: CometArtifactLayoutKind): string {
  return layout === 'docs' ? 'docs' : '.';
}

function explicitLayoutOptions(
  layout: CometArtifactLayoutKind,
  configured: {
    openspecRoot?: string;
    openspecStore?: string;
    superpowersRoot?: string;
  },
): { openspecRoot: string; openspecStore?: string; superpowersRoot?: string } {
  const canonicalRoot = canonicalOpenSpecRoot(layout);
  const configuredRoot = relativeRepositoryPath(
    configured.openspecRoot,
    canonicalRoot,
    'openspec.root',
  );
  const rootIsCompatible = configuredRoot === canonicalRoot;
  return {
    openspecRoot: rootIsCompatible ? configuredRoot : canonicalRoot,
    openspecStore: layout === 'docs' && rootIsCompatible ? configured.openspecStore : undefined,
    superpowersRoot: configured.superpowersRoot,
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
    return buildLayout(projectRoot, explicit, explicitLayoutOptions(explicit, configured));
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

function buildCompatibilityLayout(
  projectRoot: string,
  layout: CometArtifactLayoutKind,
  configuredSuperpowersRoot?: string,
): CometArtifactLayout {
  return buildLayout(projectRoot, layout, {
    openspecRoot: canonicalOpenSpecRoot(layout),
    superpowersRoot: configuredSuperpowersRoot,
  });
}

function orderLayouts(
  layouts: readonly CometArtifactLayout[],
  preferredLayout?: CometArtifactLayoutKind,
): CometArtifactLayout[] {
  if (!preferredLayout) return [...layouts];
  return [...layouts].sort((left, right) => {
    if (left.layout === right.layout) return 0;
    if (left.layout === preferredLayout) return -1;
    if (right.layout === preferredLayout) return 1;
    return 0;
  });
}

async function lookupChangeDirectoryInLayout(
  layout: CometArtifactLayout,
  name: string,
): Promise<ChangeDirectoryLookup> {
  const active = path.join(layout.openSpec.changesDir, name);
  const activeMatch = (await exists(active))
    ? {
        label: projectRelativePath(layout.projectRoot, active),
        directory: active,
        layout: layout.layout,
      }
    : null;
  const archivedMatch = activeMatch ? null : await resolveArchive(layout, name);
  return {
    active: activeMatch,
    archived: archivedMatch,
    fallback: {
      label: projectRelativePath(layout.projectRoot, active),
      directory: active,
      layout: layout.layout,
    },
  };
}

function sameActiveChangeConflictError(
  name: string,
  matches: readonly ResolvedClassicChangeDirectory[],
): Error {
  const labels = matches.map((match) => match.label).join(', ');
  return new Error(
    `Same active change "${name}" exists in multiple artifact layouts: ${labels}. Configure artifact_layout or repair the project layout.`,
  );
}

async function resolveDefaultCometChangeDirectory(
  projectRootInput: string,
  name: string,
): Promise<ResolvedClassicChangeDirectory> {
  const projectRoot = path.resolve(projectRootInput);
  const configured = await configuredLayout(projectRoot);
  const candidateLayouts = orderLayouts(
    [
      buildCompatibilityLayout(projectRoot, 'legacy', configured.superpowersRoot),
      buildCompatibilityLayout(projectRoot, 'docs', configured.superpowersRoot),
    ],
    configured.layout,
  );

  let preferredLayout: CometArtifactLayout | null = null;
  let preferredLayoutError: Error | null = null;
  try {
    preferredLayout = await resolveCometArtifactLayout(projectRoot);
  } catch (error) {
    preferredLayoutError = error as Error;
  }

  const lookups = await Promise.all(
    orderLayouts(candidateLayouts, preferredLayout?.layout).map((layout) =>
      lookupChangeDirectoryInLayout(layout, name),
    ),
  );

  const activeMatches = lookups.flatMap((lookup) => (lookup.active ? [lookup.active] : []));
  if (activeMatches.length > 1) {
    throw sameActiveChangeConflictError(name, activeMatches);
  }
  if (activeMatches.length === 1) {
    return activeMatches[0];
  }

  const archivedMatches = lookups.flatMap((lookup) => (lookup.archived ? [lookup.archived] : []));
  if (archivedMatches.length > 0) {
    return archivedMatches[0];
  }

  if (preferredLayout) {
    return (
      lookups.find((lookup) => lookup.fallback.layout === preferredLayout.layout)?.fallback ??
      lookups[0].fallback
    );
  }

  if (preferredLayoutError) {
    throw preferredLayoutError;
  }

  return lookups[0].fallback;
}

export async function resolveCometChangeDirectory(
  projectRoot: string,
  name: string,
  options: ResolveCometChangeDirectoryOptions = {},
): Promise<ResolvedClassicChangeDirectory> {
  assertOpenSpecChangeName(name);
  if (options.explicitLayout) {
    const layout = await resolveCometArtifactLayout(projectRoot, options);
    const lookup = await lookupChangeDirectoryInLayout(layout, name);
    return lookup.active ?? lookup.archived ?? lookup.fallback;
  }
  return resolveDefaultCometChangeDirectory(projectRoot, name);
}
