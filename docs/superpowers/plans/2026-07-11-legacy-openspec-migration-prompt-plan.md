# Legacy OpenSpec Migration Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let interactive project `init` and `update` offer a safe migration of legacy `openspec/` artifacts into the docs layout, with an exact follow-up command when the user defers.

**Architecture:** Add a small app-command helper that observes the legacy OpenSpec root and returns the existing `comet migrate docs` invocation appropriate for its active-change state. `init` and `update` own localized prompts and call the existing `migrateDocsCommand`; the migration command remains the only code that moves files, registers stores, or invalidates handoffs.

**Tech Stack:** TypeScript, Node.js filesystem APIs, `@inquirer/prompts`, Vitest.

## Global Constraints

- Do not add a second migration command, registry, or state model.
- Only interactive current-project flows may prompt; `init --yes`, `--json`, and `update --all` must not move artifacts or prompt.
- Active changes require a separate confirmation before passing `--include-active` because migration invalidates handoffs.
- Deferred output must be `comet migrate docs --apply`, plus `--include-active` exactly when active changes are present.
- Deferred init keeps the legacy layout for that run; noninteractive docs init with a legacy root fails without creating a second OpenSpec root.

---

### Task 1: Describe Legacy Migration Readiness

**Files:**

- Create: `app/commands/legacy-openspec-migration-prompt.ts`
- Test: `test/app/legacy-openspec-migration-prompt.test.ts`

**Interfaces:**

- Produces: `inspectLegacyOpenSpecMigration(projectPath): Promise<{ present: boolean; hasActiveChanges: boolean; command: string }>`.
- Consumes: the project-local `openspec/changes/` tree only; archive directories are never active changes.

- [ ] **Step 1: Write the failing inspection tests**

```ts
async function createLegacyOpenSpecRoot(projectPath: string, change?: string): Promise<void> {
  const root = path.join(projectPath, 'openspec');
  await fs.mkdir(path.join(root, 'changes', 'archive'), { recursive: true });
  await fs.mkdir(path.join(root, 'specs'), { recursive: true });
  await fs.writeFile(path.join(root, 'config.yaml'), 'schema: spec-driven\n', 'utf8');
  if (change) await fs.mkdir(path.join(root, 'changes', change), { recursive: true });
}

it('returns the normal apply command for an inactive legacy root', async () => {
  await createLegacyOpenSpecRoot(tmpDir);

  await expect(inspectLegacyOpenSpecMigration(tmpDir)).resolves.toMatchObject({
    present: true,
    hasActiveChanges: false,
    command: 'comet migrate docs --apply',
  });
});

it('adds include-active only when a non-archive change exists', async () => {
  await createLegacyOpenSpecRoot(tmpDir, 'active-change');

  await expect(inspectLegacyOpenSpecMigration(tmpDir)).resolves.toMatchObject({
    hasActiveChanges: true,
    command: 'comet migrate docs --apply --include-active',
  });
});
```

- [ ] **Step 2: Run the inspection tests to verify they fail**

Run: `npx vitest run test/app/legacy-openspec-migration-prompt.test.ts`

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement the minimal inspection helper**

```ts
const command = hasActiveChanges
  ? 'comet migrate docs --apply --include-active'
  : 'comet migrate docs --apply';
```

The helper must not prompt or contain UI copy. It only reports `present`, `hasActiveChanges`, and `command`; callers own translated interaction.

- [ ] **Step 4: Run the helper tests to verify they pass**

Run: `npx vitest run test/app/legacy-openspec-migration-prompt.test.ts`

Expected: PASS.

### Task 2: Connect Init and Update Without Duplicating Migration

**Files:**

- Modify: `app/commands/init.ts`
- Modify: `app/commands/update.ts`
- Modify: `app/commands/i18n.ts`
- Modify: `test/app/init-e2e.test.ts`
- Modify: `test/app/update.test.ts`

**Interfaces:**

- Consumes: `inspectLegacyOpenSpecMigration()` from Task 1.
- Consumes: `migrateDocsCommand(projectPath, { apply: true, includeActive })` from `app/commands/migrate-docs.ts`.
- Produces: interactive migration or a deferred command in human-readable output; normal `init`/`update` return structures remain compatible.

- [ ] **Step 1: Write failing init and update tests**

```ts
const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

it('offers to migrate a legacy root before docs init', async () => {
  await createLegacyOpenSpecRoot(tmpDir);
  mockedSelect.mockResolvedValueOnce(true);

  await initCommand(tmpDir, { scope: 'project', artifactLayout: 'docs' });

  expect(mockedMigrateDocsCommand).toHaveBeenCalledWith(tmpDir, { apply: true });
});

it('prints the active-change migration command when update is deferred', async () => {
  await createLegacyOpenSpecRoot(tmpDir, 'active-change');
  mockedSelect.mockResolvedValueOnce(false);

  await updateCommand(tmpDir, { scope: 'project', skipNpm: true });

  expect(log.mock.calls.flat().join('\n')).toContain('comet migrate docs --apply --include-active');
});
```

Also add cases proving `init --yes`, `--json`, and all-project updates do not invoke the prompt or `migrateDocsCommand`.

- [ ] **Step 2: Run the init and update tests to verify they fail**

Run: `npx vitest run test/app/init-e2e.test.ts test/app/update.test.ts`

Expected: FAIL because init still throws for a legacy root and update has no migration prompt.

- [ ] **Step 3: Implement the minimal call sites**

```ts
const migration = await inspectLegacyOpenSpecMigration(projectPath);
const migrateNow = await select({
  message: t(lang, 'legacyOpenSpecMigrationPrompt'),
  choices: [
    { name: t(lang, 'legacyOpenSpecMigrationNow'), value: true },
    { name: t(lang, 'legacyOpenSpecMigrationLater'), value: false },
  ],
});
const includeActive = migration.hasActiveChanges && migrateNow
  ? await select({
      message: t(lang, 'legacyOpenSpecActiveMigrationPrompt'),
      choices: [
        { name: t(lang, 'legacyOpenSpecActiveMigrationContinue'), value: true },
        { name: t(lang, 'legacyOpenSpecActiveMigrationLater'), value: false },
      ],
    })
  : false;
if (migrateNow && (!migration.hasActiveChanges || includeActive)) {
  await migrateDocsCommand(projectPath, {
    apply: true,
    ...(includeActive ? { includeActive: true } : {}),
  });
} else if (migration.present && !options.json) {
  log(`  Legacy OpenSpec artifacts remain in openspec/. Run: ${migration.command}`);
}
```

Add `legacyOpenSpecMigrationPrompt`, `legacyOpenSpecMigrationNow`, `legacyOpenSpecMigrationLater`, `legacyOpenSpecActiveMigrationPrompt`, `legacyOpenSpecActiveMigrationContinue`, `legacyOpenSpecActiveMigrationLater`, and `legacyOpenSpecMigrationDeferred` with English and Chinese values. Call this from docs-layout project `init` before store setup, and from current-project `update` before `mergeProjectConfig`. For `init --yes`, `--json`, and all-project update execution, never select or migrate; `init` reports the required migration command before failing safely, while update preserves its existing non-interactive output contract.

- [ ] **Step 4: Run the init and update tests to verify they pass**

Run: `npx vitest run test/app/init-e2e.test.ts test/app/update.test.ts`

Expected: PASS.

### Task 3: Verify User-Facing Contract

**Files:**

- Modify: `CHANGELOG.md` only if the existing unified-layout entry needs user-visible wording for the prompt.

- [ ] **Step 1: Run focused behavior tests**

Run: `npx vitest run test/app/legacy-openspec-migration-prompt.test.ts test/app/init-e2e.test.ts test/app/update.test.ts test/app/migrate-docs.test.ts`

Expected: PASS.

- [ ] **Step 2: Run repository gates**

Run: `pnpm format:check`, `pnpm lint`, `pnpm build`, `npx vitest run`, and `git diff --check`.

Expected: all commands exit 0; full Vitest output may retain existing skips only.

- [ ] **Step 3: Commit the completed behavior**

```bash
git add app/commands/legacy-openspec-migration-prompt.ts app/commands/init.ts app/commands/update.ts test/app/legacy-openspec-migration-prompt.test.ts test/app/init-e2e.test.ts test/app/update.test.ts docs/superpowers/specs/2026-07-10-comet-unified-artifact-layout-design.md docs/superpowers/plans/2026-07-11-legacy-openspec-migration-prompt-plan.md CHANGELOG.md
git commit -m "feat: prompt to migrate legacy OpenSpec artifacts"
```
