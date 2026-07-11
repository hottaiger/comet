import path from 'path';
import { promises as fs } from 'fs';
import { fileExists, readDir } from '../../platform/fs/file-system.js';
import { resolveCometArtifactLayout } from '../../domains/comet-classic/classic-artifact-layout.js';
import { inspectClassicChange } from '../../domains/comet-classic/classic-diagnostics.js';
import { readClassicState } from '../../domains/comet-classic/classic-store.js';

interface ChangeStatus {
  name: string;
  workflow: string;
  phase: string;
  buildMode: string;
  isolation: string;
  verifyMode: string;
  verifyResult: string;
  designDoc: string | null;
  plan: string | null;
  tasksCompleted: number;
  tasksTotal: number;
  nextCommand: string | null;
  currentStep: string | null;
  runtimeMode: string;
  runtimeEval: {
    stepId: string;
    passed: boolean;
    requiredEvidence: string[];
    missingEvidence: string[];
  } | null;
  error?: string;
}

async function countTasks(tasksPath: string): Promise<{ done: number; total: number }> {
  if (!(await fileExists(tasksPath))) return { done: 0, total: 0 };
  const content = await fs.readFile(tasksPath, 'utf-8');
  const lines = content.split('\n');
  const total = lines.filter((l) => /^\s*- \[[ x]\]/.test(l)).length;
  const done = lines.filter((l) => /^\s*- \[x\]/i.test(l)).length;
  return { done, total };
}

async function getActiveChanges(projectPath: string): Promise<ChangeStatus[]> {
  const layout = await resolveCometArtifactLayout(projectPath);
  const changesDir = layout.openSpec.changesDir;
  if (!(await fileExists(changesDir))) return [];

  const entries = await readDir(changesDir);
  const changes: ChangeStatus[] = [];

  for (const entry of entries) {
    if (entry === 'archive') continue;
    const changeDir = path.join(changesDir, entry);
    const stat = await fs.stat(changeDir);
    if (!stat.isDirectory()) continue;

    const yamlPath = path.join(changeDir, '.comet.yaml');
    if (!(await fileExists(yamlPath))) continue;
    try {
      const projection = await readClassicState(changeDir);
      if (projection.classic?.archived) continue;

      const { done, total } = await countTasks(path.join(changeDir, 'tasks.md'));
      const diagnostic = await inspectClassicChange(changeDir, entry);

      if (diagnostic.valid && projection.classic) {
        changes.push({
          name: entry,
          workflow: diagnostic.workflow,
          phase: diagnostic.phase,
          buildMode: projection.classic.buildMode ?? 'null',
          isolation: projection.classic.isolation ?? 'null',
          verifyMode: projection.classic.verifyMode ?? 'null',
          verifyResult: projection.classic.verifyResult,
          designDoc: projection.classic.designDoc,
          plan: projection.classic.plan,
          tasksCompleted: done,
          tasksTotal: total,
          nextCommand: diagnostic.nextCommand,
          currentStep: diagnostic.currentStep,
          runtimeMode: diagnostic.runtimeMode,
          runtimeEval: diagnostic.runtimeEval,
        });
        continue;
      }

      changes.push({
        name: entry,
        workflow: diagnostic.workflow,
        phase: diagnostic.phase,
        buildMode: projection.classic?.buildMode ?? 'null',
        isolation: projection.classic?.isolation ?? 'null',
        verifyMode: projection.classic?.verifyMode ?? 'null',
        verifyResult: projection.classic?.verifyResult ?? 'pending',
        designDoc: projection.classic?.designDoc ?? null,
        plan: projection.classic?.plan ?? null,
        tasksCompleted: done,
        tasksTotal: total,
        nextCommand: diagnostic.nextCommand,
        currentStep: diagnostic.currentStep,
        runtimeMode: diagnostic.runtimeMode,
        runtimeEval: diagnostic.runtimeEval,
        error: diagnostic.error,
      });
    } catch (error) {
      changes.push({
        name: entry,
        workflow: 'unknown',
        phase: 'invalid',
        buildMode: 'null',
        isolation: 'null',
        verifyMode: 'null',
        verifyResult: 'pending',
        designDoc: null,
        plan: null,
        tasksCompleted: 0,
        tasksTotal: 0,
        nextCommand: null,
        currentStep: null,
        runtimeMode: 'invalid',
        runtimeEval: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return changes;
}

function formatMissingEvidence(missingEvidence: readonly string[]): string {
  return missingEvidence.join(', ');
}

function formatRuntimeCheckRecovery(
  nextCommand: string | null,
  missingEvidence: readonly string[],
): string {
  const missing = formatMissingEvidence(missingEvidence);
  if (nextCommand) {
    return `run ${nextCommand} or restore missing evidence (${missing}), then rerun comet doctor`;
  }
  return `restore missing evidence (${missing}) and rerun comet doctor`;
}

function displayStatus(changes: ChangeStatus[]): void {
  if (changes.length === 0) {
    console.log('No active changes.\n');
    return;
  }

  console.log('Active Changes:\n');

  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const taskStr = c.tasksTotal > 0 ? ` [${c.tasksCompleted}/${c.tasksTotal} tasks]` : '';
    console.log(`  ${i + 1}. ${c.name} [phase: ${c.phase}${taskStr}]`);
    if (c.error) {
      console.log(`     error: ${c.error}`);
      console.log('     next: inspect .comet.yaml and rerun comet doctor');
      console.log();
      continue;
    }
    console.log(`     workflow: ${c.workflow} | build_mode: ${c.buildMode}`);
    if (c.currentStep) console.log(`     run_step: ${c.currentStep}`);
    console.log(`     runtime_mode: ${c.runtimeMode}`);
    if (c.runtimeEval) {
      const suffix = c.runtimeEval.passed
        ? `(${c.runtimeEval.stepId})`
        : `(${c.runtimeEval.stepId}; missing: ${formatMissingEvidence(c.runtimeEval.missingEvidence)})`;
      console.log(`     runtime_check: ${c.runtimeEval.passed ? 'pass' : 'fail'} ${suffix}`);
    }
    if (c.designDoc) console.log(`     design: ${c.designDoc}`);
    if (c.plan) console.log(`     plan:   ${c.plan}`);
    if (c.phase === 'verify') console.log(`     verify_result: ${c.verifyResult}`);
    if (c.runtimeEval && !c.runtimeEval.passed) {
      console.log(
        `     next: ${formatRuntimeCheckRecovery(c.nextCommand, c.runtimeEval.missingEvidence)}`,
      );
    } else if (c.nextCommand) {
      console.log(`     next: ${c.nextCommand}`);
    }
    console.log();
  }
}

interface StatusOptions {
  json?: boolean;
}

export async function statusCommand(
  targetPath: string,
  options: StatusOptions = {},
): Promise<void> {
  const projectPath = path.resolve(targetPath);
  const changes = await getActiveChanges(projectPath);

  if (options.json) {
    console.log(JSON.stringify({ changes }, null, 2));
    return;
  }

  displayStatus(changes);
}
