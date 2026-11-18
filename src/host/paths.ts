import fs from 'node:fs';
import path from 'node:path';

export function isInsideWorkspace(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/** Check both the requested path and its nearest existing ancestor (including symlinks). */
export function resolveWorkspacePath(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  if (!isInsideWorkspace(root, target)) throw new Error(`path escapes workspace: ${relative}`);
  let ancestor = target;
  for (;;) {
    try {
      fs.lstatSync(ancestor);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw e;
      ancestor = parent;
    }
  }
  if (!isInsideWorkspace(fs.realpathSync(root), fs.realpathSync(ancestor))) {
    throw new Error(`path escapes workspace through a symlink: ${relative}`);
  }
  return target;
}
