import { resolveCometChangeDirectory } from './classic-artifact-layout.js';

export interface ClassicChangeDirectory {
  label: string;
  directory: string;
}

export function openSpecChangeNameError(name: string | undefined): string | null {
  if (!name) return 'Change name cannot be empty';
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name)) {
    return `Invalid change name: '${name}'\nValid format: lowercase kebab-case (a-z, 0-9, single hyphens)`;
  }
  if (name.includes('..')) return "Change name cannot contain '..' (path traversal not allowed)";
  return null;
}

export function assertOpenSpecChangeName(name: string | undefined): asserts name is string {
  const error = openSpecChangeNameError(name);
  if (error) throw new Error(error);
}

export async function resolveClassicChangeDirectory(name: string): Promise<ClassicChangeDirectory> {
  return resolveCometChangeDirectory(process.cwd(), name);
}
