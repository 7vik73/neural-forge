import { accessScope, currentWorkspace } from './scope.js';
import { Inject, Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { randomBytes } from 'node:crypto';
import { Database } from './database.js';
import { decrypt, digest, encrypt } from './security.js';
import { AppExecutors } from './apps-executor.js';
import { aiAdapters } from './ai-providers.js';
import { externalDatabase } from './external-database.js';
import { config } from './config.js';
import {
  activeApps,
  configuredApps,
  disabledApps,
  assertAppEnabled,
  googleAppScopes,
} from './connection-policy.js';
import { OperationError, type ConnectionKind, type JsonObject } from '@forge/contracts';

export async function providerFetch(url: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
  } catch {
    throw new OperationError(
      'The provider connection ended before the result could be confirmed.',
      true,
      init.method !== undefined && init.method !== 'GET',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new OperationError(
      `The provider returned HTTP ${response.status}. Check your account permissions.`,
      response.status === 429 || response.status >= 500,
      false,
      Number(response.headers.get('retry-after') || 0) * 1000,
    );
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return {};
  try {
    const text = await response.text();
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new OperationError(
      'The provider response ended before the result could be confirmed.',
      true,
      !!init.method && !['GET', 'HEAD', 'OPTIONS'].includes(init.method),
    );
  }
}
@Injectable()
export class Connections {
  readonly apps = new AppExecutors(this);
  constructor(@Inject(Database) private readonly db: Database) {}
  async list() {
    const records = await this.db.connection.findMany({ orderBy: { createdAt: 'asc' } });
    return records.map(({ id, name, kind, status, secret }) => ({
      id,
      name,
      kind,
      status,
      ...(['google', 'microsoft'].includes(kind)
        ? {
            apps: activeApps(kind, decrypt(secret)),
            disabledApps: disabledApps(kind, decrypt(secret)),
          }
        : {}),
    }));
  }

  async save(name: string, kind: ConnectionKind, secret: Record<string, string>, id?: string) {
    if (!name.trim()) throw new Error('Give this connection a name.');
    if (kind === 'google' || kind === 'microsoft') {
      if (!secret.clientId || !secret.clientSecret) {
        const shared = await this.db.appCredential.findUnique({ where: { provider: kind } });
        if (!shared)
          throw new Error(
            'Ask the installation administrator to configure this app’s OAuth credentials in Installation settings.',
          );
        secret = { ...secret, oauthSource: 'installation' };
      }
    }
    const required: Record<ConnectionKind, string[]> = {
      google: ['clientId', 'clientSecret'],
      telegram: ['token'],
      smtp: ['host', 'port', 'user', 'password', 'from'],
      imap: ['host', 'port', 'user', 'password'],
      http: ['token'],
      gemini: ['apiKey'],
      openai: ['apiKey'],
      microsoft: ['clientId', 'clientSecret'],
      slack: ['token'],
      discord: ['webhook'],
      notion: ['token'],
      mysql: ['host', 'port', 'user', 'password', 'database'],
      postgres: ['host', 'port', 'user', 'password', 'database'],
    };
    for (const field of required[kind])
      if (
        !secret[field] &&
        !(secret.oauthSource === 'installation' && ['clientId', 'clientSecret'].includes(field))
      )
        throw new Error(`Set ${field} to connect this account.`);
    if (id) {
      const old = await this.get(id);
      if (old.kind !== kind) throw new Error('Connection types cannot be changed.');
    }
    if (kind === 'mysql' || kind === 'postgres')
      await (await import('./external-database.js')).checkDatabaseDestination(secret);
    if (kind === 'discord') {
      const u = new URL(secret.webhook!);
      if (
        u.protocol !== 'https:' ||
        !['discord.com', 'discordapp.com'].includes(u.hostname) ||
        !/^\/api\/webhooks\/\d+\/[\w-]+$/.test(u.pathname)
      )
        throw new Error('Paste a valid Discord channel webhook URL.');
    }
    const connectionId = id ?? randomBytes(16).toString('hex');
    const data = {
      where: { id: connectionId },
      create: { name, kind, secret: encrypt(secret) },
      update: { name, secret: encrypt(secret), status: 'untested' },
      select: { id: true, name: true, kind: true, status: true } as const,
    };
    if (kind !== 'telegram') return this.db.connection.upsert(data);
    return this.db.$transaction(async (tx) => {
      // Serialize token ownership, and coordinate edits with inbox dispatch.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('telegram-connections'))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`telegram-${connectionId}`}))`;
      const records = await this.db.system.connection.findMany({ where: { kind: 'telegram' } });
      for (const record of records)
        if (record.id !== connectionId && decrypt(record.secret).token === secret.token)
          throw new Error(
            record.workspaceId === currentWorkspace()
              ? `This bot is already saved as ${record.name}. Use that connection.`
              : 'This bot is already connected on this installation. Use a different bot.',
          );
      const old = records.find((record) => record.id === connectionId);
      if (old && decrypt(old.secret).token !== secret.token)
        await tx.sourceCheckpoint.deleteMany({ where: { id: `telegram-${connectionId}` } });
      return tx.connection.upsert(data);
    });
  }
  async get(id: string, expected?: string) {
    const record = await this.db.connection.findUniqueOrThrow({ where: { id } });
    if (expected && record.kind !== expected)
      throw new Error('Choose the correct account type for this step.');
    const stored = decrypt(record.secret);
    let credentials = stored;
    if (stored.oauthSource === 'installation') {
      const app = await this.db.appCredential.findUnique({ where: { provider: record.kind } });
      if (!app)
        throw new Error(
          'This installation’s OAuth application must be configured before reconnecting.',
        );
      credentials = { ...decrypt(app.secret), ...stored };
    }
    return { ...record, credentials };
  }
  async assertApp(id: string, app: string) {
    const record = await this.get(id);
    assertAppEnabled(record.kind, record.credentials, app);
  }
  storedCredentials(credentials: Record<string, string>) {
    if (credentials.oauthSource !== 'installation') return credentials;
    const { clientId, clientSecret, ...stored } = credentials;
    return stored;
  }
  oauth(credentials: Record<string, string>) {
    return new google.auth.OAuth2(
      credentials.clientId,
      credentials.clientSecret,
      `${config.appUrl}/api/v1/connections/google/callback`,
    );
  }
  async authorize(id: string) {
    const connection = await this.get(id);
    if (connection.kind === 'microsoft') return this.microsoftAuthorize(id);
    if (connection.kind !== 'google') throw new Error('This app does not use OAuth.');
    const client = this.oauth(connection.credentials);
    const state = encrypt({ id, nonce: randomBytes(24).toString('hex') });
    await this.db.accountToken.create({
      data: {
        id: digest(state),
        purpose: 'google_oauth',
        userId: accessScope.getStore()!.userId,
        workspaceId: currentWorkspace(),
        connectionId: id,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    return {
      url: client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        state,
        include_granted_scopes: true,
        scope: (connection.credentials.apps ?? 'gmail,sheets').split(',').flatMap(
          (app) =>
            ({
              gmail: ['https://www.googleapis.com/auth/gmail.modify'],
              sheets: ['https://www.googleapis.com/auth/spreadsheets'],
              drive: ['https://www.googleapis.com/auth/drive'],
              calendar: [
                'https://www.googleapis.com/auth/calendar.events',
                'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
              ],
            })[app.trim()] ?? [],
        ),
      }),
    };
  }
  async callback(code: string, state: string) {
    const pending = await this.db.accountToken.findFirst({
      where: {
        id: digest(state),
        purpose: 'google_oauth',
        userId: accessScope.getStore()!.userId,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!pending?.workspaceId || !pending.connectionId)
      throw new Error('Google authorization expired. Start the connection again.');
    const claimed = await this.db.accountToken.updateMany({
      where: { id: pending.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (!claimed.count) throw new Error('Google authorization was already used.');
    return this.db.withWorkspace(
      pending.workspaceId,
      async () => {
        const id = pending.connectionId!;
        const record = await this.get(id, 'google');
        const { tokens } = await this.oauth(record.credentials).getToken(code);
        const changed = await this.db.connection.updateMany({
          where: { id, secret: record.secret },
          data: {
            secret: encrypt({
              ...this.storedCredentials(record.credentials),
              tokens: JSON.stringify(tokens),
            }),
            status: 'connected',
          },
        });
        if (!changed.count)
          throw new Error('The connection changed during authorization. Start again.');
        return { workspaceId: pending.workspaceId };
      },
      { userId: pending.userId! },
    );
  }
  async google(id: string, app?: string) {
    const record = await this.get(id, 'google');
    if (app) assertAppEnabled('google', record.credentials, app);
    if (!record.credentials.tokens) throw new Error('Connect this Google account before running.');
    const client = this.oauth(record.credentials);
    client.setCredentials(JSON.parse(record.credentials.tokens));
    try {
      await client.getAccessToken();
    } catch {
      await this.db.connection.updateMany({
        where: { id, secret: record.secret },
        data: { status: 'reconnect' },
      });
      throw new Error('Your Google access expired. Reconnect the account in Connections.');
    }
    if (JSON.stringify(client.credentials) !== record.credentials.tokens) {
      const changed = await this.db.connection.updateMany({
        where: { id, secret: record.secret },
        data: {
          secret: encrypt({
            ...this.storedCredentials(record.credentials),
            tokens: JSON.stringify(client.credentials),
          }),
          status: 'connected',
        },
      });
      if (!changed.count)
        throw new OperationError('The connection changed. Retry this step.', true);
    }
    return client;
  }
  microsoftTenant(c: Record<string, string>) {
    const tenant =
      c.tenant || (configuredApps('microsoft', c).includes('excel') ? 'organizations' : 'common');
    if (!/^(organizations|common|consumers|[a-fA-F0-9-]{36})$/.test(tenant))
      throw new Error('Choose a valid Microsoft tenant.');
    return tenant;
  }
  async microsoftAuthorize(id: string) {
    const record = await this.get(id, 'microsoft'),
      state = randomBytes(32).toString('hex');
    await this.db.accountToken.create({
      data: {
        id: digest(state),
        purpose: 'microsoft_oauth',
        userId: accessScope.getStore()!.userId,
        workspaceId: currentWorkspace(),
        connectionId: id,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    const scope = this.microsoftScopes(record.credentials);
    const url = new URL(
      `https://login.microsoftonline.com/${this.microsoftTenant(record.credentials)}/oauth2/v2.0/authorize`,
    );
    url.search = new URLSearchParams({
      client_id: record.credentials.clientId!,
      response_type: 'code',
      redirect_uri: `${config.appUrl}/api/v1/connections/microsoft/callback`,
      response_mode: 'query',
      scope,
      state,
    }).toString();
    return { url: url.toString() };
  }
  microsoftScopes(c: Record<string, string>) {
    return [
      'offline_access',
      'User.Read',
      ...((c.apps ?? 'outlook').includes('outlook') ? ['Mail.ReadWrite', 'Mail.Send'] : []),
      ...((c.apps ?? '').includes('excel') ? ['Files.ReadWrite'] : []),
    ].join(' ');
  }
  async microsoftToken(c: Record<string, string>, values: Record<string, string>) {
    return providerFetch(
      `https://login.microsoftonline.com/${this.microsoftTenant(c)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: c.clientId!,
          client_secret: c.clientSecret!,
          redirect_uri: `${config.appUrl}/api/v1/connections/microsoft/callback`,
          ...values,
        }).toString(),
      },
    );
  }
  async microsoftCallback(code: string, state: string) {
    const pending = await this.db.accountToken.findFirst({
      where: {
        id: digest(state),
        purpose: 'microsoft_oauth',
        userId: accessScope.getStore()!.userId,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!pending?.workspaceId || !pending.connectionId)
      throw new Error('Microsoft authorization expired. Connect again.');
    const claim = await this.db.accountToken.updateMany({
      where: { id: pending.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (!claim.count) throw new Error('Authorization was already used.');
    return this.db.withWorkspace(
      pending.workspaceId,
      async () => {
        const record = await this.get(pending.connectionId!, 'microsoft');
        const tokens = await this.microsoftToken(record.credentials, {
          grant_type: 'authorization_code',
          code,
          scope: this.microsoftScopes(record.credentials),
        });
        tokens.expires_at = Date.now() + Number(tokens.expires_in) * 1000;
        const changed = await this.db.connection.updateMany({
          where: { id: record.id, secret: record.secret },
          data: {
            secret: encrypt({
              ...this.storedCredentials(record.credentials),
              tokens: JSON.stringify(tokens),
            }),
            status: 'connected',
          },
        });
        if (!changed.count)
          throw new Error('The connection changed during authorization. Start again.');
        return { workspaceId: pending.workspaceId };
      },
      { userId: pending.userId! },
    );
  }
  async microsoft(
    id: string,
    path: string,
    body?: object,
    method?: string,
    signal?: AbortSignal,
  ): Promise<any> {
    const record = await this.get(id, 'microsoft');
    if (path.startsWith('me/drive')) assertAppEnabled('microsoft', record.credentials, 'excel');
    else if (
      path.startsWith('me/messages') ||
      path.startsWith('me/mailFolders') ||
      path === 'me/sendMail'
    )
      assertAppEnabled('microsoft', record.credentials, 'outlook');
    if (!record.credentials.tokens)
      throw new Error('Connect this Microsoft account before running.');
    let tokens = JSON.parse(record.credentials.tokens);
    if (Number(tokens.expires_at) < Date.now() + 60_000) {
      try {
        const refreshed = await this.microsoftToken(record.credentials, {
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          scope: this.microsoftScopes(record.credentials),
        });
        tokens = {
          ...tokens,
          ...refreshed,
          expires_at: Date.now() + Number(refreshed.expires_in) * 1000,
        };
        const changed = await this.db.connection.updateMany({
          where: { id, secret: record.secret },
          data: {
            secret: encrypt({
              ...this.storedCredentials(record.credentials),
              tokens: JSON.stringify(tokens),
            }),
          },
        });
        if (!changed.count)
          throw new OperationError('The connection changed. Retry this step.', true);
      } catch {
        await this.db.connection.updateMany({
          where: { id, secret: record.secret },
          data: { status: 'reconnect' },
        });
        throw new Error('Microsoft access expired. Reconnect the account.');
      }
    }
    if (path.startsWith('/') || path.includes('://'))
      throw new Error('Choose a supported Microsoft resource.');
    return providerFetch(`https://graph.microsoft.com/v1.0/${path}`, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json',
        Prefer: 'outlook.body-content-type="text"',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
    });
  }
  smtp(credentials: Record<string, string>) {
    return nodemailer.createTransport({
      host: credentials.host,
      port: Number(credentials.port),
      secure: credentials.secure !== 'false' && Number(credentials.port) === 465,
      requireTLS: Number(credentials.port) !== 465,
      auth: { user: credentials.user, pass: credentials.password },
      connectionTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }
  imap(credentials: Record<string, string>) {
    return new ImapFlow({
      host: credentials.host!,
      port: Number(credentials.port),
      secure: credentials.secure !== 'false',
      auth: { user: credentials.user!, pass: credentials.password! },
      logger: false,
      connectionTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }
  async telegram(id: string, method: string, body: JsonObject = {}, signal?: AbortSignal) {
    return (await this.telegramSnapshot(id, method, body, signal)).result;
  }
  async telegramSnapshot(id: string, method: string, body: JsonObject = {}, signal?: AbortSignal) {
    const { credentials, secret: identity } = await this.get(id, 'telegram');
    const result = await providerFetch(
      `https://api.telegram.org/bot${credentials.token}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!result.ok)
      throw new OperationError(
        'Telegram rejected the request. Check the destination and bot permissions.',
      );
    return { identity, result: result.result };
  }
  async test(id: string) {
    const record = await this.get(id);
    try {
      switch (record.kind) {
        case 'telegram':
          await this.telegram(id, 'getMe');
          break;
        case 'google':
          {
            const auth = await this.google(id),
              apps = activeApps('google', record.credentials);
            const access = (await auth.getAccessToken()).token;
            if (!access) throw new Error('Reconnect this Google account.');
            const info = await auth.getTokenInfo(access);
            for (const app of apps)
              if (googleAppScopes[app]!.some((scope) => !info.scopes.includes(scope)))
                throw new Error(
                  'Reconnect this Google account and grant access to the selected apps.',
                );
          }
          break;
        case 'smtp': {
          const client = this.smtp(record.credentials);
          try {
            await client.verify();
          } finally {
            client.close();
          }
          break;
        }
        case 'imap': {
          const client = this.imap(record.credentials);
          try {
            await client.connect();
          } finally {
            await client.logout().catch(() => {});
          }
          break;
        }
        case 'gemini':
        case 'openai': {
          const models = await aiAdapters[record.kind]!.models(record.credentials);
          const model =
            record.credentials.model ||
            (record.kind === 'gemini' ? 'gemini-3.5-flash-lite' : 'gpt-4.1-mini');
          if (!models.some((m) => m.name === model))
            throw new Error('The selected AI model is unavailable to this key.');
          break;
        }
        case 'microsoft':
          await this.microsoft(id, 'me?$select=id');
          break;
        case 'slack':
          await this.apps.slack(id, 'auth.test');
          break;
        case 'notion':
          await this.apps.notion(id, 'users/me');
          break;
        case 'discord':
          await providerFetch(record.credentials.webhook!);
          break;
        case 'mysql':
        case 'postgres':
          await externalDatabase(record.kind, record.credentials, 'test');
          break;
        case 'http':
          break;
      }
      if (record.kind === 'telegram') {
        await this.db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('telegram-connections'))`;
          const records = await this.db.system.connection.findMany({
            where: { kind: 'telegram', status: 'connected', id: { not: id } },
          });
          if (records.some((other) => decrypt(other.secret).token === record.credentials.token))
            throw new Error(
              'This bot is already active on this installation. Use a different bot.',
            );
          await tx.connection.update({ where: { id }, data: { status: 'connected' } });
        });
      } else
        await this.db.connection.update({
          where: { id },
          data: { status: record.kind === 'http' ? 'configured' : 'connected' },
        });
      return {
        ok: true,
        message:
          record.kind === 'http'
            ? 'Token saved. Test it using your HTTP step’s destination.'
            : 'Connection is ready.',
      };
    } catch {
      await this.db.connection.update({ where: { id }, data: { status: 'reconnect' } });
      throw new Error(
        'Connection failed. Check the credentials, permissions, and provider settings.',
      );
    }
  }
  async resources(id: string, kind: string, value?: string) {
    if (kind === 'chats') {
      const messages = await this.telegram(id, 'getUpdates', { limit: 100, timeout: 0 });
      const chats = new Map<string, { id: string; name: string }>();
      for (const update of messages) {
        const chat = update.message?.chat;
        if (chat)
          chats.set(String(chat.id), {
            id: String(chat.id),
            name: chat.title ?? chat.first_name ?? String(chat.id),
          });
      }
      return [...chats.values()];
    }
    const connection = await this.get(id);
    if (connection.kind !== 'google') return this.apps.resources(id, kind, value);
    const app = (
      {
        'drive-files': 'drive',
        calendars: 'calendar',
        labels: 'gmail',
        tabs: 'sheets',
        columns: 'sheets',
      } as Record<string, string>
    )[kind];
    if (!app) return [];
    const auth = await this.google(id, app);
    if (kind === 'drive-files')
      return (
        (
          await google.drive({ version: 'v3', auth }).files.list({
            q: "trashed=false and (mimeType='text/plain' or mimeType='text/markdown' or mimeType='application/json' or mimeType='text/csv')",
            pageSize: 100,
            fields: 'files(id,name)',
          })
        ).data.files ?? []
      );
    if (kind === 'calendars')
      return (
        (
          await google.calendar({ version: 'v3', auth }).calendarList.list({ maxResults: 250 })
        ).data.items?.map((c) => ({ id: c.id, name: c.summary ?? c.id })) ?? []
      );
    if (kind === 'labels')
      return (
        (await google.gmail({ version: 'v1', auth }).users.labels.list({ userId: 'me' })).data
          .labels ?? []
      );
    if (kind === 'tabs' && value) {
      const result = await google
        .sheets({ version: 'v4', auth })
        .spreadsheets.get({ spreadsheetId: sheetId(value), fields: 'sheets.properties' });
      return (
        result.data.sheets?.map((s) => ({
          id: s.properties?.sheetId,
          name: s.properties?.title,
        })) ?? []
      );
    }
    if (kind === 'columns' && value) {
      const [spreadsheet, range = 'Sheet1!1:1'] = value.split('|');
      const result = await google
        .sheets({ version: 'v4', auth })
        .spreadsheets.values.get({ spreadsheetId: sheetId(spreadsheet!), range });
      return result.data.values?.[0] ?? [];
    }
    return [];
  }
}
export function sheetId(value: string) {
  return value.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1] ?? value;
}
