import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '{"ok":true}\n', stderr: '' })),
  execFileSync: vi.fn(() => Buffer.from(JSON.stringify({ stores: [] }))),
}));

import { execFileSync, spawnSync } from 'child_process';
import { openspecCommand } from '../../app/commands/openspec.js';
import { quoteArgsForShell } from '../../platform/process/shell-quote.js';

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
  vi.mocked(execFileSync).mockReturnValue(Buffer.from(JSON.stringify({ stores: [] })));
});

afterEach(async () => {
  const { rm } = await import('fs/promises');
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  process.exitCode = originalExitCode;
  stdoutWrite.mockRestore();
  stderrWrite.mockRestore();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
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
    vi.mocked(execFileSync).mockReturnValue(
      Buffer.from(
        JSON.stringify({ stores: [{ id: 'comet-demo-1234', root: path.join(root, 'docs') }] }),
      ),
    );

    await openspecCommand(root, ['status', '--change', 'add-auth', '--json'], { json: true });

    expect(spawnSync).toHaveBeenCalledWith(
      'openspec',
      ['status', '--change', 'add-auth', '--json', '--store', 'comet-demo-1234'],
      expect.objectContaining({ cwd: root, encoding: 'utf8' }),
    );
  });

  it('rejects a configured store whose registered root is not this project docs directory', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, '.comet'), { recursive: true });
    await writeFile(
      path.join(root, '.comet', 'config.yaml'),
      'artifact_layout: docs\nopenspec:\n  root: docs\n  store: comet-demo-1234\n',
      'utf8',
    );
    vi.mocked(execFileSync).mockReturnValue(
      Buffer.from(
        JSON.stringify({
          stores: [{ id: 'comet-demo-1234', root: path.join(root, 'other-docs') }],
        }),
      ),
    );

    await expect(openspecCommand(root, ['status'], {})).rejects.toThrow(
      /does not match this project's docs directory/,
    );
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('forwards store management commands without validating or selecting the configured store', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, '.comet'), { recursive: true });
    await writeFile(
      path.join(root, '.comet', 'config.yaml'),
      'artifact_layout: docs\nopenspec:\n  root: docs\n  store: comet-demo-1234\n',
      'utf8',
    );
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('configured store is unavailable');
    });

    await expect(
      openspecCommand(root, ['store', 'list', '--json'], { json: true }),
    ).resolves.toBeUndefined();

    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawnSync).toHaveBeenCalledWith(
      'openspec',
      ['store', 'list', '--json'],
      expect.objectContaining({ cwd: root, encoding: 'utf8' }),
    );
  });

  it('recognizes store management commands after global OpenSpec flags', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, '.comet'), { recursive: true });
    await writeFile(
      path.join(root, '.comet', 'config.yaml'),
      'artifact_layout: docs\nopenspec:\n  root: docs\n  store: comet-demo-1234\n',
      'utf8',
    );
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('configured store is unavailable');
    });

    await expect(
      openspecCommand(root, ['--no-color', 'store', 'list', '--json'], { json: true }),
    ).resolves.toBeUndefined();

    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawnSync).toHaveBeenCalledWith(
      'openspec',
      ['--no-color', 'store', 'list', '--json'],
      expect.objectContaining({ cwd: root, encoding: 'utf8' }),
    );
  });

  it('uses COMET_OPENSPEC for both registry validation and the forwarded command', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, '.comet'), { recursive: true });
    await writeFile(
      path.join(root, '.comet', 'config.yaml'),
      'artifact_layout: docs\nopenspec:\n  root: docs\n  store: comet-demo-1234\n',
      'utf8',
    );
    vi.stubEnv('COMET_OPENSPEC', 'custom-openspec');
    vi.mocked(execFileSync).mockReturnValue(
      Buffer.from(
        JSON.stringify({ stores: [{ id: 'comet-demo-1234', root: path.join(root, 'docs') }] }),
      ),
    );

    await openspecCommand(root, ['status'], {});

    expect(execFileSync).toHaveBeenCalledWith(
      'custom-openspec',
      ['store', 'list', '--json'],
      expect.objectContaining({ cwd: root }),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      'custom-openspec',
      ['status', '--store', 'comet-demo-1234'],
      expect.objectContaining({ cwd: root }),
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

  it('does not append --store to OpenSpec commands that do not support it', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, '.comet'), { recursive: true });
    await writeFile(
      path.join(root, '.comet', 'config.yaml'),
      'artifact_layout: docs\nopenspec:\n  root: docs\n  store: comet-demo-1234\n',
      'utf8',
    );
    vi.mocked(execFileSync).mockReturnValue(
      Buffer.from(
        JSON.stringify({ stores: [{ id: 'comet-demo-1234', root: path.join(root, 'docs') }] }),
      ),
    );

    await openspecCommand(root, ['update'], {});

    expect(spawnSync).toHaveBeenCalledWith(
      'openspec',
      ['update'],
      expect.objectContaining({ cwd: path.join(root, 'docs'), encoding: 'utf8' }),
    );
  });

  it('quotes spaced args on Windows when using shell execution', async () => {
    const root = await tempProject();
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    try {
      await openspecCommand(root, ['status', '--change', 'add auth'], {});
    } finally {
      platformSpy.mockRestore();
    }

    expect(spawnSync).toHaveBeenCalledWith(
      'openspec',
      quoteArgsForShell(['status', '--change', 'add auth']),
      expect.objectContaining({
        cwd: root,
        encoding: 'utf8',
        shell: true,
      }),
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
