import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveCometArtifactLayout,
  resolveCometChangeDirectory,
} from '../../../domains/comet-classic/classic-artifact-layout.js';

const roots: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'comet-layout-'));
  roots.push(dir);
  return dir;
}

async function healthyOpenSpecRoot(root: string, relativeRoot: string): Promise<void> {
  const base = path.join(root, relativeRoot, 'openspec');
  await mkdir(path.join(base, 'changes', 'archive'), { recursive: true });
  await mkdir(path.join(base, 'specs'), { recursive: true });
  await writeFile(path.join(base, 'config.yaml'), 'schema: spec-driven\n', 'utf8');
}

afterEach(async () => {
  const { rm } = await import('fs/promises');
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resolveCometArtifactLayout', () => {
  it('defaults to legacy when no layout signal exists', async () => {
    const root = await tempProject();
    await expect(resolveCometArtifactLayout(root)).resolves.toMatchObject({
      layout: 'legacy',
      openSpec: {
        storeRoot: root,
        artifactRoot: path.join(root, 'openspec'),
        changesDir: path.join(root, 'openspec', 'changes'),
      },
    });
  });

  it('uses .comet/config.yaml artifact_layout when present', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, '.comet'), { recursive: true });
    await writeFile(
      path.join(root, '.comet', 'config.yaml'),
      'artifact_layout: docs\nopenspec:\n  root: docs\n  store: comet-demo-1234\n',
      'utf8',
    );
    await expect(resolveCometArtifactLayout(root)).resolves.toMatchObject({
      layout: 'docs',
      openSpec: {
        storeId: 'comet-demo-1234',
        storeRoot: path.join(root, 'docs'),
        artifactRoot: path.join(root, 'docs', 'openspec'),
        changesDir: path.join(root, 'docs', 'openspec', 'changes'),
        commandArgs: ['--store', 'comet-demo-1234'],
      },
    });
  });

  it('detects docs layout from healthy docs/openspec when local config is absent', async () => {
    const root = await tempProject();
    await healthyOpenSpecRoot(root, 'docs');
    await expect(resolveCometArtifactLayout(root)).resolves.toMatchObject({
      layout: 'docs',
      openSpec: {
        commandCwd: path.join(root, 'docs'),
        commandArgs: [],
      },
    });
  });

  it('fails closed when docs and legacy both have active changes without config', async () => {
    const root = await tempProject();
    await healthyOpenSpecRoot(root, '.');
    await healthyOpenSpecRoot(root, 'docs');
    await mkdir(path.join(root, 'openspec', 'changes', 'legacy-active'), { recursive: true });
    await writeFile(
      path.join(root, 'openspec', 'changes', 'legacy-active', '.comet.yaml'),
      'phase: open\n',
      'utf8',
    );
    await mkdir(path.join(root, 'docs', 'openspec', 'changes', 'docs-active'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, 'docs', 'openspec', 'changes', 'docs-active', '.comet.yaml'),
      'phase: open\n',
      'utf8',
    );

    await expect(resolveCometArtifactLayout(root)).rejects.toThrow(/multiple artifact layouts/i);
  });

  it('resolves active and archive change directories in docs layout', async () => {
    const root = await tempProject();
    await healthyOpenSpecRoot(root, 'docs');
    await mkdir(path.join(root, 'docs', 'openspec', 'changes', 'add-auth'), { recursive: true });
    await writeFile(
      path.join(root, 'docs', 'openspec', 'changes', 'add-auth', '.comet.yaml'),
      'phase: open\n',
      'utf8',
    );

    await expect(resolveCometChangeDirectory(root, 'add-auth')).resolves.toMatchObject({
      label: 'docs/openspec/changes/add-auth',
      directory: path.join(root, 'docs', 'openspec', 'changes', 'add-auth'),
      layout: 'docs',
    });
  });

  it('rejects invalid change names before resolving artifact directories', async () => {
    const root = await tempProject();
    await healthyOpenSpecRoot(root, 'docs');
    await mkdir(path.join(root, 'docs', 'openspec', 'changes', 'archive', '2026-07-10-add-auth'), {
      recursive: true,
    });
    await writeFile(
      path.join(
        root,
        'docs',
        'openspec',
        'changes',
        'archive',
        '2026-07-10-add-auth',
        '.comet.yaml',
      ),
      'phase: archived\n',
      'utf8',
    );

    await expect(resolveCometChangeDirectory(root, '2026-07-10-add-auth')).rejects.toThrow(
      /Invalid change name/u,
    );
  });
});
