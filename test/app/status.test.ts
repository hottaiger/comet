import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { statusCommand } from '../../app/commands/status.js';

const stateScript = path.resolve('assets', 'skills', 'comet', 'scripts', 'comet-state.mjs');

function state(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [stateScript, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, COMET_FORCE_PHASE: '1' },
  });
}

describe('status command', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `comet-status-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('prints the next command for active changes', async () => {
    const changeDir = path.join(tmpDir, 'openspec', 'changes', 'next-build');
    state(tmpDir, 'init', 'next-build', 'full');
    state(tmpDir, 'set', 'next-build', 'phase', 'build');
    state(tmpDir, 'set', 'next-build', 'build_mode', 'executing-plans');
    state(tmpDir, 'set', 'next-build', 'tdd_mode', 'tdd');
    state(tmpDir, 'set', 'next-build', 'isolation', 'branch');
    state(tmpDir, 'set', 'next-build', 'verify_mode', 'light');
    state(tmpDir, 'set', 'next-build', 'design_doc', 'docs/superpowers/specs/next-build.md');
    state(tmpDir, 'set', 'next-build', 'plan', 'docs/superpowers/plans/next-build.md');
    await fs.writeFile(path.join(changeDir, 'tasks.md'), '- [x] done\n- [ ] todo\n');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let output = '';
    try {
      await statusCommand(tmpDir);
      output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    expect(output).toContain('next: /comet-build');
    expect(output).toContain('[1/2 tasks]');
    expect(output).toContain('run_step: full.build.plan');
  });

  it('finds active changes in the configured docs OpenSpec root', async () => {
    await fs.mkdir(path.join(tmpDir, '.comet'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.comet', 'config.yaml'),
      ['artifact_layout: docs', 'openspec:', '  root: docs', ''].join('\n'),
    );
    const changeDir = path.join(tmpDir, 'docs', 'openspec', 'changes', 'docs-change');
    state(tmpDir, 'init', 'docs-change', 'full');
    await fs.writeFile(path.join(changeDir, 'proposal.md'), '# Proposal\n');
    await fs.writeFile(path.join(changeDir, 'tasks.md'), '- [ ] build\n');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let json = '';
    try {
      await statusCommand(tmpDir, { json: true });
      json = log.mock.calls.map((call) => call.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    expect(JSON.parse(json).changes).toEqual([expect.objectContaining({ name: 'docs-change' })]);
  });

  it('silently migrates legacy state and includes the Run step in JSON output', async () => {
    const changeDir = path.join(tmpDir, 'openspec', 'changes', 'next-verify');
    state(tmpDir, 'init', 'next-verify', 'full');
    state(tmpDir, 'set', 'next-verify', 'phase', 'verify');
    const before = await fs.readFile(path.join(changeDir, '.comet.yaml'), 'utf8');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let json = '';
    try {
      await statusCommand(tmpDir, { json: true });
      json = log.mock.calls.map((call) => call.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    const change = JSON.parse(json).changes[0];
    expect(change.nextCommand).toBe('/comet-verify');
    expect(change.currentStep).toBe('full.verify.run');
    expect(await fs.readFile(path.join(changeDir, '.comet.yaml'), 'utf8')).not.toBe(before);
  });

  it('reports invalid state without modifying it', async () => {
    const changeDir = path.join(tmpDir, 'openspec', 'changes', 'invalid');
    state(tmpDir, 'init', 'invalid', 'full');
    await fs.appendFile(path.join(changeDir, '.comet.yaml'), 'unknown_root_field: true\n');
    const before = await fs.readFile(path.join(changeDir, '.comet.yaml'), 'utf8');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let json = '';
    try {
      await statusCommand(tmpDir, { json: true });
      json = log.mock.calls.map((call) => call.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    expect(JSON.parse(json).changes[0]).toMatchObject({
      name: 'invalid',
      phase: 'invalid',
      error: expect.stringContaining('unknown_root_field'),
    });
    expect(await fs.readFile(path.join(changeDir, '.comet.yaml'), 'utf8')).toBe(before);
  });

  it('keeps invalid errors visible and only prints the invalid recovery hint for invalid changes', async () => {
    const changeDir = path.join(tmpDir, 'openspec', 'changes', 'invalid');
    state(tmpDir, 'init', 'invalid', 'full');
    await fs.appendFile(path.join(changeDir, '.comet.yaml'), 'unknown_root_field: true\n');

    const runtimeEvalFailDir = path.join(tmpDir, 'openspec', 'changes', 'runtime-eval-fail');
    state(tmpDir, 'init', 'runtime-eval-fail', 'full');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let output = '';
    try {
      await statusCommand(tmpDir);
      output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    expect(output).toContain('error: Invalid Classic state: unknown field(s): unknown_root_field');
    expect(output).toContain('next: inspect .comet.yaml and rerun comet doctor');
    expect(output).toContain('runtime-eval-fail [phase: open]');
    expect(output.match(/next: inspect \.comet\.yaml and rerun comet doctor/g)).toHaveLength(1);
  });

  it('prints actionable runtime-eval recovery guidance for valid changes', async () => {
    const changeDir = path.join(tmpDir, 'openspec', 'changes', 'runtime-eval-fail');
    state(tmpDir, 'init', 'runtime-eval-fail', 'full');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let output = '';
    try {
      await statusCommand(tmpDir);
      output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    expect(output).toContain(
      'runtime_check: fail (full.open; missing: openspec.proposal, openspec.tasks)',
    );
    expect(output).toContain(
      'next: run /comet-open or restore missing evidence (openspec.proposal, openspec.tasks), then rerun comet doctor',
    );
  });

  it('reports Classic runtime mode from shared diagnostics', async () => {
    const changeDir = path.join(tmpDir, 'openspec', 'changes', 'demo');
    state(tmpDir, 'init', 'demo', 'full');
    await fs.writeFile(path.join(changeDir, 'proposal.md'), '# Proposal\n');
    await fs.writeFile(path.join(changeDir, 'design.md'), '# Design\n');
    await fs.writeFile(path.join(changeDir, 'tasks.md'), '- [ ] build\n');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let json = '';
    try {
      await statusCommand(tmpDir, { json: true });
      json = log.mock.calls.map((call) => call.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }
    const payload = JSON.parse(json);

    expect(payload.changes[0]).toMatchObject({
      name: 'demo',
      currentStep: 'full.open',
      runtimeMode: 'engine-projection',
    });
  });
});
