import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureCliBuilt } from '../helpers/ensure-cli-built.js';

const repositoryRoot = path.resolve('.');
const cli = path.join(repositoryRoot, 'bin', 'comet.js');

async function writeFakeOpenSpec(binDir: string): Promise<void> {
  const captureScript = path.join(binDir, 'capture-openspec.mjs');
  await fs.writeFile(
    captureScript,
    [
      "import { writeFileSync } from 'fs';",
      'writeFileSync(process.env.COMET_CAPTURE_FILE, JSON.stringify({',
      '  argv: process.argv.slice(2),',
      '  cwd: process.cwd(),',
      '}, null, 2));',
      "if (process.argv.slice(2).join(' ') === 'store list --json') {",
      "  process.stdout.write(JSON.stringify({ stores: [{ id: 'comet-demo-1234', root: process.cwd() + '/docs' }] }));",
      '} else {',
      "  process.stdout.write('fake openspec stdout\\n');",
      '}',
      "process.stderr.write('fake openspec stderr\\n');",
    ].join('\n'),
    'utf8',
  );

  if (process.platform === 'win32') {
    await fs.writeFile(
      path.join(binDir, 'openspec.cmd'),
      `@echo off\r\n"${process.execPath}" "${captureScript}" %*\r\n`,
      'utf8',
    );
    return;
  }

  const launcherPath = path.join(binDir, 'openspec');
  await fs.writeFile(
    launcherPath,
    `#!/bin/sh\nexec "${process.execPath}" "${captureScript}" "$@"\n`,
    'utf8',
  );
  await fs.chmod(launcherPath, 0o755);
}

describe('CLI openspec forwarding', () => {
  const tempRoots: string[] = [];

  beforeAll(async () => {
    await ensureCliBuilt(repositoryRoot);
  }, 120_000);

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it('forwards unknown OpenSpec options like --change instead of failing in Commander', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-openspec-cli-'));
    const binDir = path.join(root, 'bin');
    const captureFile = path.join(root, 'capture.json');
    tempRoots.push(root);
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeOpenSpec(binDir);

    const result = spawnSync(
      process.execPath,
      [cli, 'openspec', 'status', '--change', 'add-auth'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          COMET_CAPTURE_FILE: captureFile,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("unknown option '--change'");
    expect(JSON.parse(await fs.readFile(captureFile, 'utf8'))).toMatchObject({
      argv: ['status', '--change', 'add-auth'],
    });
  });

  it('forwards Commander-consumed --json to OpenSpec', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-openspec-cli-'));
    const binDir = path.join(root, 'bin');
    const captureFile = path.join(root, 'capture.json');
    const projectRoot = path.join(root, 'project');
    tempRoots.push(root);
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeOpenSpec(binDir);
    await fs.mkdir(path.join(projectRoot, '.comet'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.comet', 'config.yaml'),
      'artifact_layout: docs\nopenspec:\n  root: docs\n  store: comet-demo-1234\n',
      'utf8',
    );

    const result = spawnSync(
      process.execPath,
      [cli, 'openspec', '--project', projectRoot, '--json', 'status', '--change', 'add-auth'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          COMET_CAPTURE_FILE: captureFile,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('fake openspec stderr');
    expect(result.stderr).not.toContain('Using OpenSpec root:');
    expect(JSON.parse(await fs.readFile(captureFile, 'utf8'))).toMatchObject({
      argv: ['status', '--change', 'add-auth', '--json', '--store', 'comet-demo-1234'],
      cwd: projectRoot,
    });
  });

  it('does not duplicate explicit forwarded --json via -- separator', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-openspec-cli-'));
    const binDir = path.join(root, 'bin');
    const captureFile = path.join(root, 'capture.json');
    tempRoots.push(root);
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeOpenSpec(binDir);

    const result = spawnSync(
      process.execPath,
      [cli, 'openspec', '--json', 'status', '--change', 'add-auth', '--', '--json'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          COMET_CAPTURE_FILE: captureFile,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await fs.readFile(captureFile, 'utf8'))).toMatchObject({
      argv: ['status', '--change', 'add-auth', '--json'],
    });
  });
});
