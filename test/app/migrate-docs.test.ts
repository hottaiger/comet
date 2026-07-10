import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDocsCommand } from '../../app/commands/migrate-docs.js';
import {
  buildOpenSpecStoreRegisterInvocation,
  buildOpenSpecStoreSetupInvocation,
} from '../../domains/integrations/openspec.js';

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

  it('blocks active changes under the docs OpenSpec root unless includeActive is true', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, 'openspec', 'changes', 'archive'), { recursive: true });
    await mkdir(path.join(root, 'openspec', 'specs'), { recursive: true });
    await writeFile(path.join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n', 'utf8');
    await mkdir(path.join(root, 'docs', 'openspec', 'changes', 'review-change'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, 'docs', 'openspec', 'changes', 'review-change', '.comet.yaml'),
      'phase: build\n',
      'utf8',
    );

    await expect(migrateDocsCommand(root, { dryRun: true })).rejects.toThrow(/active changes/i);
  });

  it('fails closed when mixed legacy and docs layouts conflict', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, 'openspec', 'changes', 'archive'), { recursive: true });
    await mkdir(path.join(root, 'openspec', 'specs'), { recursive: true });
    await writeFile(path.join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n', 'utf8');
    await mkdir(path.join(root, 'docs', 'openspec', 'changes', 'archive'), { recursive: true });
    await mkdir(path.join(root, 'docs', 'openspec', 'specs'), { recursive: true });
    await writeFile(
      path.join(root, 'docs', 'openspec', 'config.yaml'),
      'schema: spec-driven\n',
      'utf8',
    );

    await expect(migrateDocsCommand(root, { dryRun: true })).rejects.toThrow(
      /docs and legacy OpenSpec roots exist|multiple artifact layouts/i,
    );
  });

  it('rejects an existing docs OpenSpec target without printing a move plan', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, 'openspec', 'changes', 'archive'), { recursive: true });
    await mkdir(path.join(root, 'openspec', 'specs'), { recursive: true });
    await writeFile(path.join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n', 'utf8');
    await mkdir(path.join(root, 'docs', 'openspec'), { recursive: true });
    const output: string[] = [];

    await expect(
      migrateDocsCommand(root, { dryRun: true, log: (line) => output.push(line) }),
    ).rejects.toThrow(/docs OpenSpec root already exists|target docs OpenSpec root/i);
    expect(output.join('\n')).not.toContain('Would move: openspec -> docs/openspec');
  });

  it('rejects apply mode because migrate docs is dry-run only in Task 4', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, 'openspec', 'changes', 'archive'), { recursive: true });
    await mkdir(path.join(root, 'openspec', 'specs'), { recursive: true });
    await writeFile(path.join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n', 'utf8');

    await expect(migrateDocsCommand(root, { apply: true })).rejects.toThrow(
      /dry-run only|not implemented/i,
    );
  });

  it('prints concrete openspec store setup and register commands for repair preview', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, 'openspec', 'changes', 'archive'), { recursive: true });
    await mkdir(path.join(root, 'openspec', 'specs'), { recursive: true });
    await writeFile(path.join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n', 'utf8');
    const output: string[] = [];
    const expectedSetup = buildOpenSpecStoreSetupInvocation(root, 'comet-demo-1234');
    const expectedRegister = buildOpenSpecStoreRegisterInvocation(root, 'comet-demo-1234');

    await migrateDocsCommand(root, {
      dryRun: true,
      repairStore: true,
      openSpecStore: 'comet-demo-1234',
      log: (line) => output.push(line),
    });

    expect(output.join('\n')).toContain(
      `Would run: ${expectedSetup.command} ${expectedSetup.args.join(' ')}`,
    );
    expect(output.join('\n')).toContain(
      `Would run: ${expectedRegister.command} ${expectedRegister.args.join(' ')}`,
    );
  });
});
