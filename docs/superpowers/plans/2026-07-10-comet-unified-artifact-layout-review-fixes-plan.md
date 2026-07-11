# Unified Artifact Layout Review Fixes Plan

> **For implementation:** execute sequentially and keep each task independently testable.

**Goal:** Close the store lifecycle, facade forwarding, and migration safety gaps found while reviewing the unified artifact layout work.

**Architecture:** Treat the project `docs/` directory as the only valid OpenSpec store root. Register that pre-created root, verify the registered identity before forwarding commands, and persist the store id only after a successful registration. Migration applies a staged rename with compensating rollback for the root and config file.

**Tech Stack:** TypeScript, Node.js filesystem/process APIs, Vitest.

---

## Task 1: Establish the OpenSpec Store Contract

**Files:**

- Modify: `domains/integrations/openspec.ts`
- Modify: `app/commands/init.ts`
- Modify: `app/commands/openspec.ts`
- Modify: `app/cli/index.ts`
- Test: `test/domains/integrations/openspec.test.ts`
- Test: `test/app/init-e2e.test.ts`
- Test: `test/app/openspec-command.test.ts`
- Test: `test/app/openspec-cli.test.ts`

1. Add failing tests for registering an existing docs root without `store setup`, rejecting a mismatched registry path, deferred config persistence, and `--json` forwarding.
2. Implement registry inspection and normalized path verification.
3. Register only after the docs OpenSpec root exists, then persist `openspec.store` only on success.
4. Run the focused suites.

## Task 2: Make `migrate docs --apply` Safe and Complete

**Files:**

- Modify: `app/commands/migrate-docs.ts`
- Modify: `test/app/migrate-docs.test.ts`

1. Add failing tests for successful apply, active-change protection, repair-store registration, config persistence, target conflicts, and rollback after a post-move error.
2. Build a migration plan before mutating paths; reject ambiguous roots and active changes unless explicitly included.
3. Stage the legacy root under `docs/openspec`, register/verify an optional store, then persist the docs layout config.
4. Restore the original root and config when a later step fails.
5. Run the focused migration suite.

## Task 3: Review and Verify

**Files:**

- Modify only if verification identifies a necessary correction.

1. Re-read all changed diff paths against issue #173 and the four review findings.
2. Run formatter, lint, build, focused tests, and the full Vitest suite.
3. Update the existing unreleased changelog entry only if final user-visible behavior requires it.
