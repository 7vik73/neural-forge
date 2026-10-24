import { constants } from 'node:fs';
import { open, realpath, readdir, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, extname, isAbsolute } from 'node:path';
import { Limits } from '@forge/contracts';

export class LocalFiles {
  constructor(private readonly root: string) {}
  async path(name: string, create = false): Promise<string> {
    if (isAbsolute(name) || name.includes('\0') || name.includes('\\'))
      throw new Error('Use a relative path inside your selected folder.');
    const root = await realpath(this.root);
    const target = resolve(root, name);
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel))
      throw new Error('This file is outside your selected folder.');
    const resolved = await realpath(create ? dirname(target) : target);
    const safe = relative(root, resolved);
    if (safe.startsWith('..') || isAbsolute(safe))
      throw new Error('Links outside the selected folder are not allowed.');
    return target;
  }
  async list(folder = '') {
    const path = await this.path(folder);
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          e.isFile() && ['.txt', '.md', '.json', '.csv'].includes(extname(e.name).toLowerCase()),
      )
      .map((e) => ({ path: [folder, e.name].filter(Boolean).join('/') }));
  }
  private checkType(name: string) {
    if (!['.txt', '.md', '.json', '.csv'].includes(extname(name).toLowerCase()))
      throw new Error('Choose a .txt, .md, .json, or .csv file.');
  }
  async read(name: string) {
    this.checkType(name);
    const path = await this.path(name);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > Limits.fileBytes)
        throw new Error('Choose a regular file smaller than 20 MB.');
      return { path: name, text: await file.readFile('utf8') };
    } finally {
      await file.close();
    }
  }
  async write(name: string, text: string, create: boolean) {
    this.checkType(name);
    if (Buffer.byteLength(text) > Limits.fileBytes) throw new Error('File content exceeds 20 MB.');
    const path = await this.path(name, create);
    if (!create && !(await lstat(path)).isFile())
      throw new Error('Choose a regular existing file.');
    const flags =
      constants.O_WRONLY |
      constants.O_NOFOLLOW |
      (create ? constants.O_CREAT | constants.O_EXCL : 0);
    const file = await open(path, flags, 0o600);
    try {
      await file.truncate(0);
      await file.writeFile(text, 'utf8');
    } finally {
      await file.close();
    }
    return { path: name };
  }
}
