import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  getLegacyOpenSpecMigrationCommand,
  inspectLegacyOpenSpecMigration,
} from '../../app/commands/legacy-openspec-migration-prompt.js';

async function createLegacyOpenSpecRoot(projectPath: string, change?: string): Promise<void> {
  const root = path.join(projectPath, 'openspec');
  await fs.mkdir(path.join(root, 'changes', 'archive'), { recursive: true });
  await fs.mkdir(path.join(root, 'specs'), { recursive: true });
  await fs.writeFile(path.join(root, 'config.yaml'), 'schema: spec-driven\n', 'utf8');
  if (change) await fs.mkdir(path.join(root, 'changes', change), { recursive: true });
}

describe('legacy OpenSpec migration prompt', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `comet-legacy-openspec-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reports no migration when the legacy root is absent', async () => {
    await expect(inspectLegacyOpenSpecMigration(tmpDir)).resolves.toEqual({
      present: false,
      hasActiveChanges: false,
      command: 'comet migrate docs --apply',
    });
  });

  it('treats a legacy root file as absent', async () => {
    await fs.writeFile(path.join(tmpDir, 'openspec'), 'not a directory\n', 'utf8');

    await expect(inspectLegacyOpenSpecMigration(tmpDir)).resolves.toEqual({
      present: false,
      hasActiveChanges: false,
      command: 'comet migrate docs --apply',
    });
  });

  it('treats an empty legacy root directory as absent', async () => {
    await fs.mkdir(path.join(tmpDir, 'openspec'));

    await expect(inspectLegacyOpenSpecMigration(tmpDir)).resolves.toEqual({
      present: false,
      hasActiveChanges: false,
      command: 'comet migrate docs --apply',
    });
  });

  it('treats a symbolic link legacy root as absent', async () => {
    const linkedRoot = path.join(tmpDir, 'linked-openspec');
    await fs.mkdir(path.join(linkedRoot, 'changes', 'active-change'), { recursive: true });

    try {
      await fs.symlink(linkedRoot, path.join(tmpDir, 'openspec'), 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;

      vi.spyOn(fs, 'lstat').mockResolvedValue({
        isDirectory: () => false,
        isSymbolicLink: () => true,
      } as Awaited<ReturnType<typeof fs.lstat>>);
      vi.spyOn(fs, 'stat').mockResolvedValue({
        isDirectory: () => true,
      } as Awaited<ReturnType<typeof fs.stat>>);
    }

    await expect(inspectLegacyOpenSpecMigration(tmpDir)).resolves.toEqual({
      present: false,
      hasActiveChanges: false,
      command: 'comet migrate docs --apply',
    });
  });

  it('returns the normal apply command for an inactive legacy root', async () => {
    await createLegacyOpenSpecRoot(tmpDir);

    await expect(inspectLegacyOpenSpecMigration(tmpDir)).resolves.toMatchObject({
      present: true,
      hasActiveChanges: false,
      command: 'comet migrate docs --apply',
    });
  });

  it('accepts config.yml in a healthy legacy root', async () => {
    await createLegacyOpenSpecRoot(tmpDir);
    await fs.rename(
      path.join(tmpDir, 'openspec', 'config.yaml'),
      path.join(tmpDir, 'openspec', 'config.yml'),
    );

    await expect(inspectLegacyOpenSpecMigration(tmpDir)).resolves.toMatchObject({
      present: true,
      hasActiveChanges: false,
    });
  });

  it('treats a healthy-looking legacy root with a nested symbolic link as absent', async () => {
    await createLegacyOpenSpecRoot(tmpDir);
    const linkedDirectory = path.join(tmpDir, 'linked-spec');
    await fs.mkdir(linkedDirectory);
    await fs.symlink(
      linkedDirectory,
      path.join(tmpDir, 'openspec', 'specs', 'linked-spec'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(inspectLegacyOpenSpecMigration(tmpDir)).resolves.toEqual({
      present: false,
      hasActiveChanges: false,
      command: 'comet migrate docs --apply',
    });
  });

  it('generates the command without include-active for inactive changes', () => {
    expect(getLegacyOpenSpecMigrationCommand(false)).toBe('comet migrate docs --apply');
  });

  it('generates the command with include-active for active changes', () => {
    expect(getLegacyOpenSpecMigrationCommand(true)).toBe(
      'comet migrate docs --apply --include-active',
    );
  });

  it('adds include-active only when a non-archive change exists', async () => {
    await createLegacyOpenSpecRoot(tmpDir, 'active-change');

    await expect(inspectLegacyOpenSpecMigration(tmpDir)).resolves.toMatchObject({
      hasActiveChanges: true,
      command: 'comet migrate docs --apply --include-active',
    });
  });
});
