import { resolveCometChangeDirectory } from './classic-artifact-layout.js';
import { assertOpenSpecChangeName, openSpecChangeNameError } from './classic-change-name.js';

export interface ClassicChangeDirectory {
  label: string;
  directory: string;
}

export { assertOpenSpecChangeName, openSpecChangeNameError };

export async function resolveClassicChangeDirectory(name: string): Promise<ClassicChangeDirectory> {
  return resolveCometChangeDirectory(process.cwd(), name);
}
