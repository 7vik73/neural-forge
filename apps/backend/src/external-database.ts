import ipaddr from 'ipaddr.js';
import { createConnection } from 'node:net';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { Client } from 'pg';
import mysql from 'mysql2/promise';
import { OperationError, type JsonObject } from '@forge/contracts';
import { config } from './config.js';
const identifier = (name: string, kind: string) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name))
    throw new Error('Choose a simple table or column name from the selector.');
  return kind === 'mysql' ? `\`${name}\`` : `"${name}"`;
};
const values = (data: unknown, label: string) => {
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !Object.keys(data).length ||
    Object.keys(data).length > 50
  )
    throw new Error(`Set ${label} as an object of column names and values.`);
  if (
    Object.values(data).some(
      (v) => v !== null && !['string', 'number', 'boolean'].includes(typeof v),
    )
  )
    throw new Error('Database values must be text, numbers, booleans or null.');
  return Object.entries(data);
};
export function databaseStatement(kind: string, action: string, table: string, input: JsonObject) {
  const t = identifier(table, kind),
    params: unknown[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return kind === 'mysql' ? '?' : `$${params.length}`;
  };
  const filters = input.filter ? values(input.filter, 'filters') : [];
  const predicate = () =>
    filters
      .map(([k, v]) =>
        v === null ? `${identifier(k, kind)} IS NULL` : `${identifier(k, kind)} = ${bind(v)}`,
      )
      .join(' AND ');
  let sql: string;
  if (action === 'read') {
    const where = predicate();
    sql = `SELECT * FROM ${t}${where ? ` WHERE ${where}` : ''} LIMIT 1000`;
  } else if (action === 'insert') {
    const fields = values(input.values, 'column values');
    sql = `INSERT INTO ${t} (${fields.map(([k]) => identifier(k, kind)).join(',')}) VALUES (${fields.map(([, v]) => bind(v)).join(',')})`;
  } else if (action === 'update') {
    if (!filters.length) throw new Error('Choose at least one filter before updating rows.');
    const fields = values(input.values, 'column values');
    const set = fields.map(([k, v]) => `${identifier(k, kind)} = ${bind(v)}`).join(',');
    const where = predicate();
    sql =
      kind === 'mysql'
        ? `UPDATE ${t} SET ${set} WHERE ${where} LIMIT 1000`
        : `UPDATE ${t} SET ${set} WHERE (tableoid,ctid) IN (SELECT tableoid,ctid FROM ${t} WHERE ${where} LIMIT 1000)`;
  } else throw new Error('Unsupported database operation.');
  return { sql, params };
}
export async function checkDatabaseDestination(c: Record<string, string>) {
  const port = Number(c.port);
  if (!c.host || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Set a valid database host and port.');
  if (['postgres', 'redis', 'api', 'web'].includes(c.host.toLowerCase()))
    throw new Error('Installation services cannot be used as external database connections.');
  const hostPorts = new Set([
    45432,
    46379,
    4300,
    config.port,
    Number(new URL(config.ollamaUrl).port || 11434),
  ]);
  if (
    ['localhost', 'host.docker.internal', 'gateway.docker.internal'].includes(
      c.host.toLowerCase(),
    ) &&
    hostPorts.has(port)
  )
    throw new Error('Installation services cannot be used as external database connections.');
  const addresses = await lookup(c.host, { all: true });
  if (!addresses.length) throw new Error('Database host could not be resolved.');
  const gateway = await lookup('host.docker.internal', { all: true }).catch(() => []);
  if (
    hostPorts.has(port) &&
    addresses.some(
      (a) =>
        ipaddr.process(a.address).range() === 'loopback' ||
        gateway.some(
          (b) => ipaddr.process(a.address).toString() === ipaddr.process(b.address).toString(),
        ),
    )
  )
    throw new Error('Installation services cannot be used as external database connections.');
  const protectedURLs = [
    config.redisUrl,
    config.ollamaUrl,
    config.appUrl,
    process.env.DATABASE_URL ?? 'http://127.0.0.1:45432',
    `http://127.0.0.1:${config.port}`,
  ].map((s) => new URL(s));
  for (const url of protectedURLs) {
    const p = Number(
      url.port || (url.protocol === 'redis:' ? 6379 : url.protocol === 'postgresql:' ? 5432 : 80),
    );
    if (port !== p) continue;
    const protectedAddresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), {
      all: true,
    }).catch(() => []);
    if (
      c.host.toLowerCase() === url.hostname.toLowerCase() ||
      addresses.some((a) =>
        protectedAddresses.some(
          (b) => ipaddr.process(a.address).toString() === ipaddr.process(b.address).toString(),
        ),
      )
    )
      throw new Error('Installation services cannot be used as external database connections.');
  }
  if (
    addresses.some((a) =>
      ['169.254.169.254', '0.0.0.0', '::'].includes(ipaddr.process(a.address).toString()),
    )
  )
    throw new Error('Choose a valid external database destination.');
  // Pin the resolved address for the connection, preventing a second DNS lookup.
  return addresses[0]!.address;
}
export async function externalDatabase(
  kind: string,
  c: Record<string, string>,
  action: string,
  table = '',
  input: JsonObject = {},
) {
  const host = await checkDatabaseDestination(c);
  if (c.tls !== 'false' && isIP(c.host!))
    throw new Error(
      'Use a DNS hostname for verified TLS, or explicitly disable TLS for a trusted local test database.',
    );
  let client: any;
  try {
    if (kind === 'mysql')
      client = await mysql.createConnection({
        host: c.host,
        stream: () => createConnection({ host, port: Number(c.port) }),
        port: Number(c.port),
        database: c.database,
        user: c.user,
        password: c.password,
        connectTimeout: 10000,
        multipleStatements: false,
        ssl: c.tls === 'false' ? undefined : { rejectUnauthorized: true, verifyIdentity: true },
        supportBigNumbers: true,
        bigNumberStrings: true,
      });
    else {
      client = new Client({
        host,
        port: Number(c.port),
        database: c.database,
        user: c.user,
        password: c.password,
        connectionTimeoutMillis: 10000,
        query_timeout: 30000,
        statement_timeout: 30000,
        ssl: c.tls === 'false' ? false : { rejectUnauthorized: true, servername: c.host },
      });
      await client.connect();
    }
    const query = async (sql: string, params: unknown[] = []) => {
      if (kind === 'mysql') {
        const [rows]: any = await client.execute({ sql, timeout: 30000 }, params);
        return { rows: Array.isArray(rows) ? rows : [], count: rows.affectedRows ?? 0 };
      }
      const result = await client.query(sql, params);
      return { rows: result.rows, count: result.rowCount };
    };
    if (action === 'test') {
      await query('SELECT 1');
      return { items: [], updated: 0 };
    }
    if (action === 'tables') {
      const { rows } = await query(
        kind === 'mysql'
          ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' LIMIT 1000"
          : "SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' LIMIT 1000",
      );
      return { items: rows.map((r: any) => ({ id: r.name, name: r.name })), updated: 0 };
    }
    const { sql, params } = databaseStatement(kind, action, table, input);
    const result = await query(sql, params);
    return JSON.parse(
      JSON.stringify({ items: result.rows, updated: result.count }, (_, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    );
  } catch (error) {
    if (error instanceof OperationError) throw error;
    const uncertain =
      [
        'ECONNRESET',
        'ETIMEDOUT',
        'EPIPE',
        'PROTOCOL_SEQUENCE_TIMEOUT',
        'PROTOCOL_CONNECTION_LOST',
      ].includes((error as any).code) ||
      /timeout|connection terminated|connection closed|socket hang up/i.test(
        (error as Error).message,
      );
    throw new OperationError(
      'The database operation failed. Check table names, credentials and permissions.',
      uncertain,
      uncertain && ['insert', 'update'].includes(action),
    );
  } finally {
    await client?.end().catch(() => {});
  }
}
