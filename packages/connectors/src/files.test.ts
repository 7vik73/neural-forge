import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFiles } from './files.js';
let root: string;
let files: LocalFiles;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'forge-files-'));
  files = new LocalFiles(root);
});
afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});
describe('configured folder interface', () => {
  it('creates, reads and updates supported text files', async () => {
    await files.write('note.md', 'Hello', true);
    expect(await files.read('note.md')).toEqual({ path: 'note.md', text: 'Hello' });
    await files.write('note.md', 'Changed', false);
    expect((await files.read('note.md')).text).toBe('Changed');
  });
  it('does not overwrite an existing file with Create', async () => {
    await files.write('data.json', '{}', true);
    await expect(files.write('data.json', '[]', true)).rejects.toThrow();
    expect((await files.read('data.json')).text).toBe('{}');
  });
  it('rejects traversal, absolute paths and unsupported files', async () => {
    await expect(files.read('../outside.txt')).rejects.toThrow('outside');
    await expect(files.read('/tmp/outside.txt')).rejects.toThrow('relative');
    await expect(files.write('app.js', 'danger', true)).rejects.toThrow('Choose');
  });
  it('rejects escaping directory and file symlinks', async () => {
    await symlink(tmpdir(), join(root, 'outside'));
    await expect(files.write('outside/hack.txt', 'bad', true)).rejects.toThrow('outside');
    await symlink('/etc/hosts', join(root, 'hosts.txt'));
    await expect(files.read('hosts.txt')).rejects.toThrow('outside');
  });
  it('lists supported regular files, excluding symlinks and executables', async () => {
    await files.write('a.txt', 'a', true);
    await writeFile(join(root, 'b.js'), '');
    await mkdir(join(root, 'folder'));
    await symlink(join(root, 'a.txt'), join(root, 'link.txt'));
    expect(await files.list()).toEqual([{ path: 'a.txt' }]);
  });
});
