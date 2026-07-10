import type {
  WorkflowDefinitionInput,
  WorkflowNodeTemplate,
  WorkflowOutputSchema,
} from './types.js';

export const BUILTIN_COMET_OUTPUT_SCHEMAS: WorkflowOutputSchema[] = [
  {
    id: 'comet.intake.v1',
    description: 'Comet change intake and initial state.',
    artifacts: [
      {
        id: 'comet-state',
        kind: 'state',
        required: true,
        paths: ['openspec/changes/*/.comet.yaml', 'docs/openspec/changes/*/.comet.yaml'],
        validations: ['state-transition'],
      },
    ],
    evidence: [{ id: 'intake-summary', required: true }],
  },
  {
    id: 'comet.design.v1',
    description: 'Comet design artifacts and OpenSpec delta context.',
    artifacts: [
      {
        id: 'design-doc',
        kind: 'file',
        required: true,
        paths: ['docs/superpowers/specs/*.md'],
        validations: ['artifact-exists', 'artifact-structured'],
      },
      {
        id: 'delta-spec',
        kind: 'file',
        required: true,
        paths: ['openspec/changes/*/specs/*/spec.md', 'docs/openspec/changes/*/specs/*/spec.md'],
        validations: ['artifact-exists', 'artifact-structured'],
      },
    ],
    evidence: [
      { id: 'design-summary', required: true },
      { id: 'user-confirmation', required: true },
    ],
  },
  {
    id: 'comet.plan.v1',
    description: 'Comet executable implementation plan.',
    artifacts: [
      {
        id: 'implementation-plan',
        kind: 'file',
        required: true,
        paths: ['docs/superpowers/plans/*.md'],
        validations: ['artifact-exists', 'artifact-structured'],
      },
      {
        id: 'openspec-tasks',
        kind: 'file',
        required: false,
        paths: ['openspec/changes/*/tasks.md', 'docs/openspec/changes/*/tasks.md'],
        validations: ['artifact-exists', 'artifact-structured'],
      },
    ],
    evidence: [{ id: 'producer-summary', required: true }],
  },
  {
    id: 'comet.execution-evidence.v1',
    description: 'Comet build execution evidence and task completion.',
    artifacts: [
      {
        id: 'task-state',
        kind: 'file',
        required: true,
        paths: ['openspec/changes/*/tasks.md', 'docs/openspec/changes/*/tasks.md'],
        validations: ['artifact-structured', 'semantic'],
      },
    ],
    evidence: [
      { id: 'implementation-summary', required: true },
      { id: 'test-evidence', required: true },
    ],
  },
  {
    id: 'comet.handoff.v1',
    description: 'Subagent handoff request and returned evidence.',
    artifacts: [],
    evidence: [
      { id: 'handoff-request', required: true },
      { id: 'handoff-result', required: true },
    ],
  },
  {
    id: 'comet.review.v1',
    description: 'Review or whitebox rule report.',
    artifacts: [],
    evidence: [
      { id: 'review-summary', required: true },
      { id: 'review-blockers', required: false },
    ],
  },
  {
    id: 'comet.verify.v1',
    description: 'Comet verification evidence and branch handling.',
    artifacts: [],
    evidence: [
      { id: 'verification-commands', required: true },
      { id: 'verification-result', required: true },
    ],
  },
  {
    id: 'comet.archive.v1',
    description: 'OpenSpec archive and delta sync result.',
    artifacts: [],
    evidence: [
      { id: 'archive-summary', required: true },
      { id: 'archived-state', required: true },
    ],
  },
];

export const COMET_FIVE_PHASE_NODES: WorkflowNodeTemplate[] = [
  {
    id: 'open',
    label: 'Open',
    kind: 'control',
    responsibility: 'Intake the user request, choose the change shape, and initialize Comet state.',
    implementation: { skill: 'comet-open', operation: 'default', scope: 'main' },
    operations: ['require', 'augment'],
    outputSchemas: ['comet.intake.v1'],
    guardrails: [
      { id: 'comet-state-created', label: '.comet.yaml exists', validation: 'state-transition' },
    ],
  },
  {
    id: 'design',
    label: 'Design',
    kind: 'producer',
    responsibility: 'Turn the confirmed request into design artifacts and OpenSpec delta context.',
    implementation: { skill: 'comet-design', operation: 'default', scope: 'main' },
    operations: ['require', 'augment', 'override'],
    outputSchemas: ['comet.design.v1'],
    guardrails: [
      {
        id: 'design-artifacts',
        label: 'Design artifacts exist',
        validation: 'artifact-structured',
      },
    ],
  },
  {
    id: 'plan',
    label: 'Plan',
    kind: 'producer',
    responsibility: 'Create the executable implementation plan and task contract.',
    implementation: { skill: 'comet-build', operation: 'default', scope: 'main' },
    operations: ['require', 'augment', 'override'],
    outputSchemas: ['comet.plan.v1'],
    guardrails: [
      { id: 'plan-artifacts', label: 'Plan artifacts exist', validation: 'artifact-structured' },
    ],
  },
  {
    id: 'execute',
    label: 'Execute',
    kind: 'control',
    responsibility: 'Apply the implementation plan through direct coordinator execution.',
    implementation: { skill: 'comet-build', operation: 'default', scope: 'main' },
    operations: ['require', 'augment'],
    outputSchemas: ['comet.execution-evidence.v1'],
    guardrails: [
      { id: 'build-complete', label: 'Build evidence recorded', validation: 'semantic' },
    ],
  },
  {
    id: 'subagent-execute',
    label: 'Subagent Execute',
    kind: 'handoff',
    responsibility: 'Delegate implementation work and require auditable returned evidence.',
    implementation: {
      skill: 'subagent-driven-development',
      operation: 'default',
      scope: 'handoff',
    },
    operations: ['require', 'augment'],
    outputSchemas: ['comet.handoff.v1'],
    guardrails: [
      { id: 'handoff-evidence', label: 'Handoff evidence recorded', validation: 'evidence-only' },
    ],
  },
  {
    id: 'review',
    label: 'Review',
    kind: 'guardrail',
    responsibility: 'Inspect the implementation with review Skills before verification.',
    optional: true,
    implementation: { skill: 'requesting-code-review', operation: 'default', scope: 'review' },
    operations: ['require', 'augment', 'disable'],
    outputSchemas: ['comet.review.v1'],
    guardrails: [
      { id: 'review-evidence', label: 'Review evidence recorded', validation: 'evidence-only' },
    ],
  },
  {
    id: 'verify',
    label: 'Verify',
    kind: 'control',
    responsibility:
      'Run verification, reconcile branch state, and decide whether completion is valid.',
    implementation: { skill: 'comet-verify', operation: 'default', scope: 'main' },
    operations: ['require', 'augment'],
    outputSchemas: ['comet.verify.v1'],
    guardrails: [
      { id: 'verify-result', label: 'Verification result recorded', validation: 'evidence-only' },
    ],
  },
  {
    id: 'archive',
    label: 'Archive',
    kind: 'control',
    responsibility: 'Archive the OpenSpec change and sync completed deltas back to the main specs.',
    implementation: { skill: 'comet-archive', operation: 'default', scope: 'main' },
    operations: ['require', 'augment'],
    outputSchemas: ['comet.archive.v1'],
    guardrails: [
      { id: 'archive-state', label: 'Archive state recorded', validation: 'state-transition' },
    ],
  },
];

export function builtinCometFivePhaseWorkflow(options: {
  name: string;
  goal: string;
}): WorkflowDefinitionInput {
  return {
    kind: 'comet-five-phase-overlay',
    name: options.name,
    goal: options.goal,
  };
}
