import path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { fileExists, readDir } from '../../platform/fs/file-system.js';
import type { ClassicDiagnostic } from './classic-diagnostics.js';
import { projectRelativePath, resolveCometArtifactLayout } from './classic-artifact-layout.js';
import { readClassicState } from './classic-store.js';
import type { ClassicStateProjection } from './classic-state.js';

export const COMET_RESUME_PROBE_SCHEMA_VERSION = 'comet.resume_probe.v1' as const;

export type CometResumeProbeAction = 'none' | 'auto_resume' | 'ask_user' | 'out_of_scope';
export type CometResumeProbeConfidence = 'none' | 'low' | 'high';
export type CometResumeProbeEvidenceSource = 'user' | 'state' | 'repo';

export interface CometResumeProbeInput {
  schema_version: typeof COMET_RESUME_PROBE_SCHEMA_VERSION;
  utterance: string;
  locale: string;
  agent_context: {
    non_trivial_work: boolean;
    already_in_comet_flow: boolean;
  };
}

export interface CometResumeProbeEvidence {
  source: CometResumeProbeEvidenceSource;
  quote: string;
}

export interface CometResumeProbeResult {
  schema_version: typeof COMET_RESUME_PROBE_SCHEMA_VERSION;
  action: CometResumeProbeAction;
  changeName: string | null;
  phase: string | null;
  nextCommand: string | null;
  confidence: CometResumeProbeConfidence;
  reason: string;
  evidence: CometResumeProbeEvidence[];
}

interface ActiveProbeChange {
  name: string;
  changeDir: string;
  layout: 'legacy' | 'docs';
  workflow: string;
  phase: string;
  nextCommand: string | null;
  diagnostic: ClassicDiagnostic;
  buildPause: string | null;
  hasClassicProjection: boolean;
  verifyResult: 'pending' | 'pass' | 'fail' | null;
  text: string;
  missingCometState: boolean;
}

interface ActiveChangeDiscovery {
  changes: ActiveProbeChange[];
  layoutConflict: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeInput(input: unknown): CometResumeProbeInput {
  if (!isRecord(input)) {
    throw new Error('Invalid CometResumeProbeInput: input must be an object');
  }
  if (input.schema_version !== COMET_RESUME_PROBE_SCHEMA_VERSION) {
    throw new Error(
      `Invalid CometResumeProbeInput: schema_version must be ${COMET_RESUME_PROBE_SCHEMA_VERSION}`,
    );
  }
  if (typeof input.utterance !== 'string') {
    throw new Error('Invalid CometResumeProbeInput: utterance must be a string');
  }
  const context = isRecord(input.agent_context) ? input.agent_context : {};
  return {
    schema_version: COMET_RESUME_PROBE_SCHEMA_VERSION,
    utterance: input.utterance,
    locale: typeof input.locale === 'string' ? input.locale : 'unknown',
    agent_context: {
      non_trivial_work: context.non_trivial_work === true,
      already_in_comet_flow: context.already_in_comet_flow === true,
    },
  };
}

function result(
  action: CometResumeProbeAction,
  change: ActiveProbeChange | null,
  confidence: CometResumeProbeConfidence,
  reason: string,
  evidence: CometResumeProbeEvidence[] = [],
): CometResumeProbeResult {
  return {
    schema_version: COMET_RESUME_PROBE_SCHEMA_VERSION,
    action,
    changeName: change?.name ?? null,
    phase: change?.phase ?? null,
    nextCommand:
      action === 'auto_resume' || action === 'ask_user' ? (change?.nextCommand ?? null) : null,
    confidence,
    reason,
    evidence,
  };
}

async function readIfExists(filePath: string): Promise<string> {
  if (!(await fileExists(filePath))) return '';
  return fs.readFile(filePath, 'utf8');
}

async function changeSearchText(changeDir: string, classic: ActiveProbeChange): Promise<string> {
  const files = ['proposal.md', 'design.md', 'tasks.md'];
  const parts = [classic.name, classic.workflow, classic.phase];
  for (const file of files) {
    parts.push(await readIfExists(path.join(changeDir, file)));
  }
  return parts.join('\n').toLowerCase();
}

function nextCommandForPhase(phase: string): string | null {
  switch (phase) {
    case 'open':
      return '/comet-open';
    case 'design':
      return '/comet-design';
    case 'build':
      return '/comet-build';
    case 'verify':
      return '/comet-verify';
    case 'archive':
      return '/comet-archive';
    default:
      return null;
  }
}

function diagnosticFromProjection(
  changeDir: string,
  name: string,
  projection: ClassicStateProjection,
): ClassicDiagnostic {
  const classic = projection.classic;
  const unknownKeys = projection.unknownKeys.filter((key) => key !== 'run_id');
  if (!classic) {
    return {
      name,
      valid: false,
      workflow: 'unknown',
      phase: 'invalid',
      currentStep: null,
      nextCommand: null,
      runtimeMode: 'invalid',
      runtimeEval: null,
      evidence: [],
      error: `${changeDir} does not contain valid Comet state`,
    };
  }
  if (unknownKeys.length > 0) {
    return {
      name,
      valid: false,
      workflow: classic.workflow,
      phase: classic.phase,
      currentStep: null,
      nextCommand: null,
      runtimeMode: 'invalid',
      runtimeEval: null,
      evidence: [],
      error: `unknown field(s): ${unknownKeys.join(', ')}`,
    };
  }
  return {
    name,
    valid: true,
    workflow: classic.workflow,
    phase: classic.phase,
    currentStep: null,
    nextCommand: nextCommandForPhase(classic.phase),
    runtimeMode: 'engine-projection',
    runtimeEval: null,
    evidence: [],
  };
}

async function hasOpenSpecChangeFiles(changeDir: string): Promise<boolean> {
  return (
    (await fileExists(path.join(changeDir, 'proposal.md'))) ||
    (await fileExists(path.join(changeDir, 'design.md'))) ||
    (await fileExists(path.join(changeDir, 'tasks.md')))
  );
}

async function discoverActiveChanges(projectRoot: string): Promise<ActiveChangeDiscovery> {
  let layout;
  try {
    layout = await resolveCometArtifactLayout(projectRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/multiple artifact layouts contain active comet changes/i.test(message)) {
      return { changes: [], layoutConflict: true };
    }
    throw error;
  }

  const changesDir = layout.openSpec.changesDir;
  if (!(await fileExists(changesDir))) return { changes: [], layoutConflict: false };

  const entries = await readDir(changesDir);
  const changes: ActiveProbeChange[] = [];
  for (const entry of entries) {
    if (entry === 'archive') continue;
    const changeDir = path.join(changesDir, entry);
    const stat = await fs.stat(changeDir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const hasCometState = await fileExists(path.join(changeDir, '.comet.yaml'));
    if (!hasCometState) {
      if (!(await hasOpenSpecChangeFiles(changeDir))) continue;
      const missingStateChange: ActiveProbeChange = {
        name: entry,
        changeDir,
        layout: layout.layout,
        workflow: 'unknown',
        phase: 'invalid',
        nextCommand: null,
        diagnostic: {
          name: entry,
          valid: false,
          workflow: 'unknown',
          phase: 'invalid',
          currentStep: null,
          nextCommand: null,
          runtimeMode: 'invalid',
          runtimeEval: null,
          evidence: [],
          error: 'missing Comet state',
        },
        buildPause: null,
        hasClassicProjection: false,
        verifyResult: null,
        text: '',
        missingCometState: true,
      };
      missingStateChange.text = await changeSearchText(changeDir, missingStateChange);
      changes.push(missingStateChange);
      continue;
    }

    const projection = await readClassicState(changeDir, { migrate: false });
    const classic = projection.classic;
    const diagnostic = diagnosticFromProjection(changeDir, entry, projection);
    const hasClassicProjection = Boolean(classic);
    const phase = classic?.phase ?? diagnostic.phase;
    const workflow = classic?.workflow ?? diagnostic.workflow;
    if (phase === 'archive' || classic?.archived) continue;

    const change: ActiveProbeChange = {
      name: entry,
      changeDir,
      layout: layout.layout,
      workflow,
      phase,
      nextCommand: diagnostic.nextCommand,
      diagnostic,
      buildPause: classic?.buildPause ?? null,
      hasClassicProjection,
      verifyResult: classic?.verifyResult ?? null,
      text: '',
      missingCometState: false,
    };
    change.text = await changeSearchText(changeDir, change);
    changes.push(change);
  }
  return { changes, layoutConflict: false };
}

const RESUME_WORDS = [
  'continue',
  'resume',
  'carry on',
  'finish',
  'run it',
  'commit',
  'verify',
  'archive',
  '继续',
  '接着',
  '恢复',
  '跑完',
  '提交',
  '验证',
  '归档',
  '修刚才',
];

const QUESTION_WORDS = [
  'what',
  'why',
  'how',
  'explain',
  'summarize',
  'reliable',
  '靠谱吗',
  '是什么',
  '为什么',
  '解释',
  '总结',
  '取名',
  '命名',
];

const GENERIC_RELATED_TOKENS = new Set([
  'add',
  'build',
  'cache',
  'change',
  'code',
  'design',
  'docs',
  'file',
  'fix',
  'implement',
  'plan',
  'readme',
  'task',
  'test',
  'update',
  '修改',
  '更新',
  '修复',
  '添加',
  '文档',
  '任务',
  '计划',
  '实现',
]);

const OPT_OUT_WORDS = [
  'do not resume',
  "don't resume",
  'without comet',
  'skip comet',
  '不要恢复',
  '不走 comet',
  '不要走 comet',
  '直接解释',
  '只回答',
];

function includesAny(text: string, words: readonly string[]): boolean {
  return words.some((word) => text.includes(word));
}

function hasDecisionPoint(change: ActiveProbeChange): boolean {
  if (change.missingCometState) return true;
  if (!change.hasClassicProjection) return true;
  if (!change.diagnostic.valid) return true;
  if (change.phase === 'archive') return true;
  if (change.verifyResult === 'fail') return true;
  if (change.diagnostic.runtimeEval && !change.diagnostic.runtimeEval.passed) return true;
  if (change.phase !== 'build') return false;
  if (change.buildPause === 'plan-ready') return true;
  return false;
}

function relatedEvidence(utterance: string, change: ActiveProbeChange): CometResumeProbeEvidence[] {
  const text = utterance.toLowerCase();
  const evidence: CometResumeProbeEvidence[] = [];
  if (text.includes(change.name.toLowerCase())) {
    evidence.push({ source: 'user', quote: change.name });
  }
  const tokens = change.text
    .split(/[^a-zA-Z0-9_\-\u4e00-\u9fff/]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 4 && !GENERIC_RELATED_TOKENS.has(token));
  const matched = [...new Set(tokens.filter((token) => text.includes(token)))].slice(0, 3);
  for (const token of matched) {
    evidence.push({ source: 'repo', quote: token });
  }
  return evidence;
}

async function gitDirtyFiles(projectRoot: string): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn('git', ['status', '--short', '--untracked-files=all'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.on('error', () => resolve([]));
    child.on('exit', (code) => {
      if (code !== 0) {
        resolve([]);
        return;
      }
      const dirtyFiles = Buffer.concat(chunks)
        .toString('utf8')
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
      resolve(dirtyFiles);
    });
  });
}

export async function resolveCometResumeProbe(
  projectRoot: string,
  rawInput: unknown,
): Promise<CometResumeProbeResult> {
  const input = normalizeInput(rawInput);
  const utterance = input.utterance.trim();
  const lower = utterance.toLowerCase();

  if (input.agent_context.already_in_comet_flow) {
    return result('out_of_scope', null, 'low', 'already in Comet flow');
  }
  if (includesAny(lower, OPT_OUT_WORDS)) {
    return result('out_of_scope', null, 'low', 'user opted out of Comet resume', [
      { source: 'user', quote: utterance },
    ]);
  }

  const discovery = await discoverActiveChanges(projectRoot);
  if (discovery.layoutConflict) {
    return result('ask_user', null, 'low', 'multiple artifact layouts contain active changes', [
      { source: 'repo', quote: 'docs/openspec and openspec both contain active changes' },
    ]);
  }
  const { changes } = discovery;
  if (changes.length === 0) {
    return result('none', null, 'none', 'no active Comet changes');
  }
  const dirtyFiles = await gitDirtyFiles(projectRoot);
  if (changes.length > 1) {
    const named = changes.find((change) => lower.includes(change.name.toLowerCase()));
    if (!named) {
      return result('ask_user', null, 'low', 'multiple active changes require a change name');
    }
    if (dirtyFiles.length > 0) {
      return result('ask_user', named, 'low', 'uncommitted worktree changes require attribution', [
        { source: 'repo', quote: `${dirtyFiles.length} dirty file(s)` },
      ]);
    }
    return hasDecisionPoint(named)
      ? result('ask_user', named, 'low', 'active change is at a decision point')
      : result('auto_resume', named, 'high', 'request names an active change', [
          { source: 'user', quote: named.name },
        ]);
  }

  const [change] = changes;
  if (dirtyFiles.length > 0) {
    return result('ask_user', change, 'low', 'uncommitted worktree changes require attribution', [
      { source: 'repo', quote: `${dirtyFiles.length} dirty file(s)` },
    ]);
  }

  if (hasDecisionPoint(change)) {
    if (change.missingCometState) {
      return result('ask_user', change, 'low', 'active OpenSpec change is missing Comet state');
    }
    return result('ask_user', change, 'low', 'active change is at a decision point', [
      { source: 'state', quote: `phase: ${change.phase}` },
    ]);
  }

  const resumeLike = includesAny(lower, RESUME_WORDS);
  const questionLike = !input.agent_context.non_trivial_work && includesAny(lower, QUESTION_WORDS);
  if (questionLike && !resumeLike) {
    return result('out_of_scope', change, 'low', 'user asked a question without workflow work');
  }

  const evidence = relatedEvidence(utterance, change);
  if (resumeLike || evidence.length > 0) {
    return result('auto_resume', change, 'high', 'single active change and request is related', [
      { source: 'repo', quote: `${change.layout}: ${projectRelativePath(projectRoot, change.changeDir)}` },
      { source: 'state', quote: `phase: ${change.phase}` },
      ...evidence,
    ]);
  }

  if (input.agent_context.non_trivial_work) {
    return result(
      'ask_user',
      change,
      'low',
      'single active change exists but request looks unrelated',
    );
  }

  return result('out_of_scope', change, 'low', 'request is not workflow work');
}
