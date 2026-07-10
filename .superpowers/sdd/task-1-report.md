# Task 1 Report: Layout Resolver Foundation

## Summary

- Task: Layout Resolver Foundation
- Worktree: `D:\Project\Comet\.worktrees\unified-artifact-layout-implementation`
- Base commit before Task 1: `39d01d24f2647f38b37139a00320673d77328369`
- Task 1 commit: `f2fcc0b89f44a3d5d18f35f1947733b1bfbb4397`

## TDD Evidence

### RED

1. Added `test/domains/comet-classic/classic-artifact-layout.test.ts` with the five brief-specified resolver cases.
2. Ran:

   ```bash
   npx vitest run test/domains/comet-classic/classic-artifact-layout.test.ts
   ```

3. Observed expected failure:

   - Suite failed before running tests.
   - Error: `Cannot find module '../../../domains/comet-classic/classic-artifact-layout.js'`

This matched the brief's expected RED state because the resolver module did not exist yet.

### GREEN

1. Created `domains/comet-classic/classic-artifact-layout.ts`.
2. Updated `domains/comet-classic/classic-paths.ts` so `resolveClassicChangeDirectory()` delegates to `resolveCometChangeDirectory(process.cwd(), name)`.
3. Re-ran:

   ```bash
   npx vitest run test/domains/comet-classic/classic-artifact-layout.test.ts
   ```

4. Observed success:

   - `Test Files  1 passed (1)`
   - `Tests  5 passed (5)`

## Files Changed

- Created `domains/comet-classic/classic-artifact-layout.ts`
- Created `test/domains/comet-classic/classic-artifact-layout.test.ts`
- Modified `domains/comet-classic/classic-paths.ts`

## Behavior Implemented

- Added `CometArtifactLayoutKind` with `legacy | docs`.
- Added `CometArtifactLayout` and resolver option interfaces.
- Implemented `resolveCometArtifactLayout(projectRoot, options?)`.
- Implemented `resolveCometChangeDirectory(projectRoot, name, options?)`.
- Implemented `projectRelativePath(projectRoot, absolutePath)`.
- Preserved `openSpecChangeNameError()` unchanged in `classic-paths.ts`.
- Kept legacy fallback behavior for unresolved changes while making change-directory resolution layout-aware.
- Added fail-closed behavior when both legacy and docs layouts contain active changes without config.

## Verification

### Focused Task 1 test

```bash
npx vitest run test/domains/comet-classic/classic-artifact-layout.test.ts
```

- PASS: `5 passed`

### Directly relevant regression check

```bash
npx vitest run test/domains/comet-classic/comet-scripts.test.ts
```

- PASS: `161 passed`

### Formatting / diff hygiene

```bash
npx prettier --check domains/comet-classic/classic-artifact-layout.ts domains/comet-classic/classic-paths.ts test/domains/comet-classic/classic-artifact-layout.test.ts
git diff --check
```

- PASS: Prettier clean
- PASS: no diff-check errors

## Self-Review

- Scope stayed within the briefed Task 1 files only.
- Resolver naming and output structure match the brief.
- Tests were written before implementation and observed failing for the expected reason.
- `classic-paths.ts` still owns name validation; layout resolution moved into the new foundation module.
- The resolver intentionally treats invalid or missing `.comet/config.yaml` as "no config" and then falls back to layout detection/defaults, matching the briefed foundation behavior.

## Concerns

- No blocking concerns for Task 1.
- `resolveCometArtifactLayout()` currently does not validate that explicitly configured roots are healthy; it trusts config and returns the derived layout. That matches the Task 1 brief and may be tightened by later tasks if needed.
- Per the explicit Task 1 scope, no changelog/version update was made in this task.

---

## Review Fix Follow-up (2026-07-10)

### Findings Addressed

1. Synchronized generated Classic runtime asset after Task 1 source changes.
2. Hardened `resolveCometChangeDirectory(projectRoot, name, ...)` so it rejects invalid user change names with the same OpenSpec-compatible validation used elsewhere.

### TDD Evidence

#### RED

1. Added a focused regression to `test/domains/comet-classic/classic-artifact-layout.test.ts` for the invalid user input `2026-07-10-add-auth`.
2. Ran:

   ```bash
   npx vitest run test/domains/comet-classic/classic-artifact-layout.test.ts
   ```

3. Observed the expected failure proving the missing validation:

   - `Tests  1 failed | 5 passed (6)`
   - Failure: `promise resolved ... instead of rejecting`
   - Resolved path incorrectly pointed at `docs/openspec/changes/archive/2026-07-10-add-auth`

Root cause: `resolveCometChangeDirectory()` accepted raw `name` values and directly resolved active/archive paths without validating the user-facing change name first.

#### GREEN

1. Extracted shared change-name validation into `domains/comet-classic/classic-change-name.ts`.
2. Re-exported the shared helpers from `domains/comet-classic/classic-paths.ts`.
3. Added `assertOpenSpecChangeName(name)` at the start of `resolveCometChangeDirectory()`.
4. Re-ran:

   ```bash
   npx vitest run test/domains/comet-classic/classic-artifact-layout.test.ts
   ```

5. Observed success:

   - `Test Files  1 passed (1)`
   - `Tests  6 passed (6)`

### Runtime Regeneration Evidence

Ran:

```bash
node scripts/build/build-classic-runtime.mjs
node scripts/build/build-classic-runtime.mjs --check
```

Observed:

- `assets/skills/comet/scripts/comet-runtime.mjs` changed and was kept in the patch.
- `--check` exited successfully with no drift reported after regeneration.

### Regression / Verification

Ran:

```bash
npx vitest run test/domains/comet-classic/comet-scripts.test.ts
npx prettier --check domains/comet-classic/classic-change-name.ts domains/comet-classic/classic-paths.ts domains/comet-classic/classic-artifact-layout.ts test/domains/comet-classic/classic-artifact-layout.test.ts
git diff --check -- domains/comet-classic/classic-change-name.ts domains/comet-classic/classic-paths.ts domains/comet-classic/classic-artifact-layout.ts test/domains/comet-classic/classic-artifact-layout.test.ts assets/skills/comet/scripts/comet-runtime.mjs
```

Observed:

- `Test Files  1 passed (1)`
- `Tests  161 passed (161)`
- Prettier check passed for all touched source/test files.
- `git diff --check` reported no whitespace or patch hygiene issues.

### Files Changed for Review Fix

- Added `domains/comet-classic/classic-change-name.ts`
- Modified `domains/comet-classic/classic-artifact-layout.ts`
- Modified `domains/comet-classic/classic-paths.ts`
- Modified `test/domains/comet-classic/classic-artifact-layout.test.ts`
- Regenerated `assets/skills/comet/scripts/comet-runtime.mjs`
