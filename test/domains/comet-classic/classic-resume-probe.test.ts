import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCometResumeProbe } from '../../../domains/comet-classic/classic-resume-probe.js';

let tmpDir: string;

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function createChange(
  name: string,
  yaml: string,
  files: Record<string, string> = {},
): Promise<void> {
  const root = path.join(tmpDir, 'openspec', 'changes', name);
  await writeFile(path.join(root, '.comet.yaml'), yaml);
  await writeFile(path.join(root, 'proposal.md'), files['proposal.md'] ?? 'Improve cache ttl\n');
  await writeFile(path.join(root, 'design.md'), files['design.md'] ?? 'Cache ttl design\n');
  await writeFile(path.join(root, 'tasks.md'), files['tasks.md'] ?? '- [ ] Update cache ttl\n');
  await writeFile(
    path.join(tmpDir, 'docs', 'superpowers', 'specs', 'cache-ttl.md'),
    '# Cache TTL\n',
  );
  await writeFile(
    path.join(tmpDir, 'docs', 'superpowers', 'plans', 'cache-ttl.md'),
    '- [ ] Update cache ttl\n',
  );
}

async function createDocsLayoutChange(
  name: string,
  yaml: string,
  files: Record<string, string> = {},
): Promise<void> {
  const root = path.join(tmpDir, 'docs', 'openspec', 'changes', name);
  await writeFile(
    path.join(tmpDir, '.comet', 'config.yaml'),
    [
      'artifact_layout: docs',
      'openspec:',
      '  root: docs',
      'superpowers:',
      '  root: docs/superpowers',
      '',
    ].join('\n'),
  );
  await writeFile(path.join(tmpDir, 'docs', 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  await writeFile(path.join(root, '.comet.yaml'), yaml);
  await writeFile(path.join(root, 'proposal.md'), files['proposal.md'] ?? 'Add auth flow\n');
  await writeFile(path.join(root, 'design.md'), files['design.md'] ?? 'Auth flow design\n');
  await writeFile(path.join(root, 'tasks.md'), files['tasks.md'] ?? '- [ ] Ship auth flow\n');
  await writeFile(path.join(tmpDir, 'docs', 'superpowers', 'specs', 'add-auth.md'), '# Auth\n');
  await writeFile(
    path.join(tmpDir, 'docs', 'superpowers', 'plans', 'add-auth.md'),
    '- [ ] Ship auth flow\n',
  );
}

function git(args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: tmpDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

const buildYaml = [
  'workflow: full',
  'phase: build',
  'archived: false',
  'build_pause: null',
  'isolation: branch',
  'build_mode: executing-plans',
  'tdd_mode: tdd',
  'review_mode: standard',
  'verify_mode: full',
  'verified_at: null',
  'verify_result: pending',
  'auto_transition: true',
  'design_doc: docs/superpowers/specs/cache-ttl.md',
  'plan: docs/superpowers/plans/cache-ttl.md',
  '',
].join('\n');

describe('resolveCometResumeProbe', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-resume-probe-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns none when no active Comet changes exist', async () => {
    const result = await resolveCometResumeProbe(tmpDir, {
      schema_version: 'comet.resume_probe.v1',
      utterance: 'continue',
      agent_context: { non_trivial_work: true, already_in_comet_flow: false },
    });

    expect(result).toMatchObject({
      action: 'none',
      confidence: 'none',
      changeName: null,
      nextCommand: null,
    });
  });

  it('auto resumes a single active change for resume-like work', async () => {
    await createChange('cache-ttl', buildYaml);

    const result = await resolveCometResumeProbe(tmpDir, {
      schema_version: 'comet.resume_probe.v1',
      utterance: '继续刚才的任务',
      agent_context: { non_trivial_work: true, already_in_comet_flow: false },
    });

    expect(result).toMatchObject({
      action: 'auto_resume',
      confidence: 'high',
      changeName: 'cache-ttl',
      phase: 'build',
      nextCommand: '/comet-build',
    });
  });

  it('auto resumes a docs layout active change', async () => {
    const root = path.join(tmpDir, 'docs', 'openspec', 'changes', 'add-auth');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'docs', 'openspec', 'specs'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'docs', 'openspec', 'config.yaml'),
      'schema: spec-driven\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(root, '.comet.yaml'),
      [
        'workflow: full',
        'phase: build',
        'design_doc: null',
        'plan: null',
        'build_mode: direct',
        'isolation: branch',
        'verify_mode: full',
        'verify_result: pending',
        'verified_at: null',
        'archived: false',
        'artifact_layout: docs',
        'openspec_root: docs',
        'superpowers_root: docs/superpowers',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await resolveCometResumeProbe(tmpDir, {
      schema_version: 'comet.resume_probe.v1',
      utterance: '继续',
      locale: 'zh-CN',
      agent_context: { non_trivial_work: true, already_in_comet_flow: false },
    });

    expect(result.action).toBe('auto_resume');
    expect(result.changeName).toBe('add-auth');
  });

  it('does not rewrite legacy command fields while probing', async () => {
    await createChange('cache-ttl', `${buildYaml}build_command: npm test\n`);
    const yamlPath = path.join(tmpDir, 'openspec', 'changes', 'cache-ttl', '.comet.yaml');
    const before = await fs.readFile(yamlPath, 'utf8');

    const result = await resolveCometResumeProbe(tmpDir, {
      schema_version: 'comet.resume_probe.v1',
      utterance: '继续刚才的任务',
      agent_context: { non_trivial_work: true, already_in_comet_flow: false },
    });

    expect(result.action).toBe('auto_resume');
    expect(await fs.readFile(yamlPath, 'utf8')).toBe(before);
  });

  it('asks before resuming when the worktree has unattributed changes', async () => {
    await createChange('cache-ttl', buildYaml);
    git(['init']);
    await writeFile(path.join(tmpDir, 'README.md'), 'dirty user edit\n');

    const result = await resolveCometResumeProbe(tmpDir, {
      schema_version: 'comet.resume_probe.v1',
      utterance: '继续刚才的任务',
      agent_context: { non_trivial_work: true, already_in_comet_flow: false },
    });

    expect(result).toMatchObject({
      action: 'ask_user',
      confidence: 'low',
      changeName: 'cache-ttl',
    });
    expect(result.reason).toContain('uncommitted');
  });

  it('does not auto resume from a single generic token match', async () => {
    await createChange('cache-ttl', buildYaml, {
      'tasks.md': '- [ ] Update cache ttl\n',
    });

    const result = await resolveCometResumeProbe(tmpDir, {
      schema_version: 'comet.resume_probe.v1',
      utterance: 'update README badges',
      agent_context: { non_trivial_work: true, already_in_comet_flow: false },
    });

    expect(result.action).toBe('ask_user');
    expect(result.reason).toContain('looks unrelated');
  });

  it('asks when an OpenSpec change exists without Comet state', async () => {
    const root = path.join(tmpDir, 'openspec', 'changes', 'cache-ttl');
    await writeFile(path.join(root, 'proposal.md'), 'Improve cache ttl\n');
    await writeFile(path.join(root, 'tasks.md'), '- [ ] Update cache ttl\n');

    const result = await resolveCometResumeProbe(tmpDir, {
      schema_version: 'comet.resume_probe.v1',
      utterance: '继续 cache-ttl',
      agent_context: { non_trivial_work: true, already_in_comet_flow: false },
    });

    expect(result).toMatchObject({
      action: 'ask_user',
      confidence: 'low',
      changeName: 'cache-ttl',
      nextCommand: null,
    });
    expect(result.reason).toContain('missing Comet state');
  });

  it('auto resumes when the request names the active change', async () => {
    await createChange('cache-ttl', buildYaml);

    const result = await resolveCometResumeProbe(tmpDir, {
      schema_version: 'comet.resume_probe.v1',
      utterance: '继续 cache-ttl',
      agent_context: { non_trivial_work: true, already_in_comet_flow: false },
    });

    expect(result.action).toBe('auto_resume');
    expect(result.evidence.some((item) => item.quote.includes('cache-ttl'))).toBe(true);
  });

  it('asks the user when a single active change exists but the request is a new topic', async () => {
    await createChange('cache-ttl', buildYaml);

    const result = await resolveCometResumeProbe(tmpDir, {
      schema_version: 'comet.resume_probe.v1',
      utterance: '给 README 加安装截图',
      agent_context: { non_trivial_work: true, already_in_comet_flow: false },
    });

    expect(result).toMatchObject({
      action: 'ask_user',
      confidence: 'low',
      changeName: 'cache-ttl',
      nextCommand: '/comet-build',
    });
    expect(result.reason).toContain('looks unrelated');
  });

  it('asks the user and does not suggest nextCommand when state is missing required fields', async () => {
    const invalidBuildYaml = buildYaml
      .replace('verify_mode: full\n', '')
      .replace('verified_at: null\n', '');
    await createChange('cache-ttl', invalidBuildYaml);

    const result = await resolveCometResumeProbe(tmpDir, {
      schema_version: 'comet.resume_probe.v1',
      utterance: '继续刚才的任务',
      agent_context: { non_trivial_work: true, already_in_comet_flow: false },
    });

    expect(result).toMatchObject({
      action: 'ask_user',
      confidence: 'low',
      changeName: 'cache-ttl',
      nextCommand: null,
    });
    expect(result.reason).toContain('decision point');
  });

  it('returns out_of_scope for pure questions', async () => {
    await createChange('cache-ttl', buildYaml);

    const result = await resolveCometResumeProbe(tmpDir, {
      schema_version: 'comet.resume_probe.v1',
      utterance: '这个探针靠谱吗',
      agent_context: { non_trivial_work: false, already_in_comet_flow: false },
    });

    expect(result).toMatchObject({
      action: 'out_of_scope',
      confidence: 'low',
      nextCommand: null,
    });
  });

  it('asks the user for multiple active changes without a named change', async () => {
    await createChange('cache-ttl', buildYaml);
    await createChange('eval-noise', buildYaml.replace('Cache ttl design', 'Eval noise design'));

    const result = await resolveCometResumeProbe(tmpDir, {
      schema_version: 'comet.resume_probe.v1',
      utterance: '继续',
      agent_context: { non_trivial_work: true, already_in_comet_flow: false },
    });

    expect(result.action).toBe('ask_user');
    expect(result.reason).toContain('multiple active changes');
  });

  it('does not auto resume a named change while the worktree has unattributed changes', async () => {
    await createChange('cache-ttl', buildYaml);
    await createChange('eval-noise', buildYaml.replace('Cache ttl design', 'Eval noise design'));
    git(['init']);
    await writeFile(path.join(tmpDir, 'notes.md'), 'manual edit\n');

    const result = await resolveCometResumeProbe(tmpDir, {
      schema_version: 'comet.resume_probe.v1',
      utterance: 'continue cache-ttl',
      agent_context: { non_trivial_work: true, already_in_comet_flow: false },
    });

    expect(result).toMatchObject({
      action: 'ask_user',
      confidence: 'low',
      changeName: 'cache-ttl',
    });
    expect(result.reason).toContain('uncommitted');
  });

  it('includes docs layout repo evidence when auto-resuming a named change among multiple active changes', async () => {
    const docsBuildYaml = [
      ...buildYaml.trimEnd().split('\n'),
      'artifact_layout: docs',
      'openspec_root: docs',
      'superpowers_root: docs/superpowers',
      '',
    ].join('\n');
    await createDocsLayoutChange('add-auth', docsBuildYaml);
    await createDocsLayoutChange(
      'add-billing',
      docsBuildYaml.replace('cache-ttl', 'billing').replace('Update cache ttl', 'Ship billing'),
      {
        'proposal.md': 'Add billing flow\n',
        'design.md': 'Billing flow design\n',
        'tasks.md': '- [ ] Ship billing flow\n',
      },
    );

    const result = await resolveCometResumeProbe(tmpDir, {
      schema_version: 'comet.resume_probe.v1',
      utterance: '继续 add-auth',
      locale: 'zh-CN',
      agent_context: { non_trivial_work: true, already_in_comet_flow: false },
    });

    expect(result.action).toBe('auto_resume');
    expect(result.changeName).toBe('add-auth');
    expect(result.evidence).toContainEqual({
      source: 'repo',
      quote: 'docs: docs/openspec/changes/add-auth',
    });
  });

  it('asks the user when build is waiting at plan-ready', async () => {
    await createChange(
      'cache-ttl',
      buildYaml.replace('build_pause: null', 'build_pause: plan-ready'),
    );

    const result = await resolveCometResumeProbe(tmpDir, {
      schema_version: 'comet.resume_probe.v1',
      utterance: '继续',
      agent_context: { non_trivial_work: true, already_in_comet_flow: false },
    });

    expect(result.action).toBe('ask_user');
    expect(result.reason).toContain('decision point');
  });

  it('honors explicit opt-out wording', async () => {
    await createChange('cache-ttl', buildYaml);

    const result = await resolveCometResumeProbe(tmpDir, {
      schema_version: 'comet.resume_probe.v1',
      utterance: '不要恢复 workflow，直接解释这个文件',
      agent_context: { non_trivial_work: false, already_in_comet_flow: false },
    });

    expect(result.action).toBe('out_of_scope');
    expect(result.reason).toContain('opted out');
  });
});
