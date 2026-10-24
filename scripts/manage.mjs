import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const requestedAction = process.argv[2] ?? 'start';
const legacyRestore = requestedAction === 'migrate-backup';
const action = legacyRestore ? 'restore' : requestedAction;
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status) throw new Error(`${program} exited with status ${result.status}.`);
  return result;
}
function env() {
  return Object.fromEntries(
    readFileSync('.env', 'utf8')
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}
function setup() {
  mkdirSync('.local/files', { recursive: true });
  mkdirSync('.local/workspaces', { recursive: true });
  if (!existsSync('.env')) {
    const password = randomBytes(24).toString('hex');
    const redis = randomBytes(24).toString('hex');
    const folder = process.env.FORGE_HOST_ROOT
      ? `${process.env.FORGE_HOST_ROOT.replaceAll('\\', '/')}/.local/files`
      : resolve('.local/files');
    let content = readFileSync('.env.example', 'utf8')
      .replaceAll('POSTGRES_PASSWORD=generated-by-setup', `POSTGRES_PASSWORD=${password}`)
      .replaceAll('forge:generated-by-setup@', `forge:${password}@`)
      .replaceAll('REDIS_PASSWORD=generated-by-setup', `REDIS_PASSWORD=${redis}`)
      .replaceAll('redis://:generated-by-setup@', `redis://:${redis}@`)
      .replace(
        'ENCRYPTION_KEY=generated-by-setup',
        `ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`,
      )
      .replace('LOCAL_FOLDER=./.local/files', `LOCAL_FOLDER=${folder}`)
      .replace(
        'WORKSPACE_STORAGE_ROOT=./.local/workspaces',
        `WORKSPACE_STORAGE_ROOT=${folder.replace(/files$/, 'workspaces')}`,
      );
    writeFileSync('.env', content, { mode: 0o600 });
    console.log('Created private installation settings.');
  }
  if (!/^WORKSPACE_STORAGE_ROOT=/m.test(readFileSync('.env', 'utf8'))) {
    const base = process.env.FORGE_HOST_ROOT?.replaceAll('\\', '/') ?? root;
    writeFileSync(
      '.env',
      `${readFileSync('.env', 'utf8').trimEnd()}\nWORKSPACE_STORAGE_ROOT=${base}/.local/workspaces\n`,
      { mode: 0o600 },
    );
  }
  const configuration = env();
  const gateway = new URL(configuration.OLLAMA_URL);
  gateway.hostname = 'host.docker.internal';
  const line = `OLLAMA_GATEWAY_URL=${gateway.toString().replace(/\/$/, '')}`;
  const content = readFileSync('.env', 'utf8');
  writeFileSync(
    '.env',
    /^OLLAMA_GATEWAY_URL=/m.test(content)
      ? content.replace(/^OLLAMA_GATEWAY_URL=.*$/m, line)
      : `${content.trimEnd()}\n${line}\n`,
    { mode: 0o600 },
  );
}
const compose = (...args) =>
  command('docker', [
    'compose',
    '-f',
    'compose.yaml',
    ...(existsSync('.local/network-mode') &&
    readFileSync('.local/network-mode', 'utf8').trim() === 'bridge'
      ? ['-f', 'compose.bridge.yaml']
      : []),
    '--profile',
    'app',
    ...args,
  ]);
const passphrase = async () => {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const value =
      process.env.BACKUP_PASSPHRASE ??
      (await prompt.question('Backup passphrase (12+ characters; input is visible): '));
    if (value.length < 12) throw new Error('Use a passphrase of at least 12 characters.');
    return value;
  } finally {
    prompt.close();
  }
};
try {
  if (action === 'setup') {
    setup();
    console.log('Setup complete. Start with ./start.sh or ./start.ps1.');
  } else if (action === 'link') {
    const configuration = env();
    console.log(`Open your workspace: ${configuration.APP_URL}`);
  } else if (action === 'start') {
    setup();
    command('docker', ['info'], { stdio: 'ignore' });
    const configuration = env();
    const probeArgs = [
      'run',
      '--rm',
      '--network',
      'host',
      '-v',
      `${root}:/project:ro`,
      '-w',
      '/project',
      'node:24.18.0-bookworm-slim',
      'node',
      'scripts/ollama-check.mjs',
    ];
    const probe = spawnSync('docker', probeArgs, { stdio: 'ignore', timeout: 20_000 });
    if (probe.status === 0) writeFileSync('.local/network-mode', 'host');
    else {
      writeFileSync('.local/network-mode', 'bridge');
      console.log('Using Docker bridge networking. Ollama is optional; connect Gemini in the app.');
    }
    compose('up', '-d', '--build', '--wait');
    console.log(`\nOpen your workspace: ${configuration.APP_URL}\nCreate an account or sign in.`);
  } else if (action === 'stop') compose('stop');
  else if (action === 'status') compose('ps');
  else if (action === 'diagnostics') {
    setup();
    const configuration = env();
    command('docker', ['version']);
    compose('ps');
    try {
      console.log(
        'App health:',
        await (
          await fetch(`${configuration.APP_URL}/api/v1/system/health`, {
            signal: AbortSignal.timeout(10_000),
          })
        ).json(),
      );
    } catch {
      console.log('App is not reachable. Inspect logs and enable Docker Desktop host networking.');
    }
    compose('logs', '--tail', '30', 'api', 'worker');
  } else if (action === 'backup') {
    const password = await passphrase();
    const configuration = env();
    const stopped = spawnSync('docker', ['compose', '--profile', 'app', 'stop', 'worker', 'api'], {
      stdio: 'inherit',
    });
    if (stopped.status) throw new Error('Could not pause the application for backup.');
    try {
      const schema = spawnSync(
        'docker',
        [
          'compose',
          'exec',
          '-T',
          'postgres',
          'psql',
          '-U',
          configuration.POSTGRES_USER,
          '-d',
          configuration.POSTGRES_DB,
          '-tAc',
          `SELECT CASE WHEN to_regclass('public."User"') IS NULL THEN 0 ELSE 1 END`,
        ],
        { encoding: 'utf8' },
      );
      if (schema.status) throw new Error('Could not identify the database backup format.');
      const multiuser = schema.stdout.trim() === '1';
      const dump = spawnSync(
        'docker',
        [
          'compose',
          'exec',
          '-T',
          'postgres',
          'pg_dump',
          '-U',
          configuration.POSTGRES_USER,
          '-d',
          configuration.POSTGRES_DB,
          '--clean',
          '--if-exists',
        ],
        { maxBuffer: 512 * 1024 * 1024 },
      );
      if (dump.status) throw new Error('Database backup failed.');
      const archive = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${multiuser ? configuration.WORKSPACE_STORAGE_ROOT : configuration.LOCAL_FOLDER}:/files:ro`,
          'postgres:17.6-alpine',
          'tar',
          '-C',
          '/files',
          '-czf',
          '-',
          '.',
        ],
        { maxBuffer: 512 * 1024 * 1024 },
      );
      if (archive.status) throw new Error('File backup failed.');
      const payload = JSON.stringify({
        format: 1,
        database: dump.stdout.toString('base64'),
        files: archive.stdout.toString('base64'),
        configuration,
      });
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv);
      const data = Buffer.concat([cipher.update(payload), cipher.final()]);
      const filename = resolve('.local', `backup-${Date.now()}.json`);
      writeFileSync(
        filename,
        JSON.stringify({
          format: 'neural-forge-full',
          version: multiuser ? 2 : 1,
          salt: salt.toString('hex'),
          iv: iv.toString('hex'),
          tag: cipher.getAuthTag().toString('hex'),
          data: data.toString('base64'),
        }),
        { mode: 0o600 },
      );
      console.log(`Encrypted backup saved to ${filename}`);
    } finally {
      compose('start', 'api', 'worker');
    }
  } else if (action === 'restore') {
    setup();
    const filename = process.argv[3];
    if (!filename) throw new Error('Usage: node scripts/manage.mjs restore /path/to/backup.json');
    const backup = JSON.parse(readFileSync(filename, 'utf8'));
    if (backup.format !== 'neural-forge-full' || ![1, 2].includes(backup.version))
      throw new Error('Choose a full launcher backup. Browser backups are restored in Settings.');
    if (backup.version === 1 && !legacyRestore)
      throw new Error('Use migrate-backup for a legacy installation archive.');
    const password = await passphrase();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      scryptSync(password, Buffer.from(backup.salt, 'hex'), 32),
      Buffer.from(backup.iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(backup.tag, 'hex'));
    const payload = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(backup.data, 'base64')),
        decipher.final(),
      ]).toString(),
    );
    const configuration = env();
    const check = spawnSync(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        configuration.POSTGRES_USER,
        '-d',
        configuration.POSTGRES_DB,
        '-tAc',
        'SELECT (SELECT count(*) FROM "User") + (SELECT count(*) FROM "Workspace") + (SELECT count(*) FROM "Workflow") + (SELECT count(*) FROM "Note") + (SELECT count(*) FROM "Connection") + (SELECT count(*) FROM "Run")',
      ],
      { encoding: 'utf8' },
    );
    if (
      check.status ||
      Number(check.stdout.trim()) !== 0 ||
      readdirSync(configuration.WORKSPACE_STORAGE_ROOT).length ||
      (legacyRestore && readdirSync(configuration.LOCAL_FOLDER).length)
    )
      throw new Error(
        'Restore requires an empty database and local folder. Create a separate empty installation first.',
      );
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question('Restore into this empty installation? Type RESTORE: ');
    prompt.close();
    if (answer !== 'RESTORE') throw new Error('Restore cancelled.');
    compose('stop', 'api', 'worker');
    if (legacyRestore)
      command('docker', [
        'compose',
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        configuration.POSTGRES_USER,
        '-d',
        configuration.POSTGRES_DB,
        '-c',
        'DROP SCHEMA public CASCADE; CREATE SCHEMA public;',
      ]);
    command(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        configuration.POSTGRES_USER,
        '-d',
        configuration.POSTGRES_DB,
        '--set',
        'ON_ERROR_STOP=on',
      ],
      { input: Buffer.from(payload.database, 'base64'), stdio: ['pipe', 'inherit', 'inherit'] },
    );
    command(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '-v',
        `${legacyRestore ? configuration.LOCAL_FOLDER : configuration.WORKSPACE_STORAGE_ROOT}:/files`,
        'postgres:17.6-alpine',
        'tar',
        '-C',
        '/files',
        '-xzf',
        '-',
      ],
      { input: Buffer.from(payload.files, 'base64'), stdio: ['pipe', 'inherit', 'inherit'] },
    );
    const content = readFileSync('.env', 'utf8').replace(
      /^ENCRYPTION_KEY=.*$/m,
      `ENCRYPTION_KEY=${payload.configuration.ENCRYPTION_KEY}`,
    );
    writeFileSync('.env', content, { mode: 0o600 });
    command('docker', [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      configuration.POSTGRES_USER,
      '-d',
      configuration.POSTGRES_DB,
      '-c',
      "UPDATE \"Workflow\" SET enabled=false, \"webhookHash\"=NULL; DELETE FROM \"Session\"; DELETE FROM \"Outbox\"; UPDATE \"Run\" SET status='cancelled', error='Interrupted by restore' WHERE status IN ('queued','running','waiting'); UPDATE \"NodeExecution\" SET status='cancelled', \"leaseUntil\"=NULL, \"wakeAt\"=NULL WHERE status IN ('pending','running','waiting'); UPDATE \"NodeAttempt\" SET status='cancelled', \"finishedAt\"=CURRENT_TIMESTAMP WHERE status IN ('running','waiting'); UPDATE \"RunScope\" SET status='cancelled' WHERE status='running';",
    ]);
    if (!legacyRestore)
      command('docker', [
        'compose',
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        configuration.POSTGRES_USER,
        '-d',
        configuration.POSTGRES_DB,
        '-c',
        'DELETE FROM "AccountToken";',
      ]);
    compose('up', '-d', '--wait', 'migrate', 'api', 'worker');
    console.log(
      'Restored. Sign in with the original password, test connections, and review workflows before enabling them.',
    );
  } else if (action === 'reset-admin') {
    command(process.execPath, [
      '--env-file=.env',
      'scripts/account-admin.mjs',
      process.argv[3] ?? '',
    ]);
  } else if (action === 'migrate-workspace-backup') {
    const password = await passphrase();
    compose('stop', 'api', 'worker');
    try {
      command(
        process.execPath,
        [
          '--env-file=.env',
          'scripts/migrate-workspace-backup.mjs',
          process.argv[3] ?? '',
          process.argv[4] ?? '',
        ],
        { env: { ...process.env, BACKUP_PASSPHRASE: password } },
      );
    } finally {
      compose('start', 'api', 'worker');
    }
  } else if (action === 'upgrade') {
    console.log('Creating a backup before applying migrations…');
    command(process.execPath, [fileURLToPath(import.meta.url), 'backup']);
    setup();
    compose('stop', 'api', 'worker', 'web');
    compose('up', '-d', '--build', '--wait');
  } else
    throw new Error(
      'Use setup, start, stop, status, diagnostics, backup, restore, upgrade, reset-admin, migrate-backup, or migrate-workspace-backup.',
    );
} catch (error) {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
}
