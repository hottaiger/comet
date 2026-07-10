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
