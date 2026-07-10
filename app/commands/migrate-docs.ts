import { promises as fs } from 'fs';
import path from 'path';
import { resolveCometArtifactLayout } from '../../domains/comet-classic/classic-artifact-layout.js';

interface MigrateDocsOptions {
  dryRun?: boolean;
  apply?: boolean;
  repairStore?: boolean;
  includeActive?: boolean;
  openSpecStore?: string;
  log?: (line: string) => void;
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

async function activeChanges(changesRoot: string): Promise<string[]> {
  if (!(await exists(changesRoot))) return [];
  const out: string[] = [];
  for (const entry of await fs.readdir(changesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'archive') continue;
    if (await exists(path.join(changesRoot, entry.name, '.comet.yaml'))) out.push(entry.name);
  }
  return out.sort();
}

export async function migrateDocsCommand(
  targetPath: string,
  options: MigrateDocsOptions = {},
): Promise<void> {
  const projectRoot = path.resolve(targetPath);
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const layout = await resolveCometArtifactLayout(projectRoot).catch(() => null);
  const legacyRoot = path.join(projectRoot, 'openspec');
  const docsRoot = path.join(projectRoot, 'docs', 'openspec');
  const active = await activeChanges(path.join(legacyRoot, 'changes'));

  if (active.length > 0 && !options.includeActive) {
    throw new Error(
      `Active changes exist: ${active.join(', ')}. Re-run with --include-active after review.`,
    );
  }

  log(`Current layout: ${layout?.layout ?? 'unknown'}`);
  log('Target layout: docs');
  log(`Legacy OpenSpec root: ${(await exists(legacyRoot)) ? 'present' : 'missing'}`);
  log(`Docs OpenSpec root: ${(await exists(docsRoot)) ? 'present' : 'missing'}`);
  log(`Active changes: ${active.length}`);
  if (await exists(legacyRoot)) log('Would move: openspec -> docs/openspec');
  if (options.repairStore) {
    if (options.openSpecStore) {
      log(
        `Would repair OpenSpec store root: ${path.join(projectRoot, 'docs')} (store: ${options.openSpecStore})`,
      );
    } else {
      log(`Would repair OpenSpec store root: ${path.join(projectRoot, 'docs')}`);
    }
  }
  if (!options.apply) log('No files were changed. Re-run with --apply to execute.');
}

export type { MigrateDocsOptions };
