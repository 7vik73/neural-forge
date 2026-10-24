import { google } from 'googleapis';
import type { Connections } from './connections.js';
import { providerFetch } from './connections.js';
import { externalDatabase } from './external-database.js';
import { OperationError, type JsonObject, type WorkflowNode } from '@forge/contracts';
const enc = encodeURIComponent;
const object = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Choose a JSON object.');
  return value;
};
const rich = (text: string) => [{ type: 'text', text: { content: text.slice(0, 2000) } }];
const blocks = (text: string) =>
  text
    .match(/[\s\S]{1,2000}/g)
    ?.slice(0, 100)
    .map((t) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rich(t) } })) ?? [];
export class AppExecutors {
  constructor(private readonly connections: Connections) {}
  async slack(id: string, method: string, body: object = {}, signal?: AbortSignal) {
    const { credentials } = await this.connections.get(id, 'slack');
    const result = await providerFetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!result.ok)
      throw new OperationError(
        'Slack rejected the request. Check bot scopes and channel membership.',
        result.error === 'ratelimited',
        false,
        result.error === 'ratelimited' ? 60_000 : undefined,
      );
    return result;
  }
  async notion(id: string, path: string, body?: object, method?: string, signal?: AbortSignal) {
    const { credentials } = await this.connections.get(id, 'notion');
    return providerFetch(`https://api.notion.com/v1/${path}`, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        'Notion-Version': '2025-09-03',
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
    });
  }
  async execute(node: WorkflowNode, input: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
    const [app, action] = node.type.split('.'),
      c = node.config,
      id = String(c.connectionId);
    if (app === 'drive') {
      const auth = await this.connections.google(id, 'drive'),
        drive = google.drive({ version: 'v3', auth });
      const options = { retry: false, timeout: 30000, signal };
      if (action === 'search')
        return {
          items:
            ((
              await drive.files.list(
                {
                  q: input.query ? String(input.query) : 'trashed=false',
                  pageSize: 100,
                  fields: 'files(id,name,mimeType)',
                },
                options,
              )
            ).data.files as any) ?? [],
        };
      if (action === 'read') {
        const metadata = (
          await drive.files.get(
            { fileId: String(c.fileId), fields: 'id,name,mimeType,size' },
            options,
          )
        ).data;
        const allowed = ['text/plain', 'text/markdown', 'text/csv', 'application/json'];
        if (!allowed.includes(metadata.mimeType ?? '') || Number(metadata.size ?? 0) > 20_971_520)
          throw new Error('Choose a supported UTF-8 text, Markdown, JSON or CSV file under 20 MB.');
        const result = await drive.files.get(
          { fileId: String(c.fileId), alt: 'media' },
          { ...options, responseType: 'text' },
        );
        return {
          id: metadata.id!,
          name: metadata.name!,
          text: typeof result.data === 'string' ? result.data : JSON.stringify(result.data),
        };
      }
      const media = { mimeType: 'text/plain', body: String(input.text ?? '') };
      const response =
        action === 'create'
          ? await drive.files.create(
              {
                requestBody: { name: String(input.name), mimeType: 'text/plain' },
                media,
                fields: 'id,name',
              },
              options,
            )
          : await drive.files.update(
              { fileId: String(c.fileId), media, fields: 'id,name' },
              options,
            );
      return { id: response.data.id!, name: response.data.name ?? '' };
    }
    if (app === 'calendar') {
      const calendar = google.calendar({
          version: 'v3',
          auth: await this.connections.google(id, 'calendar'),
        }),
        calendarId = String(c.calendarId),
        opts = { retry: false, timeout: 30000, signal };
      if (action === 'list')
        return {
          items:
            ((
              await calendar.events.list(
                {
                  calendarId,
                  maxResults: 250,
                  singleEvents: true,
                  timeMin: new Date().toISOString(),
                  orderBy: 'startTime',
                },
                opts,
              )
            ).data.items as any) ?? [],
        };
      const start = new Date(String(input.start)),
        end = new Date(String(input.end));
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start)
        throw new Error('Choose valid event start and end times.');
      const requestBody = {
        summary: String(input.title),
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
      };
      const result =
        action === 'create'
          ? await calendar.events.insert({ calendarId, requestBody }, opts)
          : await calendar.events.patch(
              { calendarId, eventId: String(input.eventId), requestBody },
              opts,
            );
      return { id: result.data.id!, link: result.data.htmlLink ?? '' };
    }
    if (app === 'slack') {
      const result = await this.slack(
        id,
        action === 'read' ? 'conversations.history' : 'chat.postMessage',
        {
          channel: String(c.channelId),
          ...(action === 'read' ? { limit: 100 } : { text: String(input.text) }),
        },
        signal,
      );
      return action === 'read'
        ? { items: result.messages ?? [] }
        : { id: result.ts, text: result.message?.text ?? String(input.text) };
    }
    if (app === 'discord') {
      const { credentials } = await this.connections.get(id, 'discord');
      const url = new URL(credentials.webhook!);
      if (
        url.protocol !== 'https:' ||
        !['discord.com', 'discordapp.com'].includes(url.hostname) ||
        !/^\/api\/webhooks\/\d+\/[\w-]+$/.test(url.pathname)
      )
        throw new Error('Paste a valid Discord channel webhook URL.');
      url.search = '?wait=true';
      const result = await providerFetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: String(input.text).slice(0, 2000),
          allowed_mentions: { parse: [] },
        }),
        signal,
      });
      return { id: result.id, text: result.content ?? '' };
    }
    if (app === 'notion') {
      const pageId = String(c.pageId ?? input.pageId ?? '');
      if (action === 'search')
        return {
          items:
            (
              await this.notion(
                id,
                'search',
                { query: String(input.query ?? ''), page_size: 100 },
                undefined,
                signal,
              )
            ).results ?? [],
        };
      if (action === 'read') {
        const data = await this.notion(id, `pages/${enc(pageId)}`, undefined, undefined, signal),
          content = await this.notion(
            id,
            `blocks/${enc(pageId)}/children?page_size=100`,
            undefined,
            undefined,
            signal,
          );
        return {
          id: pageId,
          data,
          text: (content.results ?? [])
            .map((b: any) =>
              (b[b.type]?.rich_text ?? [])
                .map((t: any) => t.plain_text ?? t.text?.content ?? '')
                .join(''),
            )
            .join('\n'),
        };
      }
      if (action === 'records')
        return {
          items:
            (
              await this.notion(
                id,
                `data_sources/${enc(String(c.dataSourceId))}/query`,
                { page_size: 100 },
                undefined,
                signal,
              )
            ).results ?? [],
        };
      if (node.type === 'notion.record.create')
        return {
          id: (
            await this.notion(
              id,
              'pages',
              {
                parent: { type: 'data_source_id', data_source_id: String(c.dataSourceId) },
                properties: object(input.properties),
              },
              undefined,
              signal,
            )
          ).id,
        };
      if (node.type === 'notion.record.update')
        return {
          id: (
            await this.notion(
              id,
              `pages/${enc(pageId)}`,
              { properties: object(input.properties) },
              'PATCH',
              signal,
            )
          ).id,
        };
      if (action === 'create')
        return {
          id: (
            await this.notion(
              id,
              'pages',
              {
                parent: { type: 'page_id', page_id: String(c.parentId) },
                properties: { title: { type: 'title', title: rich(String(input.title)) } },
                children: blocks(String(input.text)),
              },
              undefined,
              signal,
            )
          ).id,
        };
      await this.notion(
        id,
        `blocks/${enc(pageId)}/children`,
        { children: blocks(String(input.text)) },
        'PATCH',
        signal,
      );
      return { id: pageId };
    }
    if (app === 'outlook') {
      if (action === 'search')
        return {
          items:
            (
              await this.connections.microsoft(
                id,
                `me/messages?$top=100&$select=id,subject,from,bodyPreview&$search=${enc(`"${String(input.query ?? '').replace(/["\\]/g, '')}"`)}`,
                undefined,
                undefined,
                signal,
              )
            ).value ?? [],
        };
      if (action === 'read') {
        const m = await this.connections.microsoft(
          id,
          `me/messages/${enc(String(input.id))}`,
          undefined,
          undefined,
          signal,
        );
        return {
          id: m.id,
          subject: m.subject ?? '',
          text: m.body?.content ?? '',
          from: m.from?.emailAddress?.address ?? '',
        };
      }
      const message = {
        subject: String(input.subject),
        body: { contentType: 'Text', content: String(input.text) },
        toRecipients: [{ emailAddress: { address: String(c.to) } }],
      };
      const result = await this.connections.microsoft(
        id,
        action === 'draft' ? 'me/messages' : 'me/sendMail',
        action === 'draft' ? message : { message, saveToSentItems: true },
        'POST',
        signal,
      );
      return { id: result?.id ?? 'sent' };
    }
    if (app === 'excel') {
      const root = `me/drive/items/${enc(String(c.workbookId))}/workbook/tables/${enc(String(c.tableId))}`;
      if (action === 'read')
        return {
          items:
            (
              await this.connections.microsoft(
                id,
                `${root}/rows?$top=1000`,
                undefined,
                undefined,
                signal,
              )
            ).value ?? [],
        };
      if (
        !Array.isArray(input.rows) ||
        input.rows.length > 1000 ||
        input.rows.some((r) => !Array.isArray(r))
      )
        throw new Error('Choose a list of at most 1,000 row arrays.');
      if (action === 'append') {
        await this.connections.microsoft(
          id,
          `${root}/rows/add`,
          { values: input.rows },
          'POST',
          signal,
        );
        return { updated: input.rows.length };
      }
      const index = Number(input.rowIndex);
      if (!Number.isInteger(index) || index < 0 || input.rows.length !== 1)
        throw new Error('Choose a row index and exactly one row of values.');
      await this.connections.microsoft(
        id,
        `${root}/rows/itemAt(index=${index})/range`,
        { values: input.rows },
        'PATCH',
        signal,
      );
      return { updated: 1 };
    }
    if (app === 'mysql' || app === 'postgres')
      return externalDatabase(
        app,
        (await this.connections.get(id, app)).credentials,
        action!,
        String(c.table),
        input,
      );
    throw new Error('This app action is not supported.');
  }
  async resources(id: string, kind: string, value?: string) {
    const record = await this.connections.get(id);
    if (record.kind === 'slack' && kind === 'channels') {
      const result = await this.slack(id, 'conversations.list', {
        limit: 200,
        exclude_archived: true,
      });
      return (result.channels ?? []).map((c: any) => ({ id: c.id, name: c.name }));
    }
    if (record.kind === 'notion') {
      const body = await this.notion(id, 'search', {
        page_size: 100,
        filter: { value: kind === 'data-sources' ? 'data_source' : 'page', property: 'object' },
      });
      return (body.results ?? []).map((p: any) => ({
        id: p.id,
        name:
          (
            p.title ??
            (Object.values(p.properties ?? {}).find((v: any) => v.type === 'title') as any)
              ?.title ??
            []
          )
            .map((t: any) => t.plain_text ?? t.text?.content ?? '')
            .join('') || p.id,
      }));
    }
    if (record.kind === 'microsoft') {
      const result = await this.connections.microsoft(
        id,
        kind === 'tables'
          ? `me/drive/items/${enc(value ?? '')}/workbook/tables`
          : `me/drive/root/children?$select=id,name,file&$top=200`,
      );
      return (result.value ?? [])
        .filter((r: any) => kind === 'tables' || r.name?.endsWith('.xlsx'))
        .map((r: any) => ({ id: r.id, name: r.name }));
    }
    if (record.kind === 'mysql' || record.kind === 'postgres')
      return (await externalDatabase(record.kind, record.credentials, 'tables')).items;
    return [];
  }
}
