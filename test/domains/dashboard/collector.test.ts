import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { collectDashboardSnapshot } from '../../../domains/dashboard/collector.js';

interface ChangeFixture {
  name: string;
  yaml?: Record<string, string>;
  tasks?: string;
  proposal?: boolean;
  design?: boolean;
  plan?: boolean;
  verifyReport?: string | null; // body or null to skip the file
  status?: 'active' | 'archived';
}

async function writeChange(root: string, fixture: ChangeFixture): Promise<void> {
  const status = fixture.status ?? 'active';
  const baseDir =
    status === 'archived'
      ? path.join(root, 'openspec', 'changes', 'archive', fixture.name)
      : path.join(root, 'openspec', 'changes', fixture.name);
  await fs.mkdir(baseDir, { recursive: true });

  if (fixture.yaml) {
    const lines = Object.entries(fixture.yaml).map(([k, v]) => `${k}: ${v}`);
    await fs.writeFile(path.join(baseDir, '.comet.yaml'), `${lines.join('\n')}\n`);
  }
  if (fixture.tasks !== undefined) {
    await fs.writeFile(path.join(baseDir, 'tasks.md'), fixture.tasks);
  }
  if (fixture.proposal) {
    await fs.writeFile(path.join(baseDir, 'proposal.md'), '# Proposal\n');
  }
  if (fixture.design) {
    await fs.writeFile(path.join(baseDir, 'design.md'), '# Design\n');
  }
  if (fixture.plan) {
    await fs.writeFile(path.join(baseDir, 'plan.md'), '# Plan\n');
  }
  if (fixture.verifyReport != null) {
    const reportDir = path.join(baseDir, '.comet');
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(path.join(reportDir, 'verify-result.md'), fixture.verifyReport);
  }
}

async function writeDocsLayoutChange(
  root: string,
  name: string,
  yaml: Record<string, string>,
): Promise<void> {
  const openSpecRoot = path.join(root, 'docs', 'openspec');
  const changeDir = path.join(openSpecRoot, 'changes', name);
  await fs.mkdir(path.join(openSpecRoot, 'specs'), { recursive: true });
  await fs.mkdir(changeDir, { recursive: true });
  await fs.writeFile(path.join(openSpecRoot, 'config.yaml'), 'schema: spec-driven\n');
  const lines = Object.entries(yaml).map(([key, value]) => `${key}: ${value}`);
  await fs.writeFile(path.join(changeDir, '.comet.yaml'), `${lines.join('\n')}\n`);
}

describe('collectDashboardSnapshot', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-collector-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns an empty snapshot when openspec/changes is missing', async () => {
    const snap = await collectDashboardSnapshot(root);

    expect(snap.changes.active).toEqual([]);
    expect(snap.changes.archived).toEqual([]);
    expect(snap.summary.activeChanges).toBe(0);
    expect(snap.summary.archivedChanges).toBe(0);
  });

  it('collects docs layout changes without treating docs as project root', async () => {
    await writeDocsLayoutChange(root, 'add-auth', {
      phase: 'build',
      plan: 'docs/superpowers/plans/add-auth.md',
    });
    const planPath = path.join(root, 'docs', 'superpowers', 'plans', 'add-auth.md');
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, '# Plan\n');

    const snapshot = await collectDashboardSnapshot(root);

    expect(snapshot.changes.active[0].path).toContain(
      path.join('docs', 'openspec', 'changes', 'add-auth'),
    );
    expect(snapshot.changes.active[0].artifacts.plan).toBe(true);
  });

  it('collects active changes and ignores the archive directory entry', async () => {
    await writeChange(root, {
      name: 'dashboard-v0',
      yaml: { phase: 'build', workflow: 'full' },
      tasks: '## A\n- [x] done\n- [ ] todo\n',
      proposal: true,
      design: true,
      plan: true,
    });
    // archive/ subdirectory should not appear as an active candidate
    await fs.mkdir(path.join(root, 'openspec', 'changes', 'archive'), { recursive: true });

    const snap = await collectDashboardSnapshot(root);

    expect(snap.changes.active.map((c) => c.name)).toEqual(['dashboard-v0']);
    expect(snap.changes.active[0].phase).toBe('build');
    expect(snap.changes.active[0].tasks).toMatchObject({ completed: 1, total: 2 });
    expect(snap.changes.active[0].next).toMatchObject({ command: '/comet-build' });
    expect(snap.changes.active[0].artifacts).toMatchObject({
      proposal: true,
      design: true,
      tasks: true,
      plan: true,
      verifyReport: false,
      cometYaml: true,
    });
    expect(snap.changes.active[0].artifacts.grouped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'proposal', source: 'openspec', exists: true }),
        expect.objectContaining({ key: 'design', source: 'openspec', exists: true }),
        expect.objectContaining({ key: 'tasks', source: 'openspec', exists: true }),
        expect.objectContaining({ key: 'plan', source: 'superpowers', exists: true }),
      ]),
    );
    expect(snap.changes.active[0].artifactPreviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'proposal',
          label: '提案',
          exists: true,
          content: '# Proposal\n',
        }),
        expect.objectContaining({
          key: 'verifyReport',
          label: '验证报告',
          exists: false,
        }),
      ]),
    );
  });

  it('parses archived changes including date and original name', async () => {
    await writeChange(root, {
      name: '2026-06-20-context-graph-notes',
      status: 'archived',
      yaml: { phase: 'archive', archived: 'true', verify_result: 'pass' },
      tasks: '## Foo\n- [x] done\n',
      proposal: true,
      design: true,
      plan: true,
      verifyReport: '# Verify\nAll passed.',
    });

    const snap = await collectDashboardSnapshot(root);

    expect(snap.changes.archived).toHaveLength(1);
    const archived = snap.changes.archived[0];
    expect(archived.id).toBe('archive/2026-06-20-context-graph-notes');
    expect(archived.status).toBe('archived');
    expect(archived.displayName).toBe('context-graph-notes');
    expect(archived.archive).toMatchObject({
      archiveName: '2026-06-20-context-graph-notes',
      originalName: 'context-graph-notes',
      archivedAt: '2026-06-20',
    });
    expect(archived.next).toBeUndefined();
    expect(archived.verify.result).toBe('pass');
    expect(archived.verify.reportExists).toBe(true);
  });

  it('resolves archived Superpowers artifacts from docs/superpowers path pointers', async () => {
    const designDocPath = path.join(root, 'docs', 'superpowers', 'specs', 'demo-design.md');
    const planPath = path.join(root, 'docs', 'superpowers', 'plans', 'demo-plan.md');
    const verifyPath = path.join(root, 'docs', 'superpowers', 'reports', 'demo-verify.md');
    await fs.mkdir(path.dirname(designDocPath), { recursive: true });
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.mkdir(path.dirname(verifyPath), { recursive: true });
    await fs.writeFile(designDocPath, '# Design Doc\n');
    await fs.writeFile(planPath, '# Plan\n');
    await fs.writeFile(verifyPath, '# Verify\nAll passed.');

    await writeChange(root, {
      name: '2026-07-09-demo',
      status: 'archived',
      yaml: {
        phase: 'archive',
        archived: 'true',
        verify_result: 'pass',
        design_doc: 'docs/superpowers/specs/demo-design.md',
        plan: 'docs/superpowers/plans/demo-plan.md',
        verification_report: 'docs/superpowers/reports/demo-verify.md',
      },
    });

    const snap = await collectDashboardSnapshot(root);
    const archived = snap.changes.archived[0];

    expect(archived.artifacts.plan).toBe(true);
    expect(archived.artifacts.verifyReport).toBe(true);
    expect(archived.verify.reportExists).toBe(true);
    expect(archived.artifacts.grouped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'designDoc',
          source: 'superpowers',
          exists: true,
          path: designDocPath,
        }),
        expect.objectContaining({
          key: 'plan',
          source: 'superpowers',
          exists: true,
          path: planPath,
        }),
        expect.objectContaining({
          key: 'verifyReport',
          source: 'superpowers',
          exists: true,
          path: verifyPath,
        }),
      ]),
    );
    expect(archived.artifactPreviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'plan',
          exists: true,
          content: '# Plan\n',
        }),
        expect.objectContaining({
          key: 'verifyReport',
          exists: true,
          content: '# Verify\nAll passed.',
        }),
      ]),
    );
  });

  it('sorts active changes by risk, then updatedAt, then name', async () => {
    await writeChange(root, {
      name: 'docs-cleanup',
      yaml: { phase: 'design', workflow: 'full' },
      proposal: true,
    });
    await writeChange(root, {
      name: 'auth-refactor',
      yaml: { phase: 'verify', verify_result: 'fail', workflow: 'full' },
      tasks: '- [x] done\n',
      proposal: true,
      design: true,
      plan: true,
    });
    await writeChange(root, {
      name: 'dashboard-v0',
      yaml: { phase: 'build', workflow: 'full' },
      tasks: '- [x] one\n- [ ] two\n',
      proposal: true,
      design: true,
      plan: true,
    });

    const snap = await collectDashboardSnapshot(root);

    // fail risk first, then warning (build with incomplete), then info-only design
    expect(snap.changes.active.map((c) => c.name)).toEqual([
      'auth-refactor',
      'dashboard-v0',
      'docs-cleanup',
    ]);
  });

  it('sorts archived changes by archivedAt descending', async () => {
    await writeChange(root, {
      name: '2026-06-15-dashboard-command',
      status: 'archived',
      yaml: { phase: 'archive', archived: 'true', verify_result: 'fail' },
    });
    await writeChange(root, {
      name: '2026-06-20-context-graph-notes',
      status: 'archived',
      yaml: { phase: 'archive', archived: 'true', verify_result: 'pass' },
    });
    await writeChange(root, {
      name: '2026-06-18-agent-workflow',
      status: 'archived',
      yaml: { phase: 'archive', archived: 'true', verify_result: 'pass' },
    });

    const snap = await collectDashboardSnapshot(root);

    expect(snap.changes.archived.map((c) => c.archive?.archivedAt)).toEqual([
      '2026-06-20',
      '2026-06-18',
      '2026-06-15',
    ]);
  });

  it('counts incomplete tasks across active changes in the summary', async () => {
    await writeChange(root, {
      name: 'a',
      yaml: { phase: 'build' },
      tasks: '- [x] one\n- [ ] two\n- [ ] three\n',
    });
    await writeChange(root, {
      name: 'b',
      yaml: { phase: 'build' },
      tasks: '- [x] one\n- [x] two\n',
    });
    await writeChange(root, {
      name: 'c-archived',
      status: 'archived',
      yaml: { phase: 'archive', archived: 'true' },
      tasks: '- [ ] should-not-count\n',
    });

    const snap = await collectDashboardSnapshot(root);

    expect(snap.summary.tasksIncomplete).toBe(2);
    expect(snap.summary.activeChanges).toBe(2);
    expect(snap.summary.archivedChanges).toBe(1);
  });

  it('marks unknown phase and surfaces a risk', async () => {
    await writeChange(root, {
      name: 'mystery',
      yaml: { workflow: 'full' },
      tasks: '',
    });

    const snap = await collectDashboardSnapshot(root);
    const item = snap.changes.active[0];

    expect(item.phase).toBe('unknown');
    expect(item.risks.some((r) => r.code === 'UNKNOWN_PHASE')).toBe(true);
    expect(item.next).toMatchObject({ command: null });
  });

  it('uses project basename and the provided clock for generatedAt', async () => {
    const now = new Date('2026-06-23T10:42:00Z');
    const snap = await collectDashboardSnapshot(root, { now });

    expect(snap.project.path).toBe(root);
    expect(snap.project.name).toBe(path.basename(root));
    expect(snap.project.generatedAt).toBe(now.toISOString());
  });

  it('skips a single broken change without aborting the whole sweep', async () => {
    await writeChange(root, {
      name: 'healthy',
      yaml: { phase: 'build' },
      tasks: '- [ ] one\n',
    });

    // Plant an unreadable .comet.yaml (a directory where a file should be)
    // so the per-change build throws when it tries to read it.
    const bogusDir = path.join(root, 'openspec', 'changes', 'bogus');
    await fs.mkdir(path.join(bogusDir, '.comet.yaml'), { recursive: true });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const snap = await collectDashboardSnapshot(root);
      expect(snap.changes.active.map((c) => c.name)).toEqual(['healthy']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('bogus'));
    } finally {
      warn.mockRestore();
    }
  });

  it('resolves plan from yaml path-pointer in docs/superpowers/', async () => {
    // Create plan in docs/superpowers/ (not in change dir)
    const planDir = path.join(root, 'docs', 'superpowers', 'plans');
    await fs.mkdir(planDir, { recursive: true });
    await fs.writeFile(path.join(planDir, '2026-06-28-my-feature.md'), '# Plan\n');

    await writeChange(root, {
      name: 'my-feature',
      yaml: { phase: 'build', plan: 'docs/superpowers/plans/2026-06-28-my-feature.md' },
      tasks: '- [ ] one\n',
      proposal: true,
      design: true,
    });

    const snap = await collectDashboardSnapshot(root);
    const item = snap.changes.active[0];

    expect(item.artifacts.plan).toBe(true);
    expect(item.artifacts.grouped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'plan',
          source: 'superpowers',
          exists: true,
          path: expect.stringContaining('2026-06-28-my-feature.md'),
        }),
      ]),
    );
  });

  it('resolves verify report from yaml path-pointer in docs/superpowers/', async () => {
    // Create verify report in docs/superpowers/
    const reportDir = path.join(root, 'docs', 'superpowers', 'reports');
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(path.join(reportDir, '2026-06-28-verify.md'), '# Verify\nAll passed.');

    await writeChange(root, {
      name: 'my-feature',
      yaml: {
        phase: 'verify',
        verify_result: 'pass',
        verification_report: 'docs/superpowers/reports/2026-06-28-verify.md',
      },
      tasks: '- [x] done\n',
      proposal: true,
      design: true,
    });

    const snap = await collectDashboardSnapshot(root);
    const item = snap.changes.active[0];

    expect(item.verify.reportExists).toBe(true);
    expect(item.verify.result).toBe('pass');
    expect(item.artifacts.verifyReport).toBe(true);
  });

  it('groups artifacts by source (openspec vs superpowers)', async () => {
    const planDir = path.join(root, 'docs', 'superpowers', 'plans');
    await fs.mkdir(planDir, { recursive: true });
    await fs.writeFile(path.join(planDir, '2026-06-28-f.md'), '# Plan\n');

    await writeChange(root, {
      name: 'feat-x',
      yaml: { phase: 'build', plan: 'docs/superpowers/plans/2026-06-28-f.md' },
      tasks: '- [ ] one\n',
      proposal: true,
      design: true,
    });

    const snap = await collectDashboardSnapshot(root);
    const grouped = snap.changes.active[0].artifacts.grouped;

    const openspecKeys = grouped.filter((a) => a.source === 'openspec').map((a) => a.key);
    const superpowersKeys = grouped.filter((a) => a.source === 'superpowers').map((a) => a.key);

    expect(openspecKeys).toContain('proposal');
    expect(openspecKeys).toContain('design');
    expect(openspecKeys).toContain('tasks');
    expect(superpowersKeys).toContain('plan');
  });
});
