import * as nodeFs from 'fs';
import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  configureOpenSpecStore,
  getOpenSpecStoreRoot,
  unregisterOpenSpecStore,
  writeFileForMigration,
} = vi.hoisted(() => ({
  configureOpenSpecStore: vi.fn<(projectPath: string, storeId: string) => 'installed' | 'failed'>(),
  getOpenSpecStoreRoot: vi.fn<(projectPath: string, storeId: string) => string | undefined>(),
  unregisterOpenSpecStore:
    vi.fn<(projectPath: string, storeId: string) => 'unregistered' | 'skipped' | 'failed'>(),
  writeFileForMigration: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      writeFile: writeFileForMigration,
    },
  };
});

vi.mock('../../domains/integrations/openspec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../domains/integrations/openspec.js')>();
  return {
    ...actual,
    configureOpenSpecStore,
    getOpenSpecStoreRoot,
    unregisterOpenSpecStore,
  };
});

import { migrateDocsCommand } from '../../app/commands/migrate-docs.js';
import { createOpenSpecStoreId } from '../../domains/integrations/openspec.js';

const roots: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-migrate-docs-'));
  roots.push(dir);
  return dir;
}

async function writeLegacyOpenSpecRoot(root: string, activeChange?: string): Promise<void> {
  const openSpecRoot = path.join(root, 'openspec');
  await fs.mkdir(path.join(openSpecRoot, 'changes', 'archive'), { recursive: true });
  await fs.mkdir(path.join(openSpecRoot, 'specs'), { recursive: true });
  await fs.writeFile(path.join(openSpecRoot, 'config.yaml'), 'schema: spec-driven\n', 'utf8');
  if (activeChange) {
    await fs.mkdir(path.join(openSpecRoot, 'changes', activeChange), { recursive: true });
    await fs.writeFile(
      path.join(openSpecRoot, 'changes', activeChange, '.comet.yaml'),
      'phase: build\n',
      'utf8',
    );
  }
}

async function writeDocsOpenSpecRoot(root: string): Promise<void> {
  const openSpecRoot = path.join(root, 'docs', 'openspec');
  await fs.mkdir(path.join(openSpecRoot, 'changes', 'archive'), { recursive: true });
  await fs.mkdir(path.join(openSpecRoot, 'specs'), { recursive: true });
  await fs.writeFile(path.join(openSpecRoot, 'config.yaml'), 'schema: spec-driven\n', 'utf8');
}

async function writeRuntimeArtifacts(
  root: string,
  change: string,
  artifacts: Record<string, string>,
): Promise<string> {
  const artifactsPath = path.join(root, 'openspec', 'changes', change, '.comet', 'artifacts.json');
  await fs.mkdir(path.dirname(artifactsPath), { recursive: true });
  await fs.writeFile(artifactsPath, `${JSON.stringify(artifacts, null, 2)}\n`, 'utf8');
  return artifactsPath;
}

async function writeConfig(root: string, content: string): Promise<string> {
  const configPath = path.join(root, '.comet', 'config.yaml');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, content, 'utf8');
  return configPath;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function expectedGeneratedStoreId(root: string): string {
  return createOpenSpecStoreId(root);
}

beforeEach(() => {
  writeFileForMigration.mockImplementation(fs.writeFile);
  configureOpenSpecStore.mockReturnValue('installed');
  getOpenSpecStoreRoot.mockReturnValue(undefined);
  unregisterOpenSpecStore.mockReturnValue('unregistered');
});

afterEach(async () => {
  vi.restoreAllMocks();
  configureOpenSpecStore.mockReset();
  getOpenSpecStoreRoot.mockReset();
  unregisterOpenSpecStore.mockReset();
  writeFileForMigration.mockReset();
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('migrateDocsCommand', () => {
  it('keeps dry-run read-only and previews only a store register command', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root);
    const output: string[] = [];

    await migrateDocsCommand(root, {
      dryRun: true,
      repairStore: true,
      openSpecStore: 'comet-demo-1234',
      log: (line) => output.push(line),
    });

    const preview = output.join('\n');
    expect(preview).toContain('Current layout: legacy');
    expect(preview).toContain('Would move: openspec -> docs/openspec');
    expect(preview).toContain(
      `Would run: openspec store register ${path.join(root, 'docs')} --id comet-demo-1234 --yes`,
    );
    expect(preview).not.toContain('store setup');
    expect(configureOpenSpecStore).not.toHaveBeenCalled();
    await expect(pathExists(path.join(root, 'openspec'))).resolves.toBe(true);
    await expect(pathExists(path.join(root, 'docs', 'openspec'))).resolves.toBe(false);
  });

  it('plans a generated store registration for an ordinary migration dry-run', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root);
    const output: string[] = [];

    await migrateDocsCommand(root, { dryRun: true, log: (line) => output.push(line) });

    expect(output.join('\n')).toContain(
      `Would run: openspec store register ${path.join(root, 'docs')} --id ${expectedGeneratedStoreId(root)} --yes`,
    );
    expect(configureOpenSpecStore).not.toHaveBeenCalled();
  });

  it('moves a legacy root, registers a generated store, then writes the docs layout', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root);
    const configPath = await writeConfig(root, 'language: zh-CN\ncustom_setting: preserve\n');
    configureOpenSpecStore.mockReturnValue('installed');

    await migrateDocsCommand(root, { apply: true });

    await expect(pathExists(path.join(root, 'openspec'))).resolves.toBe(false);
    await expect(pathExists(path.join(root, 'docs', 'openspec', 'config.yaml'))).resolves.toBe(
      true,
    );
    const config = await fs.readFile(configPath, 'utf8');
    expect(config).toContain('artifact_layout: docs');
    expect(config).toContain('openspec:');
    expect(config).toContain('root: docs');
    expect(config).toContain('superpowers:');
    expect(config).toContain('root: docs/superpowers');
    expect(config).toContain('language: zh-CN');
    expect(config).toContain('custom_setting: preserve');
    expect(config).toContain(`store: ${expectedGeneratedStoreId(root)}`);
    expect(configureOpenSpecStore).toHaveBeenCalledWith(root, expectedGeneratedStoreId(root));
  });

  it('blocks active legacy changes unless includeActive is supplied', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root, 'active-change');
    const legacyStatePath = path.join(root, 'openspec', 'changes', 'active-change', '.comet.yaml');
    await fs.writeFile(
      legacyStatePath,
      [
        'phase: build',
        'artifact_layout: legacy',
        'openspec_root: .',
        'superpowers_root: docs/superpowers',
        'handoff_context: openspec/changes/active-change/.comet/handoff/design-context.json',
        'handoff_hash: abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(migrateDocsCommand(root, { apply: true })).rejects.toThrow(/active changes/i);
    await expect(pathExists(path.join(root, 'openspec'))).resolves.toBe(true);

    await migrateDocsCommand(root, { apply: true, includeActive: true });
    await expect(
      pathExists(path.join(root, 'docs', 'openspec', 'changes', 'active-change')),
    ).resolves.toBe(true);
    const migratedState = await fs.readFile(
      path.join(root, 'docs', 'openspec', 'changes', 'active-change', '.comet.yaml'),
      'utf8',
    );
    expect(migratedState).toContain('artifact_layout: docs');
    expect(migratedState).toContain('openspec_root: docs');
    expect(migratedState).toContain('superpowers_root: docs/superpowers');
    expect(migratedState).not.toContain('handoff_context:');
    expect(migratedState).not.toContain('handoff_hash:');
  });

  it('treats an OpenSpec change without Comet state as active', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root);
    await fs.mkdir(path.join(root, 'openspec', 'changes', 'plain-openspec-change'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, 'openspec', 'changes', 'plain-openspec-change', 'proposal.md'),
      '# Proposal\n',
      'utf8',
    );

    await expect(migrateDocsCommand(root, { apply: true })).rejects.toThrow(
      /plain-openspec-change|include-active/i,
    );
    await expect(
      pathExists(path.join(root, 'openspec', 'changes', 'plain-openspec-change')),
    ).resolves.toBe(true);
  });

  it('invalidates a legacy verification report in active state while preserving a docs path', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root, 'active-change');
    await writeLegacyOpenSpecRoot(root, 'docs-report-change');
    const legacyStatePath = path.join(root, 'openspec', 'changes', 'active-change', '.comet.yaml');
    await fs.writeFile(
      legacyStatePath,
      [
        'phase: verify',
        'verification_report: openspec\\changes\\active-change\\verification.md',
        '',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(root, 'openspec', 'changes', 'docs-report-change', '.comet.yaml'),
      'phase: verify\nverification_report: docs/superpowers/reports/current.md\n',
      'utf8',
    );
    configureOpenSpecStore.mockReturnValue('installed');

    await migrateDocsCommand(root, { apply: true, includeActive: true });

    const migratedState = await fs.readFile(
      path.join(root, 'docs', 'openspec', 'changes', 'active-change', '.comet.yaml'),
      'utf8',
    );
    expect(migratedState).not.toContain('verification_report:');
    await expect(
      fs.readFile(
        path.join(root, 'docs', 'openspec', 'changes', 'docs-report-change', '.comet.yaml'),
        'utf8',
      ),
    ).resolves.toContain('verification_report: docs/superpowers/reports/current.md');
  });

  it('invalidates legacy runtime artifact paths for active changes', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root, 'active-change');
    await writeRuntimeArtifacts(root, 'active-change', {
      handoff_context: 'openspec/changes/active-change/.comet/handoff/design-context.json',
      handoff_markdown: 'openspec/changes/active-change/.comet/handoff/design-context.md',
      subagent_progress: 'openspec/changes/active-change/subagent-progress.md',
      verification_report: 'openspec/changes/active-change/verification.md',
      custom_legacy_path: 'openspec/changes/active-change/runtime/checkpoint.json',
      preserved: 'docs/superpowers/plans/plan.md',
    });

    await migrateDocsCommand(root, { apply: true, includeActive: true });

    const artifacts = JSON.parse(
      await fs.readFile(
        path.join(root, 'docs', 'openspec', 'changes', 'active-change', '.comet', 'artifacts.json'),
        'utf8',
      ),
    ) as Record<string, string>;
    expect(artifacts).toEqual({ preserved: 'docs/superpowers/plans/plan.md' });
  });

  it('restores active runtime artifacts when a later artifact is invalid', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root, 'first-change');
    await writeLegacyOpenSpecRoot(root, 'second-change');
    const firstArtifactsPath = await writeRuntimeArtifacts(root, 'first-change', {
      handoff_context: 'openspec/changes/first-change/.comet/handoff/design-context.json',
    });
    const originalFirstArtifacts = await fs.readFile(firstArtifactsPath, 'utf8');
    const secondArtifactsPath = path.join(
      root,
      'openspec',
      'changes',
      'second-change',
      '.comet',
      'artifacts.json',
    );
    await fs.mkdir(path.dirname(secondArtifactsPath), { recursive: true });
    await fs.writeFile(secondArtifactsPath, '{not valid json\n', 'utf8');

    await expect(migrateDocsCommand(root, { apply: true, includeActive: true })).rejects.toThrow(
      /runtime artifact/i,
    );

    await expect(fs.readFile(firstArtifactsPath, 'utf8')).resolves.toBe(originalFirstArtifacts);
  });

  it('restores every active change state when a later active-state write fails', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root, 'first-change');
    await writeLegacyOpenSpecRoot(root, 'second-change');
    const firstStatePath = path.join(root, 'openspec', 'changes', 'first-change', '.comet.yaml');
    const originalFirstState = 'phase: build\nartifact_layout: legacy\n';
    await fs.writeFile(firstStatePath, originalFirstState, 'utf8');
    writeFileForMigration.mockImplementation(async (file, data, options) => {
      if (
        String(file).endsWith(path.join('second-change', '.comet.yaml')) &&
        String(data).includes('artifact_layout: docs')
      ) {
        throw new Error('second state write failed');
      }
      return fs.writeFile(file, data, options);
    });

    await expect(migrateDocsCommand(root, { apply: true, includeActive: true })).rejects.toThrow(
      /second state write failed/,
    );

    await expect(pathExists(path.join(root, 'openspec', 'changes', 'first-change'))).resolves.toBe(
      true,
    );
    await expect(fs.readFile(firstStatePath, 'utf8')).resolves.toBe(originalFirstState);
  });

  it('registers the configured store and persists it only after registration succeeds', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root);
    const configPath = await writeConfig(root, 'openspec:\n  store: comet-existing-1234\n');
    configureOpenSpecStore.mockReturnValue('installed');

    await migrateDocsCommand(root, { apply: true, repairStore: true });

    expect(configureOpenSpecStore).toHaveBeenCalledWith(root, 'comet-existing-1234');
    const config = await fs.readFile(configPath, 'utf8');
    expect(config).toContain('artifact_layout: docs');
    expect(config).toContain('root: docs');
    expect(config).toContain('store: comet-existing-1234');
  });

  it('rejects repair-store without an explicit or configured store id before moving files', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root);

    await expect(migrateDocsCommand(root, { apply: true, repairStore: true })).rejects.toThrow(
      /openspec-store|store id/i,
    );
    await expect(pathExists(path.join(root, 'openspec'))).resolves.toBe(true);
    await expect(pathExists(path.join(root, 'docs', 'openspec'))).resolves.toBe(false);
  });

  it('restores the legacy root and exact config content when store registration fails', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root);
    const originalConfig = 'language: en\nopenspec:\n  store: comet-existing-1234\n';
    const configPath = await writeConfig(root, originalConfig);
    configureOpenSpecStore.mockReturnValue('failed');

    await expect(migrateDocsCommand(root, { apply: true, repairStore: true })).rejects.toThrow(
      /store configuration failed/i,
    );

    await expect(pathExists(path.join(root, 'openspec', 'config.yaml'))).resolves.toBe(true);
    await expect(pathExists(path.join(root, 'docs', 'openspec'))).resolves.toBe(false);
    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(originalConfig);
  });

  it('restores the legacy root and exact config content when persisting the docs config fails', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root);
    const originalConfig = 'language: en\n';
    const configPath = await writeConfig(root, originalConfig);
    writeFileForMigration.mockImplementation(async (file, data, options) => {
      if (file === configPath && String(data).includes('artifact_layout: docs')) {
        throw new Error('config write failed');
      }
      return fs.writeFile(file, data, options);
    });

    await expect(migrateDocsCommand(root, { apply: true })).rejects.toThrow(/config write failed/i);

    expect(writeFileForMigration).toHaveBeenCalledWith(
      configPath,
      expect.stringContaining('artifact_layout: docs'),
      'utf8',
    );
    await expect(pathExists(path.join(root, 'openspec', 'config.yaml'))).resolves.toBe(true);
    await expect(pathExists(path.join(root, 'docs', 'openspec'))).resolves.toBe(false);
    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(originalConfig);
  });

  it('removes a newly registered store when config persistence fails after registration', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root);
    const configPath = await writeConfig(root, 'language: en\n');
    configureOpenSpecStore.mockReturnValue('installed');
    writeFileForMigration.mockImplementation(async (file, data, options) => {
      if (file === configPath && String(data).includes('artifact_layout: docs')) {
        throw new Error('config write failed');
      }
      return fs.writeFile(file, data, options);
    });

    await expect(
      migrateDocsCommand(root, {
        apply: true,
        repairStore: true,
        openSpecStore: 'comet-new-1234',
      }),
    ).rejects.toThrow(/config write failed/i);

    expect(unregisterOpenSpecStore).toHaveBeenCalledWith(root, 'comet-new-1234');
    await expect(pathExists(path.join(root, 'openspec', 'config.yaml'))).resolves.toBe(true);
  });

  it('removes metadata created by a failed store registration rollback', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root);
    const configPath = await writeConfig(root, 'language: en\n');
    configureOpenSpecStore.mockImplementation((projectPath, storeId) => {
      const metadataPath = path.join(projectPath, 'docs', '.openspec-store', 'store.yaml');
      nodeFs.mkdirSync(path.dirname(metadataPath), { recursive: true });
      nodeFs.writeFileSync(metadataPath, `version: 1\nid: ${storeId}\n`, 'utf8');
      return 'installed';
    });
    writeFileForMigration.mockImplementation(async (file, data, options) => {
      if (file === configPath && String(data).includes('artifact_layout: docs')) {
        throw new Error('config write failed');
      }
      return fs.writeFile(file, data, options);
    });

    await expect(
      migrateDocsCommand(root, {
        apply: true,
        repairStore: true,
        openSpecStore: 'comet-new-1234',
      }),
    ).rejects.toThrow(/config write failed/i);

    await expect(
      pathExists(path.join(root, 'docs', '.openspec-store', 'store.yaml')),
    ).resolves.toBe(false);
    await expect(pathExists(path.join(root, 'docs'))).resolves.toBe(false);
  });

  it('rejects a legacy directory that is not a healthy OpenSpec root', async () => {
    const root = await tempProject();
    await fs.mkdir(path.join(root, 'openspec', 'changes'), { recursive: true });
    await fs.writeFile(path.join(root, 'openspec', 'notes.md'), 'not an OpenSpec root\n', 'utf8');

    await expect(migrateDocsCommand(root, { apply: true })).rejects.toThrow(
      /healthy OpenSpec root/i,
    );
    await expect(pathExists(path.join(root, 'openspec'))).resolves.toBe(true);
    await expect(pathExists(path.join(root, 'docs', 'openspec'))).resolves.toBe(false);
  });

  it('rejects a legacy OpenSpec root that has no archive directory', async () => {
    const root = await tempProject();
    await fs.mkdir(path.join(root, 'openspec', 'changes'), { recursive: true });
    await fs.mkdir(path.join(root, 'openspec', 'specs'), { recursive: true });
    await fs.writeFile(path.join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n', 'utf8');

    await expect(migrateDocsCommand(root, { apply: true })).rejects.toThrow(
      /healthy OpenSpec root.*archive/i,
    );
    await expect(pathExists(path.join(root, 'openspec'))).resolves.toBe(true);
    await expect(pathExists(path.join(root, 'docs', 'openspec'))).resolves.toBe(false);
  });

  it('rejects conflicting apply and dry-run options before changing files', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root);

    await expect(migrateDocsCommand(root, { apply: true, dryRun: true })).rejects.toThrow(
      /apply and --dry-run/i,
    );
    await expect(pathExists(path.join(root, 'openspec'))).resolves.toBe(true);
  });

  it('merges healthy legacy and docs roots without conflicting contents', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root, 'legacy-change');
    await writeDocsOpenSpecRoot(root);
    await fs.mkdir(path.join(root, 'openspec', 'changes', 'archive', 'legacy-archive'), {
      recursive: true,
    });
    await fs.mkdir(path.join(root, 'openspec', 'specs', 'legacy-spec'), { recursive: true });
    configureOpenSpecStore.mockReturnValue('installed');

    await migrateDocsCommand(root, { apply: true, includeActive: true });

    await expect(pathExists(path.join(root, 'openspec'))).resolves.toBe(false);
    await expect(
      pathExists(path.join(root, 'docs', 'openspec', 'changes', 'legacy-change')),
    ).resolves.toBe(true);
    await expect(
      pathExists(path.join(root, 'docs', 'openspec', 'changes', 'archive', 'legacy-archive')),
    ).resolves.toBe(true);
    await expect(
      pathExists(path.join(root, 'docs', 'openspec', 'specs', 'legacy-spec')),
    ).resolves.toBe(true);
  });

  it('rejects a configured store registered to another root before moving files', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root);
    await writeConfig(root, 'openspec:\n  store: comet-shared-1234\n');
    getOpenSpecStoreRoot.mockReturnValue(path.join(root, '..', 'another-project', 'docs'));

    await expect(migrateDocsCommand(root, { apply: true })).rejects.toThrow(
      /registered to another root|new id/i,
    );
    await expect(pathExists(path.join(root, 'openspec'))).resolves.toBe(true);
    await expect(pathExists(path.join(root, 'docs', 'openspec'))).resolves.toBe(false);
    expect(configureOpenSpecStore).not.toHaveBeenCalled();
  });

  it('rejects a configured store registered to another root during dry-run', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root);
    await writeConfig(root, 'openspec:\n  store: comet-shared-1234\n');
    getOpenSpecStoreRoot.mockReturnValue(path.join(root, '..', 'another-project', 'docs'));

    await expect(migrateDocsCommand(root, { dryRun: true })).rejects.toThrow(
      /registered to another root|new id/i,
    );
    await expect(pathExists(path.join(root, 'openspec'))).resolves.toBe(true);
    await expect(pathExists(path.join(root, 'docs', 'openspec'))).resolves.toBe(false);
    expect(configureOpenSpecStore).not.toHaveBeenCalled();
  });

  it('rejects a conflicting legacy spec before changing either healthy root', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root);
    await writeDocsOpenSpecRoot(root);
    await fs.mkdir(path.join(root, 'openspec', 'specs', 'shared-spec'), { recursive: true });
    await fs.mkdir(path.join(root, 'docs', 'openspec', 'specs', 'shared-spec'), {
      recursive: true,
    });

    await expect(migrateDocsCommand(root, { apply: true })).rejects.toThrow(
      /conflicting spec 'shared-spec'/i,
    );
    await expect(pathExists(path.join(root, 'openspec', 'specs', 'shared-spec'))).resolves.toBe(
      true,
    );
    await expect(
      pathExists(path.join(root, 'docs', 'openspec', 'specs', 'shared-spec')),
    ).resolves.toBe(true);
  });

  it('moves a non-config root entry while merging healthy OpenSpec roots', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root);
    await writeDocsOpenSpecRoot(root);
    await fs.writeFile(path.join(root, 'openspec', 'README.md'), 'legacy notes\n', 'utf8');

    await migrateDocsCommand(root, { apply: true });

    await expect(pathExists(path.join(root, 'openspec'))).resolves.toBe(false);
    await expect(
      fs.readFile(path.join(root, 'docs', 'openspec', 'README.md'), 'utf8'),
    ).resolves.toBe('legacy notes\n');
  });

  it('rejects a conflicting non-config root entry before merging healthy OpenSpec roots', async () => {
    const root = await tempProject();
    await writeLegacyOpenSpecRoot(root);
    await writeDocsOpenSpecRoot(root);
    await fs.writeFile(path.join(root, 'openspec', 'README.md'), 'legacy notes\n', 'utf8');
    await fs.writeFile(path.join(root, 'docs', 'openspec', 'README.md'), 'docs notes\n', 'utf8');

    await expect(migrateDocsCommand(root, { apply: true })).rejects.toThrow(
      /conflicting root entry 'README.md'/i,
    );
    await expect(fs.readFile(path.join(root, 'openspec', 'README.md'), 'utf8')).resolves.toBe(
      'legacy notes\n',
    );
    await expect(
      fs.readFile(path.join(root, 'docs', 'openspec', 'README.md'), 'utf8'),
    ).resolves.toBe('docs notes\n');
  });

  it('allows a docs-only root to repair and register a store without claiming a migration', async () => {
    const root = await tempProject();
    await writeDocsOpenSpecRoot(root);
    const output: string[] = [];
    configureOpenSpecStore.mockReturnValue('installed');

    await migrateDocsCommand(root, {
      apply: true,
      repairStore: true,
      openSpecStore: 'comet-docs-1234',
      log: (line) => output.push(line),
    });

    expect(configureOpenSpecStore).toHaveBeenCalledWith(root, 'comet-docs-1234');
    expect(output.join('\n')).not.toContain('Migrated:');
    await expect(pathExists(path.join(root, 'openspec'))).resolves.toBe(false);
    const config = await fs.readFile(path.join(root, '.comet', 'config.yaml'), 'utf8');
    expect(config).toContain('artifact_layout: docs');
    expect(config).toContain('store: comet-docs-1234');
  });

  it('re-registers an existing matching store so missing local metadata is repaired', async () => {
    const root = await tempProject();
    await writeDocsOpenSpecRoot(root);
    getOpenSpecStoreRoot.mockReturnValue(path.join(root, 'docs'));

    await migrateDocsCommand(root, {
      apply: true,
      repairStore: true,
      openSpecStore: 'comet-docs-1234',
    });

    expect(configureOpenSpecStore).toHaveBeenCalledWith(root, 'comet-docs-1234');
    expect(unregisterOpenSpecStore).not.toHaveBeenCalled();
  });

  it('repairs missing empty OpenSpec directories before registering a docs-only store', async () => {
    const root = await tempProject();
    const openSpecRoot = path.join(root, 'docs', 'openspec');
    await fs.mkdir(path.join(openSpecRoot, 'changes'), { recursive: true });
    await fs.mkdir(path.join(openSpecRoot, 'specs'), { recursive: true });
    await fs.writeFile(path.join(openSpecRoot, 'config.yaml'), 'schema: spec-driven\n', 'utf8');

    await migrateDocsCommand(root, {
      apply: true,
      repairStore: true,
      openSpecStore: 'comet-docs-1234',
    });

    await expect(fs.stat(path.join(openSpecRoot, 'changes', 'archive'))).resolves.toBeDefined();
    expect(configureOpenSpecStore).toHaveBeenCalledWith(root, 'comet-docs-1234');
  });
});
