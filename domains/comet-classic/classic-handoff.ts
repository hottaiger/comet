import { createHash } from 'crypto';
import { promises as fs, readFileSync } from 'fs';
import path from 'path';
import { parseDocument } from 'yaml';
import type { ClassicCommandHandler, ClassicCommandResult } from './classic-cli.js';
import { openSpecChangeNameError, resolveClassicChangeDirectory } from './classic-paths.js';
import { ensureClassicRuntimeRun, transitionClassicRuntimeRun } from './classic-runtime-run.js';
import { readClassicState, writeClassicState } from './classic-store.js';
import {
  appendTrajectory,
  clearPendingAction,
  readArtifacts,
  readCheckpoint,
  readContext,
  readPendingAction,
  readTrajectory,
  writeArtifacts,
  writeCheckpoint,
  writeContext,
  writePendingAction,
} from '../../domains/engine/run-store.js';
import type { Checkpoint, EngineAction, RunState } from '../../domains/engine/types.js';

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const RESET = '\u001b[0m';

function green(message: string): string {
  return `${GREEN}${message}${RESET}`;
}

function red(message: string): string {
  return `${RED}${message}${RESET}`;
}

function yellow(message: string): string {
  return `${YELLOW}${message}${RESET}`;
}

class HandoffFailure extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

class HandoffOutput {
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];

  toResult(exitCode = 0): ClassicCommandResult {
    return {
      exitCode,
      ...(this.stdout.length > 0 ? { stdout: this.stdout.join('\n') + '\n' } : {}),
      ...(this.stderr.length > 0 ? { stderr: this.stderr.join('\n') + '\n' } : {}),
    };
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function nonempty(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function validateChangeName(name: string): void {
  const error = openSpecChangeNameError(name);
  if (error) throw new HandoffFailure(red(`ERROR: ${error}`));
}

function hashFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function hashText(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function artifactsHash(artifacts: Record<string, string>): string {
  return hashText(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(artifacts).sort(([left], [right]) => left.localeCompare(right)),
      ),
    ),
  );
}

// Forward-slash paths so hash inputs + markdown Source/SHA256 references match
// the frozen shell byte-for-byte. changeDir is relative (openspec/changes/<name>).
async function handoffSourceFiles(changeDir: string): Promise<string[]> {
  const files = [`${changeDir}/proposal.md`, `${changeDir}/design.md`, `${changeDir}/tasks.md`];
  const specs = `${changeDir}/specs`;
  if (await exists(specs)) {
    for (const entry of (await fs.readdir(specs)).sort()) {
      const spec = `${specs}/${entry}/spec.md`;
      if (await exists(spec)) files.push(spec);
    }
  }
  return files;
}

async function computeContextHash(changeDir: string): Promise<string> {
  const lines: string[] = [];
  for (const file of await handoffSourceFiles(changeDir)) {
    if (await exists(file)) {
      lines.push(`path:${file}`, `sha256:${hashFile(file)}`);
    }
  }
  // Command substitution $(...) strips the trailing newline; mirror that exactly.
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function jsonEscape(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

// wc -l counts newlines.
function lineCount(content: string): number {
  return (content.match(/\n/gu) ?? []).length;
}

// sed -n "1,${max}p": content up to and including the max-th newline.
function firstLines(content: string, max: number): string {
  let count = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') {
      count += 1;
      if (count === max) return content.slice(0, i + 1);
    }
  }
  return content;
}

async function writeMarkdownContext(
  changeDir: string,
  change: string,
  mode: string,
  contextHash: string,
  output: string,
): Promise<void> {
  const lines: string[] = [
    '# Comet Design Handoff',
    '',
    `- Change: ${change}`,
    '- Phase: design',
    `- Mode: ${mode}`,
    `- Context hash: ${contextHash}`,
    '',
    'Generated-by: comet-handoff.sh',
    '',
    'OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.',
    '',
  ];
  for (const file of await handoffSourceFiles(changeDir)) {
    if (!(await exists(file))) continue;
    const content = await fs.readFile(file, 'utf8');
    const total = lineCount(content);
    lines.push(
      `## ${file}`,
      '',
      `- Source: ${file}`,
      `- Lines: 1-${total}`,
      `- SHA256: ${hashFile(file)}`,
      '',
    );
    if (mode === 'full' || total <= 80) {
      lines.push('```md', content, '```');
    } else {
      lines.push(
        '[TRUNCATED]',
        '',
        '```md',
        firstLines(content, 80),
        '```',
        '',
        `Full source: ${file}`,
      );
    }
    lines.push('');
  }
  await fs.writeFile(output, lines.join('\n'));
}

async function writeJsonContext(
  changeDir: string,
  change: string,
  mode: string,
  contextHash: string,
  output: string,
): Promise<void> {
  const entries: string[] = [];
  for (const file of await handoffSourceFiles(changeDir)) {
    if (!(await exists(file))) continue;
    entries.push(`    { "path": "${jsonEscape(file)}", "sha256": "${hashFile(file)}" }`);
  }
  const filesBlock = entries.join(',\n');
  const document = [
    '{',
    `  "change": "${jsonEscape(change)}",`,
    '  "phase": "design",',
    `  "mode": "${mode}",`,
    '  "canonical_spec": "openspec",',
    '  "generated_by": "comet-handoff.sh",',
    `  "context_hash": "${contextHash}",`,
    '  "files": [',
    filesBlock,
    '  ]',
    '}',
    '',
  ].join('\n');
  await fs.writeFile(output, document);
}

async function writeSpecProjectionForFile(file: string, content: string): Promise<string[]> {
  return [
    `## ${file}`,
    '',
    `- Source: ${file}`,
    `- Lines: 1-${lineCount(content)}`,
    `- SHA256: ${hashFile(file)}`,
    '',
    '```md',
    content,
    '```',
    '',
  ];
}

async function writeSpecMarkdownContext(
  changeDir: string,
  change: string,
  contextHash: string,
  output: string,
): Promise<void> {
  const lines: string[] = [
    '# Comet Spec Context',
    '',
    `- Change: ${change}`,
    '- Phase: design',
    '- Mode: beta',
    `- Context hash: ${contextHash}`,
    '',
    'Generated-by: comet-handoff.sh',
    '',
    'OpenSpec remains the canonical capability spec. This beta context pack verbatim-projects spec files and references supporting artifacts by hash, not an agent-authored summary.',
    '',
    '## Source References',
    '',
  ];
  for (const file of await handoffSourceFiles(changeDir)) {
    if (!(await exists(file))) continue;
    lines.push(`- Source: ${file}`, `- SHA256: ${hashFile(file)}`);
  }
  lines.push('', '## Acceptance Projection', '');
  const specs = `${changeDir}/specs`;
  let projected = false;
  if (await exists(specs)) {
    for (const entry of (await fs.readdir(specs)).sort()) {
      const spec = `${specs}/${entry}/spec.md`;
      if (!(await exists(spec))) continue;
      projected = true;
      lines.push(...(await writeSpecProjectionForFile(spec, await fs.readFile(spec, 'utf8'))));
    }
  }
  if (!projected) {
    lines.push('No delta spec files found.', '');
  }
  lines.push(
    'Full source files remain canonical. If a required heading or scenario is missing here, regenerate the handoff or read the source spec directly. Supporting files (proposal, design, tasks) are referenced by hash only.',
  );
  await fs.writeFile(output, lines.join('\n'));
}

async function writeSpecJsonContext(
  changeDir: string,
  change: string,
  contextHash: string,
  output: string,
): Promise<void> {
  const entries: Array<{ path: string; sha256: string; role: 'spec' | 'supporting' }> = [];
  for (const file of await handoffSourceFiles(changeDir)) {
    if (!(await exists(file))) continue;
    const role = /\/specs\/[^/]+\/spec\.md$/u.test(file) ? 'spec' : 'supporting';
    entries.push({ path: file, sha256: hashFile(file), role });
  }
  await fs.writeFile(
    output,
    `${JSON.stringify(
      {
        change,
        phase: 'design',
        mode: 'beta',
        canonical_spec: 'openspec',
        generated_by: 'comet-handoff.sh',
        context_hash: contextHash,
        files: entries,
      },
      null,
      2,
    )}\n`,
  );
}

async function readField(changeDir: string, field: string): Promise<string> {
  const file = path.join(changeDir, '.comet.yaml');
  const document = parseDocument(await fs.readFile(file, 'utf8'), { uniqueKeys: false });
  if (document.errors.length > 0) {
    throw new HandoffFailure(`ERROR: Invalid .comet.yaml: ${document.errors[0].message}`);
  }
  const record = document.toJS() as Record<string, unknown>;
  const value = record[field];
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function appendRecoveryEvent(
  changeDir: string,
  run: RunState,
  actionId: string,
): Promise<void> {
  const trajectory = await readTrajectory(changeDir, run.trajectoryRef);
  const alreadyRecorded = trajectory.some(
    (event) =>
      event.type === 'recovery_reconciled' &&
      event.data.kind === 'classic-handoff' &&
      event.data.actionId === actionId,
  );
  if (alreadyRecorded) return;
  await appendTrajectory(changeDir, run.trajectoryRef, {
    sequence: trajectory.length + 1,
    timestamp: new Date().toISOString(),
    type: 'recovery_reconciled',
    runId: run.runId,
    data: {
      kind: 'classic-handoff',
      actionId,
    },
  });
}

async function completedHandoffIsCurrent(
  changeDir: string,
  run: RunState,
  contextHash: string,
  contextJson: string,
  contextMd: string,
): Promise<boolean> {
  const [context, artifacts, checkpoint] = await Promise.all([
    readContext(changeDir, run.contextRef),
    readArtifacts(changeDir, run.artifactsRef),
    readCheckpoint(changeDir, run.checkpointRef),
  ]);
  if (!(await exists(contextJson)) || !(await exists(contextMd))) return false;
  if (context !== (await fs.readFile(contextMd, 'utf8'))) return false;
  if (artifacts.handoff_context !== contextJson || artifacts.handoff_markdown !== contextMd) {
    return false;
  }
  return (
    checkpoint?.runId === run.runId &&
    checkpoint.contextHash === (context === null ? null : hashText(context)) &&
    checkpoint.artifactsHash === artifactsHash(artifacts) &&
    contextHash.length === 64
  );
}

export const classicHandoffCommand: ClassicCommandHandler = async (args) => {
  const output = new HandoffOutput();
  const [change, phase, mode, fullFlag] = args;
  try {
    validateChangeName(change);
    const { directory: changeDir, label } = await resolveClassicChangeDirectory(change);

    if (phase === '--hash-only') {
      if (!(await exists(changeDir))) {
        throw new HandoffFailure(red(`ERROR: change directory not found: ${label}`));
      }
      for (const required of ['proposal.md', 'design.md', 'tasks.md']) {
        if (!(await nonempty(`${changeDir}/${required}`))) {
          throw new HandoffFailure(
            red(`ERROR: required file missing or empty: ${label}/${required}`),
          );
        }
      }
      output.stdout.push(await computeContextHash(label));
      return output.toResult(0);
    }

    if (phase !== 'design' || mode !== '--write') {
      throw new HandoffFailure(
        red('Usage: comet-handoff.mjs <change-name> design --write [--full]'),
      );
    }
    let handoffMode: string;
    if (fullFlag === undefined || fullFlag === '') handoffMode = 'compact';
    else if (fullFlag === '--full') handoffMode = 'full';
    else
      throw new HandoffFailure(
        red('Usage: comet-handoff.mjs <change-name> design --write [--full]'),
      );

    const yaml = `${changeDir}/.comet.yaml`;
    if (!(await exists(changeDir))) {
      throw new HandoffFailure(red(`ERROR: change directory not found: ${label}`));
    }
    if (!(await exists(yaml))) {
      throw new HandoffFailure(red(`ERROR: .comet.yaml not found at ${label}/.comet.yaml`));
    }
    if ((await readField(changeDir, 'phase')) !== 'design') {
      throw new HandoffFailure(red('ERROR: design handoff requires phase: design'));
    }
    for (const required of ['proposal.md', 'design.md', 'tasks.md']) {
      if (!(await nonempty(`${changeDir}/${required}`))) {
        throw new HandoffFailure(
          red(`ERROR: required OpenSpec artifact missing or empty: ${label}/${required}`),
        );
      }
    }

    const handoffDir = `${changeDir}/.comet/handoff`;
    const contextCompression = (await readField(changeDir, 'context_compression')) || 'off';
    let contextJson: string;
    let contextMd: string;
    if (contextCompression === 'off') {
      contextJson = `${label}/.comet/handoff/design-context.json`;
      contextMd = `${label}/.comet/handoff/design-context.md`;
    } else if (contextCompression === 'beta') {
      if (handoffMode === 'full') {
        output.stderr.push(
          yellow('[HANDOFF] --full is ignored in beta mode; spec files are projected verbatim'),
        );
      }
      handoffMode = 'beta';
      contextJson = `${label}/.comet/handoff/spec-context.json`;
      contextMd = `${label}/.comet/handoff/spec-context.md`;
    } else {
      throw new HandoffFailure(
        [
          red(`ERROR: invalid context_compression: ${contextCompression}`),
          red('Valid values: off, beta'),
        ].join('\n'),
      );
    }
    const contextHash = await computeContextHash(label);
    const actionId = `classic-handoff:${contextHash}`;
    const initialProjection = await readClassicState(changeDir);
    if (!initialProjection.classic) {
      throw new HandoffFailure(red('ERROR: design handoff requires Classic state'));
    }
    const initialPending = initialProjection.run
      ? await readPendingAction(changeDir, initialProjection.run.pendingRef)
      : null;
    const recovering =
      initialPending?.id === actionId &&
      initialPending.type === 'handoff' &&
      initialPending.ref === contextHash;
    if (
      initialProjection.classic.handoffHash &&
      initialProjection.classic.handoffHash !== contextHash &&
      !recovering
    ) {
      throw new HandoffFailure(
        red(
          `ERROR: stale handoff detected: source hash ${contextHash} does not match completed hash ${initialProjection.classic.handoffHash}`,
        ),
      );
    }

    const runtime = await ensureClassicRuntimeRun(changeDir);
    const pendingAction = await readPendingAction(changeDir, runtime.run.pendingRef);
    const resumesPending =
      pendingAction?.id === actionId &&
      pendingAction.type === 'handoff' &&
      pendingAction.ref === contextHash;
    if (runtime.run.pending && runtime.run.pending !== actionId) {
      throw new HandoffFailure(red(`ERROR: another action is pending: ${runtime.run.pending}`));
    }
    if (
      runtime.classic.handoffHash === contextHash &&
      runtime.classic.handoffContext === contextJson &&
      !runtime.run.pending &&
      !pendingAction &&
      (await completedHandoffIsCurrent(changeDir, runtime.run, contextHash, contextJson, contextMd))
    ) {
      output.stderr.push(green(`[HANDOFF] wrote ${contextJson}`));
      output.stderr.push(green(`[HANDOFF] wrote ${contextMd}`));
      output.stderr.push(green(`[HANDOFF] handoff_hash=${contextHash}`));
      return output.toResult(0);
    }

    const action: EngineAction = {
      id: actionId,
      stepId: runtime.run.currentStep,
      type: 'handoff',
      ref: contextHash,
    };
    await writePendingAction(changeDir, runtime.run.pendingRef, action);
    const pendingRun: RunState = {
      ...runtime.run,
      pending: actionId,
      status: 'waiting',
    };
    await writeClassicState(changeDir, {
      classic: runtime.classic,
      run: pendingRun,
      unknownKeys: (await readClassicState(changeDir)).unknownKeys,
    });

    await fs.mkdir(handoffDir, { recursive: true });
    if (handoffMode === 'beta') {
      await writeSpecMarkdownContext(label, change, contextHash, contextMd);
      await writeSpecJsonContext(label, change, contextHash, contextJson);
    } else {
      await writeMarkdownContext(label, change, handoffMode, contextHash, contextMd);
      await writeJsonContext(label, change, handoffMode, contextHash, contextJson);
    }

    const context = await fs.readFile(contextMd, 'utf8');
    await writeContext(changeDir, pendingRun.contextRef, context);
    const artifacts = {
      ...(await readArtifacts(changeDir, pendingRun.artifactsRef)),
      handoff_context: contextJson,
      handoff_markdown: contextMd,
    };
    await writeArtifacts(changeDir, pendingRun.artifactsRef, artifacts);
    const completedClassic = {
      ...runtime.classic,
      handoffContext: contextJson,
      handoffHash: contextHash,
    };
    const transitionedRun =
      pendingRun.currentStep === 'full.design.handoff'
        ? await transitionClassicRuntimeRun(changeDir, completedClassic, pendingRun, {
            actionId,
            kind: 'classic-handoff',
          })
        : pendingRun;
    const completedRun: RunState = {
      ...transitionedRun,
      pending: null,
      status: 'running',
    };
    if (recovering || resumesPending) {
      await appendRecoveryEvent(changeDir, completedRun, actionId);
    }
    const trajectory = await readTrajectory(changeDir, completedRun.trajectoryRef);
    const checkpoint: Checkpoint = {
      runId: completedRun.runId,
      stateVersion: completedRun.iteration,
      trajectoryOffset: trajectory.length,
      contextHash: hashText(context),
      artifactsHash: artifactsHash(artifacts),
      createdAt: new Date().toISOString(),
    };
    await writeCheckpoint(changeDir, completedRun.checkpointRef, checkpoint);
    await writeClassicState(changeDir, {
      classic: completedClassic,
      run: completedRun,
      unknownKeys: (await readClassicState(changeDir)).unknownKeys,
    });
    await clearPendingAction(changeDir, completedRun.pendingRef);

    output.stderr.push(green(`[SET] handoff_context=${contextJson}`));
    output.stderr.push(green(`[SET] handoff_hash=${contextHash}`));

    output.stderr.push(green(`[HANDOFF] wrote ${contextJson}`));
    output.stderr.push(green(`[HANDOFF] wrote ${contextMd}`));
    output.stderr.push(green(`[HANDOFF] handoff_hash=${contextHash}`));
    return output.toResult(0);
  } catch (error) {
    if (error instanceof HandoffFailure) {
      for (const line of error.message.split('\n')) output.stderr.push(line);
      return output.toResult(error.exitCode);
    }
    throw error;
  }
};
