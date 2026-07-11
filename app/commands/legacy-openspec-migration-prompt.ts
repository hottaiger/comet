import { promises as fs } from 'fs';
import path from 'path';
import { isHealthyOpenSpecRoot } from './migrate-docs.js';

export interface LegacyOpenSpecMigrationInspection {
  present: boolean;
  hasActiveChanges: boolean;
  command: string;
}

export function getLegacyOpenSpecMigrationCommand(hasActiveChanges: boolean): string {
  return hasActiveChanges
    ? 'comet migrate docs --apply --include-active'
    : 'comet migrate docs --apply';
}

async function hasActiveLegacyOpenSpecChanges(projectPath: string): Promise<boolean> {
  const changesPath = path.join(projectPath, 'openspec', 'changes');

  try {
    const entries = await fs.readdir(changesPath, { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory() && entry.name !== 'archive');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function inspectLegacyOpenSpecMigration(
  projectPath: string,
): Promise<LegacyOpenSpecMigrationInspection> {
  const present = await isHealthyOpenSpecRoot(path.join(projectPath, 'openspec'));
  const hasActiveChanges = present && (await hasActiveLegacyOpenSpecChanges(projectPath));

  return {
    present,
    hasActiveChanges,
    command: getLegacyOpenSpecMigrationCommand(hasActiveChanges),
  };
}
