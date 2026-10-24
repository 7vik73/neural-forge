import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const values = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((s) => s && !s.startsWith('#'))
    .map((s) => {
      const i = s.indexOf('=');
      return [s.slice(0, i), s.slice(i + 1)];
    }),
);
const url = new URL(process.env.TEST_DATABASE_URL ?? values.DATABASE_URL);
if (!process.env.TEST_DATABASE_URL) url.pathname = '/forge_test';
if (!url.pathname.endsWith('_test')) throw new Error('Test database names must end in _test.');
const result = spawnSync(
  process.execPath,
  [
    'apps/backend/node_modules/prisma/build/index.js',
    'migrate',
    'deploy',
    '--schema',
    'apps/backend/prisma/schema.prisma',
  ],
  { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
