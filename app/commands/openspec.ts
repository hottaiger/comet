import { spawnSync } from 'child_process';
import path from 'path';
import { resolveCometArtifactLayout } from '../../domains/comet-classic/classic-artifact-layout.js';
import { assertOpenSpecStoreRegistration } from '../../domains/integrations/openspec.js';
import { quoteArgsForShell } from '../../platform/process/shell-quote.js';

interface OpenSpecFacadeOptions {
  json?: boolean;
}

const STORE_AWARE_COMMANDS = new Set([
  'archive',
  'context',
  'doctor',
  'instructions',
  'list',
  'new',
  'show',
  'status',
  'validate',
]);

function primaryCommand(args: readonly string[]): string | undefined {
  let index = 0;
  while (args[index] === '--no-color') index += 1;
  return args[index];
}

function isStoreManagementCommand(args: readonly string[]): boolean {
  return primaryCommand(args) === 'store';
}

export async function openspecCommand(
  targetPath: string,
  args: string[],
  options: OpenSpecFacadeOptions = {},
): Promise<void> {
  const projectRoot = path.resolve(targetPath);
  const layout = await resolveCometArtifactLayout(projectRoot);
  const openSpecExecutable = process.env.COMET_OPENSPEC || 'openspec';
  const storeManagementCommand = isStoreManagementCommand(args);
  const useConfiguredStore =
    !storeManagementCommand && STORE_AWARE_COMMANDS.has(primaryCommand(args) ?? '');
  if (useConfiguredStore && layout.openSpec.storeId) {
    assertOpenSpecStoreRegistration(projectRoot, layout.openSpec.storeId, openSpecExecutable);
  }
  const useShell = process.platform === 'win32';
  const commandArgs = [...args, ...(useConfiguredStore ? layout.openSpec.commandArgs : [])];
  const shellArgs = useShell ? quoteArgsForShell(commandArgs) : commandArgs;
  const result = spawnSync(openSpecExecutable, shellArgs, {
    cwd:
      storeManagementCommand || useConfiguredStore
        ? layout.openSpec.commandCwd
        : layout.openSpec.storeRoot,
    env: { ...process.env, OPENSPEC_TELEMETRY: '0' },
    encoding: 'utf8',
    shell: useShell,
  });

  if (!options.json && !storeManagementCommand && layout.layout === 'docs') {
    process.stderr.write(
      `Using OpenSpec root: ${layout.openSpec.storeId ?? layout.openSpec.storeRoot}\n`,
    );
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
