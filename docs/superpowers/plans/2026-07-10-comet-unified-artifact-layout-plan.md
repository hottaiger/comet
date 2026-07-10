# Comet Unified Artifact Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a docs-based Comet artifact layout that places OpenSpec under `docs/openspec`, keeps Superpowers under `docs/superpowers`, and preserves legacy `openspec/` compatibility.

**Architecture:** Add one layout resolver as the source of truth, then route Classic runtime, CLI commands, dashboard, hook guard, Skill guidance, migration, and eval through it. OpenSpec keeps its own store model; Comet stores and passes the selected store id instead of building a separate registry.

**Tech Stack:** TypeScript, Node.js 20, Commander, YAML, Vitest, esbuild, OpenSpec CLI `@fission-ai/openspec@1.5.0`.

## Global Constraints

- Do not modify original Superpowers or OpenSpec upstream Skills.
- OpenSpec docs layout means OpenSpec store root is `docs`, producing `docs/openspec/...`.
- Legacy projects using root `openspec/` must continue to work.
- `.comet/config.yaml` is local state and may be absent after clone.
- Change `.comet.yaml` must snapshot layout fields but must not snapshot machine-local OpenSpec store id.
- Migration defaults to dry-run and must not overwrite user files.
- Active change migration defaults to blocked because handoff hashes include path strings.
- Skill content changes must be done Chinese first, then English.
- After Classic runtime source changes, run `pnpm build:classic-runtime`.
- Use direct `node` and `npx vitest` commands when `pnpm` wrappers fail in local Windows.
- Keep unrelated working tree changes out of each commit.

---

## File Map

Create:

- `domains/comet-classic/classic-artifact-layout.ts`: resolver for legacy/docs layout, path helpers, and OpenSpec command targeting.
- `test/domains/comet-classic/classic-artifact-layout.test.ts`: resolver and path-conflict coverage.
- `app/commands/openspec.ts`: Comet OpenSpec facade command.
- `test/app/openspec-command.test.ts`: facade command coverage with mocked process execution.
- `app/commands/migrate-docs.ts`: dry-run-first docs layout migration command.
- `test/app/migrate-docs.test.ts`: migration dry-run, conflict, and repair-store coverage.

Modify:

- `app/cli/index.ts`: add `comet openspec` and `comet migrate docs` commands plus init layout options.
- `app/commands/init.ts`: pass artifact layout and store options into working directory creation.
- `app/commands/resume-probe.ts`: use resolver-backed project language and resume discovery.
- `app/commands/status.ts`, `app/commands/doctor.ts`: report layout and store health.
- `app/commands/i18n.ts`: add layout, migration, and repair text.
- `domains/skill/platform-install.ts`: render layout config, create docs layout dirs, and ignore local OpenSpec store metadata.
- `domains/integrations/openspec.ts`: add store setup/register/doctor helper functions.
- `domains/comet-classic/classic-paths.ts`: resolve active/archive change dirs across layouts.
- `domains/comet-classic/classic-state.ts`: add layout snapshot fields to Classic state.
- `domains/comet-classic/classic-state-command.ts`: validate and set new fields.
- `domains/comet-classic/classic-validate-command.ts`: recognize and validate new fields.
- `domains/comet-classic/classic-store.ts`: preserve layout fields during read/write migration.
- `domains/comet-classic/classic-resume-probe.ts`: discover active changes through resolver.
- `domains/comet-classic/classic-handoff.ts`: write handoff under resolved change dir.
- `domains/comet-classic/classic-evidence.ts`: resolve project root through resolver, not by walking to `openspec`.
- `domains/comet-classic/classic-archive.ts`: invoke OpenSpec through resolver/facade and verify resolved specs dir.
- `domains/comet-classic/classic-hook-guard.ts`: guard `docs/openspec/changes` precisely.
- `domains/dashboard/collector.ts`: collect changes from resolved layouts and keep project root fixed.
- `domains/dashboard/types.ts`: include optional layout metadata on change items.
- `domains/workflow-contract/builtins.ts`, `domains/workflow-contract/normalize.ts`: support docs layout state paths.
- `config/repository-layout.json`, `scripts/lint/architecture.mjs`, `.gitignore`: account for `docs/.openspec-store/` if local metadata is ignored.
- `scripts/build/build-classic-runtime.mjs`: only if runtime entry/output wiring changes.
- `assets/skills-zh/**`, `assets/skills/**`: replace fixed OpenSpec paths with layout-aware guidance.
- `eval/local/**`, `eval/scaffold/**`: add docs-layout treatment and validation support.
- `CHANGELOG.md`: add final user-facing release entry after implementation scope is known.

---

### Task 1: Layout Resolver Foundation

**Files:**
- Create: `domains/comet-classic/classic-artifact-layout.ts`
- Create: `test/domains/comet-classic/classic-artifact-layout.test.ts`
- Modify: `domains/comet-classic/classic-paths.ts`

**Interfaces:**
- Produces:
  - `type CometArtifactLayoutKind = 'legacy' | 'docs'`
  - `interface CometArtifactLayout`
  - `resolveCometArtifactLayout(projectRoot: string, options?: ResolveCometArtifactLayoutOptions): Promise<CometArtifactLayout>`
  - `resolveCometChangeDirectory(projectRoot: string, name: string, options?: ResolveCometChangeDirectoryOptions): Promise<ClassicChangeDirectory>`
  - `projectRelativePath(projectRoot: string, absolutePath: string): string`
- Consumes:
  - Existing `openSpecChangeNameError()` from `classic-paths.ts`
  - YAML config files under `.comet/config.yaml` and change `.comet.yaml`

- [ ] **Step 1: Write failing resolver tests**

Add `test/domains/comet-classic/classic-artifact-layout.test.ts` with these cases:

```ts
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveCometArtifactLayout,
  resolveCometChangeDirectory,
} from '../../../domains/comet-classic/classic-artifact-layout.js';

const roots: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'comet-layout-'));
  roots.push(dir);
  return dir;
}

async function healthyOpenSpecRoot(root: string, relativeRoot: string): Promise<void> {
  const base = path.join(root, relativeRoot, 'openspec');
  await mkdir(path.join(base, 'changes', 'archive'), { recursive: true });
  await mkdir(path.join(base, 'specs'), { recursive: true });
  await writeFile(path.join(base, 'config.yaml'), 'schema: spec-driven\n', 'utf8');
}

afterEach(async () => {
  const { rm } = await import('fs/promises');
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resolveCometArtifactLayout', () => {
  it('defaults to legacy when no layout signal exists', async () => {
    const root = await tempProject();
    await expect(resolveCometArtifactLayout(root)).resolves.toMatchObject({
      layout: 'legacy',
      openSpec: {
        storeRoot: root,
        artifactRoot: path.join(root, 'openspec'),
        changesDir: path.join(root, 'openspec', 'changes'),
      },
    });
  });

  it('uses .comet/config.yaml artifact_layout when present', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, '.comet'), { recursive: true });
    await writeFile(
      path.join(root, '.comet', 'config.yaml'),
      'artifact_layout: docs\nopenspec:\n  root: docs\n  store: comet-demo-1234\n',
      'utf8',
    );
    await expect(resolveCometArtifactLayout(root)).resolves.toMatchObject({
      layout: 'docs',
      openSpec: {
        storeId: 'comet-demo-1234',
        storeRoot: path.join(root, 'docs'),
        artifactRoot: path.join(root, 'docs', 'openspec'),
        changesDir: path.join(root, 'docs', 'openspec', 'changes'),
        commandArgs: ['--store', 'comet-demo-1234'],
      },
    });
  });

  it('detects docs layout from healthy docs/openspec when local config is absent', async () => {
    const root = await tempProject();
    await healthyOpenSpecRoot(root, 'docs');
    await expect(resolveCometArtifactLayout(root)).resolves.toMatchObject({
      layout: 'docs',
      openSpec: {
        commandCwd: path.join(root, 'docs'),
        commandArgs: [],
      },
    });
  });

  it('fails closed when docs and legacy both have active changes without config', async () => {
    const root = await tempProject();
    await healthyOpenSpecRoot(root, '.');
    await healthyOpenSpecRoot(root, 'docs');
    await mkdir(path.join(root, 'openspec', 'changes', 'legacy-active'), { recursive: true });
    await writeFile(path.join(root, 'openspec', 'changes', 'legacy-active', '.comet.yaml'), 'phase: open\n', 'utf8');
    await mkdir(path.join(root, 'docs', 'openspec', 'changes', 'docs-active'), { recursive: true });
    await writeFile(path.join(root, 'docs', 'openspec', 'changes', 'docs-active', '.comet.yaml'), 'phase: open\n', 'utf8');

    await expect(resolveCometArtifactLayout(root)).rejects.toThrow(/multiple artifact layouts/i);
  });

  it('resolves active and archive change directories in docs layout', async () => {
    const root = await tempProject();
    await healthyOpenSpecRoot(root, 'docs');
    await mkdir(path.join(root, 'docs', 'openspec', 'changes', 'add-auth'), { recursive: true });
    await writeFile(path.join(root, 'docs', 'openspec', 'changes', 'add-auth', '.comet.yaml'), 'phase: open\n', 'utf8');

    await expect(resolveCometChangeDirectory(root, 'add-auth')).resolves.toMatchObject({
      label: 'docs/openspec/changes/add-auth',
      directory: path.join(root, 'docs', 'openspec', 'changes', 'add-auth'),
      layout: 'docs',
    });
  });
});
```

- [ ] **Step 2: Run resolver tests to verify failure**

Run:

```bash
npx vitest run test/domains/comet-classic/classic-artifact-layout.test.ts
```

Expected: FAIL because `classic-artifact-layout.ts` does not exist.

- [ ] **Step 3: Implement resolver**

Create `domains/comet-classic/classic-artifact-layout.ts`:

```ts
import { promises as fs } from 'fs';
import path from 'path';
import { parseDocument } from 'yaml';
import type { ClassicChangeDirectory } from './classic-paths.js';

export type CometArtifactLayoutKind = 'legacy' | 'docs';

export interface CometArtifactLayout {
  projectRoot: string;
  layout: CometArtifactLayoutKind;
  openSpec: {
    storeId?: string;
    storeRoot: string;
    artifactRoot: string;
    changesDir: string;
    specsDir: string;
    archiveDir: string;
    commandArgs: string[];
    commandCwd: string;
  };
  superpowers: {
    root: string;
    specsDir: string;
    plansDir: string;
    reportsDir: string;
  };
}

export interface ResolveCometArtifactLayoutOptions {
  explicitLayout?: CometArtifactLayoutKind;
}

export interface ResolveCometChangeDirectoryOptions extends ResolveCometArtifactLayoutOptions {}

export interface ResolvedClassicChangeDirectory extends ClassicChangeDirectory {
  layout: CometArtifactLayoutKind;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readYamlRecord(file: string): Promise<Record<string, unknown>> {
  if (!(await exists(file))) return {};
  const document = parseDocument(await fs.readFile(file, 'utf8'));
  if (document.errors.length > 0) return {};
  const value = document.toJS();
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nestedString(record: Record<string, unknown>, key: string, nested: string): string | undefined {
  const value = record[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const nestedValue = (value as Record<string, unknown>)[nested];
  return typeof nestedValue === 'string' && nestedValue.trim() ? nestedValue.trim() : undefined;
}

function safeRelativePath(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (/^(?:[A-Za-z]:|[\\/]|~)/u.test(value)) return fallback;
  if (value.split(/[\\/]/u).includes('..')) return fallback;
  return value.replaceAll('\\', '/').replace(/^\/+/u, '').replace(/\/+$/u, '');
}

async function isHealthyOpenSpecRoot(projectRoot: string, storeRootRelative: string): Promise<boolean> {
  const storeRoot = path.join(projectRoot, ...storeRootRelative.split('/').filter(Boolean));
  const openSpecRoot = path.join(storeRoot, 'openspec');
  const hasConfig =
    (await exists(path.join(openSpecRoot, 'config.yaml'))) ||
    (await exists(path.join(openSpecRoot, 'config.yml')));
  return (
    hasConfig &&
    (await exists(path.join(openSpecRoot, 'changes'))) &&
    (await exists(path.join(openSpecRoot, 'specs')))
  );
}

async function hasActiveChange(projectRoot: string, storeRootRelative: string): Promise<boolean> {
  const changesDir = path.join(projectRoot, ...storeRootRelative.split('/').filter(Boolean), 'openspec', 'changes');
  if (!(await exists(changesDir))) return false;
  for (const entry of await fs.readdir(changesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'archive') continue;
    if (await exists(path.join(changesDir, entry.name, '.comet.yaml'))) return true;
  }
  return false;
}

async function configuredLayout(projectRoot: string): Promise<{
  layout?: CometArtifactLayoutKind;
  openspecRoot?: string;
  openspecStore?: string;
  superpowersRoot?: string;
}> {
  const config = await readYamlRecord(path.join(projectRoot, '.comet', 'config.yaml'));
  const rawLayout = config.artifact_layout;
  const layout = rawLayout === 'docs' || rawLayout === 'legacy' ? rawLayout : undefined;
  return {
    layout,
    openspecRoot: safeRelativePath(nestedString(config, 'openspec', 'root'), layout === 'docs' ? 'docs' : '.'),
    openspecStore: nestedString(config, 'openspec', 'store'),
    superpowersRoot: safeRelativePath(nestedString(config, 'superpowers', 'root'), 'docs/superpowers'),
  };
}

function buildLayout(
  projectRoot: string,
  layout: CometArtifactLayoutKind,
  options: { openspecRoot?: string; openspecStore?: string; superpowersRoot?: string } = {},
): CometArtifactLayout {
  const openspecRoot = safeRelativePath(options.openspecRoot, layout === 'docs' ? 'docs' : '.');
  const storeRoot = openspecRoot === '.' ? projectRoot : path.join(projectRoot, ...openspecRoot.split('/'));
  const artifactRoot = path.join(storeRoot, 'openspec');
  const superpowersRootRelative = safeRelativePath(options.superpowersRoot, 'docs/superpowers');
  const superpowersRoot = path.join(projectRoot, ...superpowersRootRelative.split('/'));
  return {
    projectRoot,
    layout,
    openSpec: {
      ...(options.openspecStore ? { storeId: options.openspecStore } : {}),
      storeRoot,
      artifactRoot,
      changesDir: path.join(artifactRoot, 'changes'),
      specsDir: path.join(artifactRoot, 'specs'),
      archiveDir: path.join(artifactRoot, 'changes', 'archive'),
      commandArgs: options.openspecStore ? ['--store', options.openspecStore] : [],
      commandCwd: options.openspecStore ? projectRoot : storeRoot,
    },
    superpowers: {
      root: superpowersRoot,
      specsDir: path.join(superpowersRoot, 'specs'),
      plansDir: path.join(superpowersRoot, 'plans'),
      reportsDir: path.join(superpowersRoot, 'reports'),
    },
  };
}

export async function resolveCometArtifactLayout(
  projectRootInput: string,
  options: ResolveCometArtifactLayoutOptions = {},
): Promise<CometArtifactLayout> {
  const projectRoot = path.resolve(projectRootInput);
  const configured = await configuredLayout(projectRoot);
  const explicit = options.explicitLayout ?? configured.layout;
  if (explicit) {
    return buildLayout(projectRoot, explicit, {
      openspecRoot: configured.openspecRoot,
      openspecStore: configured.openspecStore,
      superpowersRoot: configured.superpowersRoot,
    });
  }

  const docsHealthy = await isHealthyOpenSpecRoot(projectRoot, 'docs');
  const legacyHealthy = await isHealthyOpenSpecRoot(projectRoot, '.');
  if (docsHealthy && legacyHealthy) {
    const docsActive = await hasActiveChange(projectRoot, 'docs');
    const legacyActive = await hasActiveChange(projectRoot, '.');
    if (docsActive && legacyActive) {
      throw new Error(
        'Multiple artifact layouts contain active Comet changes. Configure artifact_layout or repair the project layout.',
      );
    }
    if (docsActive) return buildLayout(projectRoot, 'docs', { superpowersRoot: configured.superpowersRoot });
    if (legacyActive) return buildLayout(projectRoot, 'legacy', { superpowersRoot: configured.superpowersRoot });
    throw new Error(
      'Both docs and legacy OpenSpec roots exist. Pass --artifact-layout or configure .comet/config.yaml.',
    );
  }
  if (docsHealthy) return buildLayout(projectRoot, 'docs', { superpowersRoot: configured.superpowersRoot });
  return buildLayout(projectRoot, 'legacy', { superpowersRoot: configured.superpowersRoot });
}

function toPosixRelative(projectRoot: string, target: string): string {
  return path.relative(projectRoot, target).replaceAll('\\', '/');
}

async function resolveArchive(layout: CometArtifactLayout, name: string): Promise<ResolvedClassicChangeDirectory | null> {
  const exact = path.join(layout.openSpec.archiveDir, name);
  if (await exists(path.join(exact, '.comet.yaml'))) {
    return { label: toPosixRelative(layout.projectRoot, exact), directory: exact, layout: layout.layout };
  }
  if (!(await exists(layout.openSpec.archiveDir))) return null;
  const matches: string[] = [];
  for (const entry of await fs.readdir(layout.openSpec.archiveDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(`-${name}`)) continue;
    const candidate = path.join(layout.openSpec.archiveDir, entry.name);
    if (await exists(path.join(candidate, '.comet.yaml'))) matches.push(candidate);
  }
  const latest = matches.sort((left, right) => right.localeCompare(left))[0];
  return latest ? { label: toPosixRelative(layout.projectRoot, latest), directory: latest, layout: layout.layout } : null;
}

export async function resolveCometChangeDirectory(
  projectRoot: string,
  name: string,
  options: ResolveCometChangeDirectoryOptions = {},
): Promise<ResolvedClassicChangeDirectory> {
  const layout = await resolveCometArtifactLayout(projectRoot, options);
  const active = path.join(layout.openSpec.changesDir, name);
  if (await exists(active)) {
    return { label: toPosixRelative(layout.projectRoot, active), directory: active, layout: layout.layout };
  }
  const archived = await resolveArchive(layout, name);
  if (archived) return archived;
  return { label: toPosixRelative(layout.projectRoot, active), directory: active, layout: layout.layout };
}

export function projectRelativePath(projectRoot: string, absolutePath: string): string {
  return path.relative(path.resolve(projectRoot), path.resolve(absolutePath)).replaceAll('\\', '/');
}
```

- [ ] **Step 4: Wire `classic-paths.ts` to the resolver**

Replace `resolveClassicChangeDirectory(name)` internals with:

```ts
import { resolveCometChangeDirectory } from './classic-artifact-layout.js';

export async function resolveClassicChangeDirectory(name: string): Promise<ClassicChangeDirectory> {
  return resolveCometChangeDirectory(process.cwd(), name);
}
```

Keep `openSpecChangeNameError()` unchanged.

- [ ] **Step 5: Run resolver tests**

Run:

```bash
npx vitest run test/domains/comet-classic/classic-artifact-layout.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add domains/comet-classic/classic-artifact-layout.ts domains/comet-classic/classic-paths.ts test/domains/comet-classic/classic-artifact-layout.test.ts
git commit -m "feat: add Comet artifact layout resolver"
```

---

### Task 2: Classic State Layout Snapshot

**Files:**
- Modify: `domains/comet-classic/classic-state.ts`
- Modify: `domains/comet-classic/classic-state-command.ts`
- Modify: `domains/comet-classic/classic-validate-command.ts`
- Modify: `domains/comet-classic/classic-store.ts`
- Modify: `test/domains/comet-classic/classic-state.test.ts`
- Modify: `test/domains/comet-classic/comet-scripts.test.ts`

**Interfaces:**
- Consumes: `CometArtifactLayoutKind` from Task 1.
- Produces:
  - `ClassicState.artifactLayout: 'legacy' | 'docs' | null`
  - `ClassicState.openSpecRoot: string | null`
  - `ClassicState.superpowersRoot: string | null`
  - Wire keys `artifact_layout`, `openspec_root`, `superpowers_root`

- [ ] **Step 1: Write failing state tests**

Add tests to `test/domains/comet-classic/classic-state.test.ts`:

```ts
it('parses docs layout snapshot fields', () => {
  const projection = parseClassicStateDocument({
    workflow: 'full',
    phase: 'open',
    design_doc: null,
    plan: null,
    build_mode: null,
    isolation: null,
    verify_mode: null,
    verify_result: 'pending',
    verified_at: null,
    archived: false,
    artifact_layout: 'docs',
    openspec_root: 'docs',
    superpowers_root: 'docs/superpowers',
  });

  expect(projection.classic?.artifactLayout).toBe('docs');
  expect(projection.classic?.openSpecRoot).toBe('docs');
  expect(projection.classic?.superpowersRoot).toBe('docs/superpowers');
});

it('rejects invalid layout snapshot paths', () => {
  expect(() =>
    parseClassicStateDocument({
      workflow: 'full',
      phase: 'open',
      design_doc: null,
      plan: null,
      build_mode: null,
      isolation: null,
      verify_mode: null,
      verify_result: 'pending',
      verified_at: null,
      archived: false,
      artifact_layout: 'docs',
      openspec_root: '../docs',
      superpowers_root: 'docs/superpowers',
    }),
  ).toThrow(/openspec_root must be a relative repository path/);
});
```

Add a script-level test in `test/domains/comet-classic/comet-scripts.test.ts` that initializes a docs layout change after writing `.comet/config.yaml`:

```ts
await writeFile(
  path.join(tmpDir, '.comet', 'config.yaml'),
  'artifact_layout: docs\nopenspec:\n  root: docs\nsuperpowers:\n  root: docs/superpowers\n',
);
```

Expected `.comet.yaml` contains:

```yaml
artifact_layout: docs
openspec_root: docs
superpowers_root: docs/superpowers
```

- [ ] **Step 2: Run tests to verify failure**

```bash
npx vitest run test/domains/comet-classic/classic-state.test.ts test/domains/comet-classic/comet-scripts.test.ts
```

Expected: FAIL because wire fields are unknown or not written.

- [ ] **Step 3: Add state fields and validation**

Modify `domains/comet-classic/classic-state.ts`:

```ts
const ARTIFACT_LAYOUTS = ['legacy', 'docs'] as const;

export interface ClassicState {
  artifactLayout: (typeof ARTIFACT_LAYOUTS)[number] | null;
  openSpecRoot: string | null;
  superpowersRoot: string | null;
}

export const CLASSIC_WIRE_KEYS = [
  'artifact_layout',
  'openspec_root',
  'superpowers_root',
] as const;
```

Add the fields to `classicStateFromDocument()`:

```ts
artifactLayout: enumValue(doc, 'artifact_layout', ARTIFACT_LAYOUTS),
openSpecRoot: relativePath(doc, 'openspec_root'),
superpowersRoot: relativePath(doc, 'superpowers_root'),
```

Add them to `classicStateToDocument()` if that function is lower in the file:

```ts
artifact_layout: classic.artifactLayout,
openspec_root: classic.openSpecRoot,
superpowers_root: classic.superpowersRoot,
```

- [ ] **Step 4: Update state command field rules**

Modify `classic-state-command.ts`:

```ts
const FIELD_ENUMS: Record<string, readonly string[]> = {
  artifact_layout: ['legacy', 'docs'],
};

const PATH_FIELDS = new Set([
  'design_doc',
  'plan',
  'verification_report',
  'handoff_context',
  'openspec_root',
  'superpowers_root',
]);
```

When creating sparse state, set defaults from resolver:

```ts
const layout = await resolveCometArtifactLayout(process.cwd());
artifactLayout: layout.layout,
openSpecRoot: layout.layout === 'docs' ? 'docs' : null,
superpowersRoot: 'docs/superpowers',
```

- [ ] **Step 5: Update validate command**

Modify `classic-validate-command.ts`:

```ts
const ENUMS: Record<string, readonly string[]> = {
  artifact_layout: ['legacy', 'docs'],
};

for (const field of ['design_doc', 'plan', 'handoff_context', 'openspec_root', 'superpowers_root'] as const) {
  const value = text(record[field]);
  if (value && (/^(?:[A-Za-z]:|[\\/]|~)/u.test(value) || value.split(/[\\/]/u).includes('..'))) {
    fail(`${field}='${value}' must be a relative repository path`);
  }
}
```

Ensure `KNOWN_KEYS` includes the new wire keys through `CLASSIC_WIRE_KEYS`.

- [ ] **Step 6: Run state tests**

```bash
npx vitest run test/domains/comet-classic/classic-state.test.ts test/domains/comet-classic/comet-scripts.test.ts
```

Expected: PASS for new layout state tests. Existing failures must be fixed before commit.

- [ ] **Step 7: Commit**

```bash
git add domains/comet-classic/classic-state.ts domains/comet-classic/classic-state-command.ts domains/comet-classic/classic-validate-command.ts domains/comet-classic/classic-store.ts test/domains/comet-classic/classic-state.test.ts test/domains/comet-classic/comet-scripts.test.ts
git commit -m "feat: snapshot artifact layout in Classic state"
```

---

### Task 3: OpenSpec Facade and Store Helpers

**Files:**
- Create: `app/commands/openspec.ts`
- Create: `test/app/openspec-command.test.ts`
- Modify: `app/cli/index.ts`
- Modify: `domains/integrations/openspec.ts`

**Interfaces:**
- Consumes: `resolveCometArtifactLayout()`.
- Produces:
  - `openspecCommand(targetPath: string, args: string[], options?: { json?: boolean }): Promise<void>`
  - `buildOpenSpecStoreSetupInvocation(projectPath: string, storeId: string): { command: string; args: string[] }`
  - `buildOpenSpecStoreRegisterInvocation(projectPath: string, storeId: string): { command: string; args: string[] }`

- [ ] **Step 1: Write failing facade tests**

Create `test/app/openspec-command.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '{"ok":true}\n', stderr: '' })),
}));

import { spawnSync } from 'child_process';
import { openspecCommand } from '../../app/commands/openspec.js';

const roots: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'comet-openspec-command-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import('fs/promises');
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
    await writeFile(path.join(root, 'docs', 'openspec', 'config.yaml'), 'schema: spec-driven\n', 'utf8');

    await openspecCommand(root, ['list'], {});

    expect(spawnSync).toHaveBeenCalledWith(
      'openspec',
      ['list'],
      expect.objectContaining({ cwd: path.join(root, 'docs'), encoding: 'utf8' }),
    );
  });
});
```

- [ ] **Step 2: Run facade tests to verify failure**

```bash
npx vitest run test/app/openspec-command.test.ts
```

Expected: FAIL because `app/commands/openspec.ts` does not exist.

- [ ] **Step 3: Implement facade command**

Create `app/commands/openspec.ts`:

```ts
import { spawnSync } from 'child_process';
import path from 'path';
import { resolveCometArtifactLayout } from '../../domains/comet-classic/classic-artifact-layout.js';

interface OpenSpecFacadeOptions {
  json?: boolean;
}

export async function openspecCommand(
  targetPath: string,
  args: string[],
  options: OpenSpecFacadeOptions = {},
): Promise<void> {
  const projectRoot = path.resolve(targetPath);
  const layout = await resolveCometArtifactLayout(projectRoot);
  const commandArgs = [...args, ...layout.openSpec.commandArgs];
  const result = spawnSync(process.env.COMET_OPENSPEC || 'openspec', commandArgs, {
    cwd: layout.openSpec.commandCwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  if (!options.json && layout.layout === 'docs') {
    process.stderr.write(
      `Using OpenSpec root: ${layout.openSpec.storeId ?? layout.openSpec.storeRoot}\n`,
    );
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
```

- [ ] **Step 4: Register CLI command**

Modify `app/cli/index.ts`:

```ts
import { openspecCommand } from '../commands/openspec.js';

program
  .command('openspec [args...]')
  .description('Run OpenSpec through the Comet artifact layout resolver')
  .option('--json', 'Preserve JSON command output')
  .action(async (args: string[] = [], options) => {
    await openspecCommand('.', args, options);
  });
```

- [ ] **Step 5: Add OpenSpec store helper exports**

In `domains/integrations/openspec.ts`, export helpers:

```ts
export function buildOpenSpecStoreSetupInvocation(
  projectPath: string,
  storeId: string,
): { command: string; args: string[] } {
  return {
    command: 'openspec',
    args: ['store', 'setup', storeId, '--path', path.join(projectPath, 'docs'), '--no-init-git'],
  };
}

export function buildOpenSpecStoreRegisterInvocation(
  projectPath: string,
  storeId: string,
): { command: string; args: string[] } {
  return {
    command: 'openspec',
    args: ['store', 'register', path.join(projectPath, 'docs'), '--id', storeId, '--yes'],
  };
}
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run test/app/openspec-command.test.ts test/domains/integrations/openspec.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/commands/openspec.ts app/cli/index.ts domains/integrations/openspec.ts test/app/openspec-command.test.ts test/domains/integrations/openspec.test.ts
git commit -m "feat: add Comet OpenSpec facade"
```

---

### Task 4: Init Configuration and Migration Dry Run

**Files:**
- Create: `app/commands/migrate-docs.ts`
- Create: `test/app/migrate-docs.test.ts`
- Modify: `app/cli/index.ts`
- Modify: `app/commands/init.ts`
- Modify: `app/commands/i18n.ts`
- Modify: `domains/skill/platform-install.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes:
  - `resolveCometArtifactLayout()`
  - OpenSpec store helper functions from Task 3
- Produces:
  - `type ArtifactLayoutOption = 'legacy' | 'docs'`
  - `migrateDocsCommand(targetPath: string, options: MigrateDocsOptions): Promise<void>`
  - `createWorkingDirs(projectPath: string, language?: string, options?: { artifactLayout?: 'legacy' | 'docs'; openSpecStore?: string }): Promise<void>`

- [ ] **Step 1: Write failing init tests**

Extend `test/app/init.test.ts` or `test/app/init-e2e.test.ts`:

```ts
it('creates docs OpenSpec directories and config for docs artifact layout', async () => {
  await initCommand(tmpDir, {
    yes: true,
    scope: 'project',
    json: true,
    language: 'en',
    artifactLayout: 'docs',
    openSpecStore: 'comet-demo-1234',
  });

  await expect(fileExists(path.join(tmpDir, 'docs', 'openspec', 'changes', 'archive'))).resolves.toBe(true);
  await expect(fileExists(path.join(tmpDir, 'docs', 'openspec', 'specs'))).resolves.toBe(true);
  const config = await fs.readFile(path.join(tmpDir, '.comet', 'config.yaml'), 'utf8');
  expect(config).toContain('artifact_layout: docs');
  expect(config).toContain('store: comet-demo-1234');
});
```

- [ ] **Step 2: Write failing migration tests**

Create `test/app/migrate-docs.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDocsCommand } from '../../app/commands/migrate-docs.js';

const roots: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'comet-migrate-docs-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import('fs/promises');
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('migrateDocsCommand', () => {
  it('prints dry-run plan for legacy OpenSpec root', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, 'openspec', 'changes', 'archive'), { recursive: true });
    await mkdir(path.join(root, 'openspec', 'specs'), { recursive: true });
    await writeFile(path.join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n', 'utf8');
    const output: string[] = [];

    await migrateDocsCommand(root, { dryRun: true, log: (line) => output.push(line) });

    expect(output.join('\n')).toContain('Current layout: legacy');
    expect(output.join('\n')).toContain('Target layout: docs');
    expect(output.join('\n')).toContain('Would move: openspec -> docs/openspec');
  });

  it('blocks active changes unless includeActive is true', async () => {
    const root = await tempProject();
    await mkdir(path.join(root, 'openspec', 'changes', 'active-change'), { recursive: true });
    await writeFile(path.join(root, 'openspec', 'changes', 'active-change', '.comet.yaml'), 'phase: build\n', 'utf8');

    await expect(migrateDocsCommand(root, { dryRun: true })).rejects.toThrow(/active changes/i);
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

```bash
npx vitest run test/app/init.test.ts test/app/init-e2e.test.ts test/app/migrate-docs.test.ts
```

Expected: FAIL because init options and migration command are not implemented.

- [ ] **Step 4: Extend project config rendering**

Modify `domains/skill/platform-install.ts`:

```ts
type ArtifactLayoutOption = 'legacy' | 'docs';

interface WorkingDirOptions {
  artifactLayout?: ArtifactLayoutOption;
  openSpecStore?: string;
}

function renderProjectConfig(
  existing: Record<string, string>,
  language = 'en',
  options: WorkingDirOptions = {},
): string {
  const lines: string[] = [];
  // existing language/context/review fields remain first
  if (options.artifactLayout === 'docs') {
    lines.push('# artifact_layout: legacy | docs');
    lines.push('artifact_layout: docs');
    lines.push('openspec:');
    lines.push('  root: docs');
    if (options.openSpecStore) lines.push(`  store: ${options.openSpecStore}`);
    lines.push('superpowers:');
    lines.push('  root: docs/superpowers');
  }
  lines.push('');
  return lines.join('\n');
}
```

Preserve all existing managed language/context/review fields.

- [ ] **Step 5: Create docs layout directories**

Update `createWorkingDirs()`:

```ts
if (options.artifactLayout === 'docs') {
  dirs.push(
    path.join(projectPath, 'docs', 'openspec', 'changes', 'archive'),
    path.join(projectPath, 'docs', 'openspec', 'specs'),
  );
}
dirs.push(
  path.join(projectPath, 'docs', 'superpowers', 'specs'),
  path.join(projectPath, 'docs', 'superpowers', 'plans'),
  path.join(projectPath, 'docs', 'superpowers', 'reports'),
  path.join(projectPath, '.comet'),
);
```

Write `docs/openspec/config.yaml` with:

```yaml
schema: spec-driven
```

- [ ] **Step 6: Implement migration dry-run**

Create `app/commands/migrate-docs.ts`:

```ts
import { promises as fs } from 'fs';
import path from 'path';
import { resolveCometArtifactLayout } from '../../domains/comet-classic/classic-artifact-layout.js';

interface MigrateDocsOptions {
  dryRun?: boolean;
  apply?: boolean;
  repairStore?: boolean;
  includeActive?: boolean;
  openSpecStore?: string;
  log?: (line: string) => void;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function activeChanges(root: string, changesRoot: string): Promise<string[]> {
  if (!(await exists(changesRoot))) return [];
  const out: string[] = [];
  for (const entry of await fs.readdir(changesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'archive') continue;
    if (await exists(path.join(changesRoot, entry.name, '.comet.yaml'))) out.push(entry.name);
  }
  return out.sort();
}

export async function migrateDocsCommand(
  targetPath: string,
  options: MigrateDocsOptions = {},
): Promise<void> {
  const projectRoot = path.resolve(targetPath);
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const layout = await resolveCometArtifactLayout(projectRoot).catch(() => null);
  const legacyRoot = path.join(projectRoot, 'openspec');
  const docsRoot = path.join(projectRoot, 'docs', 'openspec');
  const active = await activeChanges(projectRoot, path.join(legacyRoot, 'changes'));

  if (active.length > 0 && !options.includeActive) {
    throw new Error(`Active changes exist: ${active.join(', ')}. Re-run with --include-active after review.`);
  }

  log(`Current layout: ${layout?.layout ?? 'unknown'}`);
  log('Target layout: docs');
  log(`Legacy OpenSpec root: ${(await exists(legacyRoot)) ? 'present' : 'missing'}`);
  log(`Docs OpenSpec root: ${(await exists(docsRoot)) ? 'present' : 'missing'}`);
  log(`Active changes: ${active.length}`);
  if (await exists(legacyRoot)) log('Would move: openspec -> docs/openspec');
  if (options.repairStore) log(`Would repair OpenSpec store root: ${path.join(projectRoot, 'docs')}`);
  if (!options.apply) log('No files were changed. Re-run with --apply to execute.');
}
```

- [ ] **Step 7: Wire CLI**

In `app/cli/index.ts`:

```ts
import { migrateDocsCommand } from '../commands/migrate-docs.js';

const migrate = program.command('migrate').description('Migrate Comet project artifacts');

migrate
  .command('docs [path]')
  .description('Migrate legacy OpenSpec artifacts into docs layout')
  .option('--dry-run', 'Preview migration without changing files', true)
  .option('--apply', 'Apply the migration')
  .option('--repair-store', 'Repair or register the OpenSpec store for docs layout')
  .option('--include-active', 'Allow active changes to be migrated after review')
  .option('--openspec-store <id>', 'OpenSpec store id to register or repair')
  .action(async (targetPath = '.', options) => {
    await migrateDocsCommand(targetPath, options);
  });
```

- [ ] **Step 8: Ignore local store metadata**

Add to `.gitignore`:

```gitignore
# OpenSpec store metadata created for local docs layout
docs/.openspec-store/
```

- [ ] **Step 9: Run tests**

```bash
npx vitest run test/app/init.test.ts test/app/init-e2e.test.ts test/app/migrate-docs.test.ts
git diff --check -- .gitignore app/commands/migrate-docs.ts domains/skill/platform-install.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add .gitignore app/cli/index.ts app/commands/init.ts app/commands/i18n.ts app/commands/migrate-docs.ts domains/skill/platform-install.ts test/app/init.test.ts test/app/init-e2e.test.ts test/app/migrate-docs.test.ts
git commit -m "feat: add docs layout init and migration preview"
```

---

### Task 5: Runtime Adoption

**Files:**
- Modify: `domains/comet-classic/classic-resume-probe.ts`
- Modify: `domains/comet-classic/classic-handoff.ts`
- Modify: `domains/comet-classic/classic-evidence.ts`
- Modify: `domains/comet-classic/classic-archive.ts`
- Modify: `domains/comet-classic/classic-guard.ts`
- Modify: `test/domains/comet-classic/classic-resume-probe.test.ts`
- Modify: `test/domains/comet-classic/classic-handoff.test.ts`
- Modify: `test/domains/comet-classic/classic-evidence.test.ts`
- Modify: `test/domains/comet-classic/classic-archive.test.ts`
- Modify: `test/domains/comet-classic/comet-scripts.test.ts`
- Modify: `assets/skills/comet/scripts/comet-runtime.mjs`

**Interfaces:**
- Consumes: `resolveCometArtifactLayout()` and `resolveCometChangeDirectory()`.
- Produces: runtime commands that work in legacy and docs layout.

- [ ] **Step 1: Add failing resume-probe docs layout tests**

Extend `test/domains/comet-classic/classic-resume-probe.test.ts`:

```ts
it('auto resumes a docs layout active change', async () => {
  const root = await tempProject();
  await mkdir(path.join(root, 'docs', 'openspec', 'changes', 'add-auth'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'openspec', 'specs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'openspec', 'config.yaml'), 'schema: spec-driven\n', 'utf8');
  await writeFile(
    path.join(root, 'docs', 'openspec', 'changes', 'add-auth', '.comet.yaml'),
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

  const result = await resolveCometResumeProbe(root, {
    schema_version: COMET_RESUME_PROBE_SCHEMA_VERSION,
    utterance: '继续',
    locale: 'zh-CN',
    agent_context: { non_trivial_work: true, already_in_comet_flow: false },
  });

  expect(result.action).toBe('auto_resume');
  expect(result.changeName).toBe('add-auth');
});
```

- [ ] **Step 2: Add failing archive docs layout test**

Extend `test/domains/comet-classic/classic-archive.test.ts`:

```ts
it('passes --store when archiving docs layout changes', async () => {
  // Arrange docs layout .comet/config.yaml with openspec.store.
  // Mock spawnSync and assert args include ['archive', 'add-auth', '--yes', '--store', 'comet-demo-1234'].
});
```

Replace the comment with local fixture helpers from the test file. The assertion must check exact command args.

- [ ] **Step 3: Run runtime tests to verify failure**

```bash
npx vitest run test/domains/comet-classic/classic-resume-probe.test.ts test/domains/comet-classic/classic-archive.test.ts
```

Expected: FAIL because runtime still scans root `openspec/changes` and archive omits store args.

- [ ] **Step 4: Update resume discovery**

In `classic-resume-probe.ts`, replace root-only discovery:

```ts
const layout = await resolveCometArtifactLayout(projectRoot);
const changesDir = layout.openSpec.changesDir;
```

When no explicit config is present and resolver reports conflict, return:

```ts
return result('ask_user', null, 'low', 'multiple artifact layouts contain active changes', [
  { source: 'repo', quote: 'docs/openspec and openspec both contain active changes' },
]);
```

Include layout label in evidence when auto-resuming:

```ts
{ source: 'repo', quote: `${layout.layout}: ${projectRelativePath(projectRoot, changeDir)}` }
```

- [ ] **Step 5: Update handoff and evidence**

In `classic-handoff.ts`, compute change dir through resolver:

```ts
const { directory: changeDir, label } = await resolveClassicChangeDirectory(change);
```

Write `handoff_context` and `handoff_markdown` as project-root-relative paths from resolver:

```ts
const handoffContext = `${label}/.comet/handoff/design-context.json`;
const handoffMarkdown = `${label}/.comet/handoff/design-context.md`;
```

In `classic-evidence.ts`, replace project root inference by basename `openspec` with a helper that resolves from the known current working directory or resolver project root. Path pointers remain project-root-relative.

- [ ] **Step 6: Update archive**

In `classic-archive.ts`:

```ts
const layout = await resolveCometArtifactLayout(process.cwd());
const activeDir = path.join(layout.openSpec.changesDir, change);
const archiveDir = path.join(layout.openSpec.archiveDir, archiveName);
const archiveRun = spawnSync(openspec, ['archive', change, '--yes', ...layout.openSpec.commandArgs], {
  cwd: layout.openSpec.commandCwd,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
```

Use `layout.openSpec.specsDir` in `verifyMainSpecsClean()`.

- [ ] **Step 7: Run focused runtime tests**

```bash
npx vitest run test/domains/comet-classic/classic-resume-probe.test.ts test/domains/comet-classic/classic-handoff.test.ts test/domains/comet-classic/classic-evidence.test.ts test/domains/comet-classic/classic-archive.test.ts test/domains/comet-classic/comet-scripts.test.ts
```

Expected: PASS.

- [ ] **Step 8: Rebuild Classic runtime asset**

```bash
pnpm build:classic-runtime
```

If `pnpm` fails for environment reasons, run:

```bash
node scripts/build/build-classic-runtime.mjs
```

Expected: `assets/skills/comet/scripts/comet-runtime.mjs` updates or remains identical.

- [ ] **Step 9: Verify generated runtime freshness**

```bash
node scripts/build/build-classic-runtime.mjs --check
```

Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add domains/comet-classic/classic-resume-probe.ts domains/comet-classic/classic-handoff.ts domains/comet-classic/classic-evidence.ts domains/comet-classic/classic-archive.ts domains/comet-classic/classic-guard.ts assets/skills/comet/scripts/comet-runtime.mjs test/domains/comet-classic/classic-resume-probe.test.ts test/domains/comet-classic/classic-handoff.test.ts test/domains/comet-classic/classic-evidence.test.ts test/domains/comet-classic/classic-archive.test.ts test/domains/comet-classic/comet-scripts.test.ts
git commit -m "feat: make Classic runtime layout-aware"
```

---

### Task 6: Hook Guard, Dashboard, and Workflow Contract

**Files:**
- Modify: `domains/comet-classic/classic-hook-guard.ts`
- Modify: `domains/dashboard/collector.ts`
- Modify: `domains/dashboard/types.ts`
- Modify: `domains/workflow-contract/builtins.ts`
- Modify: `domains/workflow-contract/normalize.ts`
- Modify: `test/domains/comet-classic/classic-hook-guard.test.ts`
- Modify: `test/domains/dashboard/collector.test.ts`
- Modify: `test/domains/workflow-contract/workflow-contract.test.ts`
- Modify: `assets/skills/comet/scripts/comet-runtime.mjs`

**Interfaces:**
- Consumes: layout resolver.
- Produces:
  - Hook guard recognizes `docs/openspec/changes/<name>/`.
  - Dashboard snapshot includes docs layout changes without project root drift.
  - Workflow contract supports both state path globs.

- [ ] **Step 1: Write failing hook guard tests**

Extend `test/domains/comet-classic/classic-hook-guard.test.ts`:

```ts
it('allows docs layout OpenSpec artifacts in open phase', async () => {
  const target = path.join(tmpDir, 'docs', 'openspec', 'changes', 'add-auth', 'proposal.md');
  await writeDocsLayoutState(tmpDir, 'add-auth', 'open');
  const result = runHookGuard(tmpDir, target);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain('docs/openspec/changes/add-auth/proposal.md');
});

it('does not allow unrelated docs files just because docs layout exists', async () => {
  await writeDocsLayoutState(tmpDir, 'add-auth', 'open');
  const result = runHookGuard(tmpDir, path.join(tmpDir, 'docs', 'product-notes.md'));
  expect(result.exitCode).toBe(2);
});
```

- [ ] **Step 2: Write failing dashboard tests**

Extend `test/domains/dashboard/collector.test.ts`:

```ts
it('collects docs layout changes without treating docs as project root', async () => {
  await writeDocsLayoutChange(tmpDir, 'add-auth', {
    phase: 'build',
    plan: 'docs/superpowers/plans/add-auth.md',
  });
  await writeFile(path.join(tmpDir, 'docs', 'superpowers', 'plans', 'add-auth.md'), '# Plan\n');

  const snapshot = await collectDashboardSnapshot(tmpDir);

  expect(snapshot.changes.active[0].path).toContain(path.join('docs', 'openspec', 'changes', 'add-auth'));
  expect(snapshot.changes.active[0].artifacts.plan).toBe(true);
});
```

- [ ] **Step 3: Run tests to verify failure**

```bash
npx vitest run test/domains/comet-classic/classic-hook-guard.test.ts test/domains/dashboard/collector.test.ts test/domains/workflow-contract/workflow-contract.test.ts
```

Expected: FAIL because these modules are root `openspec` only.

- [ ] **Step 4: Update hook guard**

In `classic-hook-guard.ts`:

```ts
const layouts = await candidateArtifactLayouts(projectRoot);
```

Implement helper:

```ts
function isOpenSpecArtifactPath(relativePath: string): boolean {
  return relativePath.startsWith('openspec/') || relativePath.startsWith('docs/openspec/');
}

function openSpecChangePrefix(relativePath: string): { prefix: string; name: string } | null {
  for (const prefix of ['openspec/changes/', 'docs/openspec/changes/']) {
    if (!relativePath.startsWith(prefix)) continue;
    const name = relativePath.slice(prefix.length).split('/')[0];
    if (name && name !== 'archive') return { prefix, name };
  }
  return null;
}
```

Do not broaden allowlist to `docs/`.

- [ ] **Step 5: Update dashboard**

In `collector.ts`, replace `CHANGES_DIR` constant with resolver-derived roots. `collectDashboardSnapshot()` should:

```ts
const layout = await resolveCometArtifactLayout(resolvedRoot).catch(() => null);
const changesRoots = layout
  ? [layout.openSpec.changesDir]
  : [
      path.join(resolvedRoot, 'docs', 'openspec', 'changes'),
      path.join(resolvedRoot, 'openspec', 'changes'),
    ];
```

Pass `projectRoot: resolvedRoot` into `buildChangeItem()` instead of calling `resolveProjectRoot(input.dir)`.

Add optional type:

```ts
layout?: 'legacy' | 'docs';
```

to `ChangeDashboardItem`.

- [ ] **Step 6: Update workflow contract**

In `builtins.ts`, include both globs:

```ts
paths: ['openspec/changes/*/.comet.yaml', 'docs/openspec/changes/*/.comet.yaml']
```

Repeat for delta specs and tasks where root `openspec/changes` appears.

- [ ] **Step 7: Run focused tests and rebuild runtime**

```bash
npx vitest run test/domains/comet-classic/classic-hook-guard.test.ts test/domains/dashboard/collector.test.ts test/domains/workflow-contract/workflow-contract.test.ts
node scripts/build/build-classic-runtime.mjs
node scripts/build/build-classic-runtime.mjs --check
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add domains/comet-classic/classic-hook-guard.ts domains/dashboard/collector.ts domains/dashboard/types.ts domains/workflow-contract/builtins.ts domains/workflow-contract/normalize.ts assets/skills/comet/scripts/comet-runtime.mjs test/domains/comet-classic/classic-hook-guard.test.ts test/domains/dashboard/collector.test.ts test/domains/workflow-contract/workflow-contract.test.ts
git commit -m "feat: support docs layout in guard and dashboard"
```

---

### Task 7: Skill, Eval, Docs, and Changelog

**Files:**
- Modify: `assets/skills-zh/comet/**`
- Modify: `assets/skills/comet/**`
- Modify: `assets/skills-zh/comet-open/SKILL.md`
- Modify: `assets/skills/comet-open/SKILL.md`
- Modify: `assets/skills-zh/comet-design/SKILL.md`
- Modify: `assets/skills/comet-design/SKILL.md`
- Modify: `assets/skills-zh/comet-build/SKILL.md`
- Modify: `assets/skills/comet-build/SKILL.md`
- Modify: `assets/skills-zh/comet-verify/SKILL.md`
- Modify: `assets/skills/comet-verify/SKILL.md`
- Modify: `assets/skills-zh/comet-archive/SKILL.md`
- Modify: `assets/skills/comet-archive/SKILL.md`
- Modify: `assets/skills-zh/comet-hotfix/SKILL.md`
- Modify: `assets/skills/comet-hotfix/SKILL.md`
- Modify: `assets/skills-zh/comet-tweak/SKILL.md`
- Modify: `assets/skills/comet-tweak/SKILL.md`
- Modify: `test/domains/skill/skills.test.ts`
- Modify: `eval/scaffold/python/validation/comet_workflow.py`
- Modify: `eval/scaffold/python/validation/rubric.py`
- Modify: `eval/local/**`
- Modify: `README-zh.md`, `README.md` only if user-facing docs are needed.
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `comet openspec ...` facade.
- Produces: Agent-facing guidance that no longer assumes root `openspec/changes` as the only layout.

- [ ] **Step 1: Write failing Skill tests**

Update `test/domains/skill/skills.test.ts`:

```ts
it('teaches layout-aware OpenSpec access in both languages', async () => {
  const zhComet = await fs.readFile(path.resolve('assets/skills-zh/comet/SKILL.md'), 'utf8');
  const enComet = await fs.readFile(path.resolve('assets/skills/comet/SKILL.md'), 'utf8');

  expect(zhComet).toContain('comet openspec status --change "<name>" --json');
  expect(enComet).toContain('comet openspec status --change "<name>" --json');
  expect(zhComet).toContain('<openspec-change-dir>');
  expect(enComet).toContain('<openspec-change-dir>');
});
```

Add a targeted test that rejects old wording in top-level Comet guidance:

```ts
expect(zhComet).not.toContain('只来自 `openspec/changes/<name>/.comet.yaml`');
expect(enComet).not.toContain('only from `openspec/changes/<name>/.comet.yaml`');
```

- [ ] **Step 2: Run Skill tests to verify failure**

```bash
npx vitest run test/domains/skill/skills.test.ts
```

Expected: FAIL because Skill text still contains root-only guidance.

- [ ] **Step 3: Update Chinese Skills first**

Change Chinese Skill guidance to use:

```text
<openspec-change-dir>/.comet.yaml
<openspec-change-dir>/tasks.md
<openspec-change-dir>/.comet/handoff/...
```

Replace raw OpenSpec command guidance with:

```bash
comet openspec status --change "<name>" --json
comet openspec instructions tasks --change "<name>" --json
comet openspec archive "<name>" --yes
```

Keep examples that mention legacy paths only when explaining compatibility:

```text
legacy: openspec/changes/<name>
docs: docs/openspec/changes/<name>
```

- [ ] **Step 4: Update English Skills with the same semantics**

Mirror the Chinese content in English. Preserve meaning, not word-for-word phrasing.

- [ ] **Step 5: Update eval validation**

In `eval/scaffold/python/validation/comet_workflow.py`, support both roots:

```py
CHANGE_ROOTS = ["openspec/changes", "docs/openspec/changes"]

def _first_existing_change_root():
    for root in CHANGE_ROOTS:
        if _glob_exists(f"{root}/**/.comet.yaml") or _glob_exists(f"{root}/**/proposal.md"):
            return root
    return None
```

In `eval/scaffold/python/validation/rubric.py`, update regex roots:

```py
OPEN_SPEC_CHANGE_ROOT = r"(?:openspec/changes|docs/openspec/changes)"
```

Use it in proposal/tasks/design/plan/archive regexes.

- [ ] **Step 6: Add docs-layout eval treatment**

Add treatment under `eval/local/treatments/` with a name such as:

```text
comet_full_040_beta_docs_layout.yaml
```

It must configure the task setup to create/use `docs/openspec/changes` and use the current Comet Skill bundle.

- [ ] **Step 7: Update changelog**

Before editing `CHANGELOG.md`, confirm versions:

```bash
node -e "console.log(require('./package.json').version)"
git show origin/master:package.json
git tag --sort=-v:refname
```

Add to the current unreleased version block:

```md
### Added

- **Unified artifact layout**: Added a docs-based Comet artifact layout with OpenSpec store resolution so new projects can keep OpenSpec and Superpowers workflow artifacts under `docs/`.
- **Artifact migration**: Added a dry-run-first migration command for moving legacy OpenSpec artifacts into the docs-based layout without overwriting active work.
```

Only include the migration bullet if `comet migrate docs` was implemented beyond dry-run preview.

- [ ] **Step 8: Run Skill and eval tests**

```bash
npx vitest run test/domains/skill/skills.test.ts
python -m pytest eval/local/tests/tasks/test_tasks.py eval/local/tests/scaffold/test_profiles.py
```

If local Python env is unavailable, run the available eval unit test command already used by the repo and record the blocker in the final implementation summary.

- [ ] **Step 9: Commit**

```bash
git add assets/skills-zh assets/skills test/domains/skill/skills.test.ts eval/scaffold eval/local README-zh.md README.md CHANGELOG.md
git commit -m "docs: sync Skills for unified artifact layout"
```

---

### Task 8: Full Verification and Release Readiness

**Files:**
- Modify only files that fail verification from previous tasks.

**Interfaces:**
- Consumes all previous task outputs.
- Produces a verified branch ready for PR or merge review.

- [ ] **Step 1: Run focused command suite**

```bash
npx vitest run test/domains/comet-classic/comet-scripts.test.ts
npx vitest run test/domains/comet-classic/classic-artifact-layout.test.ts
npx vitest run test/app/openspec-command.test.ts test/app/migrate-docs.test.ts
npx vitest run test/domains/dashboard/collector.test.ts
npx vitest run test/domains/skill/skills.test.ts
npx vitest run test/domains/workflow-contract/workflow-contract.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run architecture and runtime checks**

```bash
node scripts/build/build-classic-runtime.mjs --check
node scripts/lint/architecture.mjs
git diff --check
```

Expected: all exit 0.

- [ ] **Step 3: Run full build and tests**

```bash
node build.js
npx vitest run
```

Expected: both exit 0.

- [ ] **Step 4: Inspect final diff**

```bash
git status --short
git diff --stat origin/master...HEAD
git log --oneline origin/master..HEAD
```

Expected:

- Only intended unified layout, migration, Skill, eval, docs, generated runtime, and changelog files are changed.
- No unrelated project-registry, update, or installation-registry work is included unless that work is already part of the current branch baseline.

- [ ] **Step 5: Commit verification fixes**

If verification required fixes:

```bash
git add <fixed-files>
git commit -m "fix: complete unified artifact layout verification"
```

If no fixes were needed, do not create an empty commit.

- [ ] **Step 6: Prepare final summary**

Include:

- Layout resolver behavior.
- OpenSpec facade behavior.
- Migration command behavior.
- Legacy compatibility result.
- Skill and eval updates.
- Exact verification commands and outputs.
- Any skipped commands and blockers.

---

## Plan Self-Review

Spec coverage:

- Unified `docs/openspec` + `docs/superpowers`: Tasks 1, 4, 5.
- OpenSpec store id support without Comet registry duplication: Tasks 1, 3, 4.
- Skill hardcoded path removal: Task 7.
- Runtime path adoption: Task 5.
- Dashboard and hook guard: Task 6.
- Cross-session resume: Tasks 5 and 7.
- `.comet.yaml` state fields: Task 2.
- Migration dry-run and repair-store: Task 4.
- Eval baseline and docs-layout treatment: Task 7.
- Changelog and release validation: Tasks 7 and 8.

Placeholder scan:

- Placeholder scan found no unresolved placeholders or unspecified future fill-ins.
- Each task names exact files, interfaces, test commands, expected outcomes, and commit commands.

Type consistency:

- Resolver names are consistent across tasks: `resolveCometArtifactLayout()`, `resolveCometChangeDirectory()`, `CometArtifactLayout`.
- CLI facade name is consistent: `openspecCommand()`.
- Migration command name is consistent: `migrateDocsCommand()` and `comet migrate docs`.
