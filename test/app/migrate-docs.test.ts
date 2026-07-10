import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDocsCommand } from '../../app/commands/migrate-docs.js';

const roots: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'comet-migrate-docs-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import('fs/promises');
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('migrateDocsCommand', () => {
  it('prints dry-run plan for legacy OpenSpec root', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, 'openspec', 'changes', 'archive'), { recursive: true });
    await mkdir(path.join(root, 'openspec', 'specs'), { recursive: true });
    await writeFile(path.join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n', 'utf8');
    const output: string[] = [];

    await migrateDocsCommand(root, { dryRun: true, log: (line) => output.push(line) });

    expect(output.join('\n')).toContain('Current layout: legacy');
    expect(output.join('\n')).toContain('Target layout: docs');
    expect(output.join('\n')).toContain('Would move: openspec -> docs/openspec');
  });

  it('blocks active changes unless includeActive is true', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, 'openspec', 'changes', 'active-change'), { recursive: true });
    await writeFile(
      path.join(root, 'openspec', 'changes', 'active-change', '.comet.yaml'),
      'phase: build\n',
      'utf8',
    );

    await expect(migrateDocsCommand(root, { dryRun: true })).rejects.toThrow(/active changes/i);
  });
});
