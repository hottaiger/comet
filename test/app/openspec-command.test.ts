import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '{"ok":true}\n', stderr: '' })),
}));

import { spawnSync } from 'child_process';
import { openspecCommand } from '../../app/commands/openspec.js';

const roots: string[] = [];
let stdoutWrite: ReturnType<typeof vi.spyOn>;
let stderrWrite: ReturnType<typeof vi.spyOn>;
let originalExitCode: number | undefined;

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'comet-openspec-command-'));
  roots.push(dir);
  return dir;
}

beforeEach(() => {
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(async () => {
  const { rm } = await import('fs/promises');
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  process.exitCode = originalExitCode;
  stdoutWrite.mockRestore();
  stderrWrite.mockRestore();
  vi.clearAllMocks();
});

describe('openspecCommand', () => {
  it('passes --store from docs layout config', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, '.comet'), { recursive: true });
    await writeFile(
      path.join(root, '.comet', 'config.yaml'),
      'artifact_layout: docs\nopenspec:\n  root: docs\n  store: comet-demo-1234\n',
      'utf8',
    );

    await openspecCommand(root, ['status', '--change', 'add-auth', '--json'], { json: true });

    expect(spawnSync).toHaveBeenCalledWith(
      'openspec',
      ['status', '--change', 'add-auth', '--json', '--store', 'comet-demo-1234'],
      expect.objectContaining({ cwd: root, encoding: 'utf8' }),
    );
  });

  it('uses docs cwd when docs layout has no store id', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, 'docs', 'openspec', 'changes', 'archive'), { recursive: true });
    await mkdir(path.join(root, 'docs', 'openspec', 'specs'), { recursive: true });
    await writeFile(
      path.join(root, 'docs', 'openspec', 'config.yaml'),
      'schema: spec-driven\n',
      'utf8',
    );

    await openspecCommand(root, ['list'], {});

    expect(spawnSync).toHaveBeenCalledWith(
      'openspec',
      ['list'],
      expect.objectContaining({ cwd: path.join(root, 'docs'), encoding: 'utf8' }),
    );
  });

  it('sets process.exitCode for nonzero status and forwards stdout/stderr', async () => {
    const root = await tempProject();
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 7,
      stdout: 'partial stdout\n',
      stderr: 'partial stderr\n',
      pid: 123,
      output: [],
      signal: null,
    });

    await openspecCommand(root, ['status'], {});

    expect(process.exitCode).toBe(7);
    expect(stdoutWrite).toHaveBeenCalledWith('partial stdout\n');
    expect(stderrWrite).toHaveBeenCalledWith('partial stderr\n');
  });

  it('throws spawnSync errors', async () => {
    const root = await tempProject();
    const failure = new Error('spawn failed');
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: null,
      stdout: '',
      stderr: '',
      error: failure,
      pid: 123,
      output: [],
      signal: null,
    });

    await expect(openspecCommand(root, ['status'], {})).rejects.toThrow('spawn failed');
  });
});
