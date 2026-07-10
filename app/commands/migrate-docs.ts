import { promises as fs } from 'fs';
import path from 'path';
import { resolveCometArtifactLayout } from '../../domains/comet-classic/classic-artifact-layout.js';
import {
  buildOpenSpecStoreRegisterInvocation,
  buildOpenSpecStoreSetupInvocation,
} from '../../domains/integrations/openspec.js';

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

function formatInvocation(invocation: { command: string; args: string[] }): string {
  return `${invocation.command} ${invocation.args.join(' ')}`;
}

export async function migrateDocsCommand(
  targetPath: string,
  options: MigrateDocsOptions = {},
): Promise<void> {
  const projectRoot = path.resolve(targetPath);
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const legacyRoot = path.join(projectRoot, 'openspec');
  const docsRoot = path.join(projectRoot, 'docs', 'openspec');
  const legacyActive = await activeChanges(path.join(legacyRoot, 'changes'));
  const docsActive = await activeChanges(path.join(docsRoot, 'changes'));
  const legacyRootExists = await exists(legacyRoot);
  const docsRootExists = await exists(docsRoot);

  if (options.apply) {
    throw new Error(
      'comet migrate docs is dry-run only in Task 4. --apply is not implemented yet.',
    );
  }

  const active = [
    ...legacyActive.map((name) => `openspec/changes/${name}`),
    ...docsActive.map((name) => `docs/openspec/changes/${name}`),
  ];
  if (active.length > 0 && !options.includeActive) {
    throw new Error(
      `Active changes exist: ${active.join(', ')}. Re-run with --include-active after review.`,
    );
  }

  const layout = await resolveCometArtifactLayout(projectRoot);

  if (docsRootExists) {
    throw new Error(
      'Target docs OpenSpec root already exists. Remove or repair docs/openspec before previewing migration.',
    );
  }

  log(`Current layout: ${layout?.layout ?? 'unknown'}`);
  log('Target layout: docs');
  log(`Legacy OpenSpec root: ${legacyRootExists ? 'present' : 'missing'}`);
  log(`Docs OpenSpec root: ${docsRootExists ? 'present' : 'missing'}`);
  log(`Active changes: ${active.length}`);
  if (legacyRootExists) log('Would move: openspec -> docs/openspec');
  if (options.repairStore) {
    if (options.openSpecStore) {
      log(
        `Would run: ${formatInvocation(
          buildOpenSpecStoreSetupInvocation(projectRoot, options.openSpecStore),
        )}`,
      );
      log(
        `Would run: ${formatInvocation(
          buildOpenSpecStoreRegisterInvocation(projectRoot, options.openSpecStore),
        )}`,
      );
    } else {
      log('Would repair OpenSpec store metadata after --openspec-store <id> is provided.');
    }
  }
  log('No files were changed. This preview does not perform migration moves in Task 4.');
}

export type { MigrateDocsOptions };
