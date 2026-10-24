import { Inject, Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import { parse as csvParse } from 'csv-parse/sync';
import { stringify as csvStringify } from 'csv-stringify/sync';
import { LocalFiles, safeHttp, catalog } from '@forge/connectors';
import { readPath } from '@forge/workflow';
import {
  Limits,
  OperationError,
  type Json,
  type JsonObject,
  type WorkflowNode,
  type AISettings,
} from '@forge/contracts';
import { Database, json } from './database.js';
import { Connections, sheetId } from './connections.js';
import { LocalAI } from './ai.js';
import { config } from './config.js';
import { WorkspaceFiles } from './storage.js';
import { currentWorkspace } from './scope.js';
import { nodeApp } from './connection-policy.js';

export type OperationContext = {
  workspaceId: string;
  key: string;
  runId: string;
  preview: boolean;
  signal: AbortSignal;
  timezone: string;
  ai?: AISettings;
  predecessors: JsonObject[];
};
const asText = (value: Json | undefined) =>
  typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
export function gmailMessage(message: any): JsonObject {
  const header = (name: string) =>
    message.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())
      ?.value ?? '';
  const decode = (part: any): string =>
    part?.mimeType === 'text/plain' && part.body?.data
      ? Buffer.from(part.body.data, 'base64url').toString('utf8')
      : (part?.parts ?? []).map(decode).filter(Boolean).join('\n');
  return {
    id: message.id ?? '',
    subject: header('Subject'),
    from: header('From'),
    text: decode(message.payload) || message.snippet || '',
  };
}
export function resolveAIChoice(
  root: AISettings | undefined,
  options: JsonObject,
): AISettings | undefined {
  if (!root && !options.provider && !options.model && !options.connectionId) return undefined;
  const provider = String(options.provider || root?.provider || 'ollama') as AISettings['provider'];
  const same = provider === (root?.provider ?? 'ollama');
  return {
    provider,
    dataPolicy: root?.dataPolicy ?? 'private',
    model: options.model ? String(options.model) : same ? root?.model : undefined,
    connectionId: options.connectionId
      ? String(options.connectionId)
      : same
        ? root?.connectionId
        : undefined,
  };
}
@Injectable()
export class Operations {
  readonly files: WorkspaceFiles;
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Connections) private readonly connections: Connections,
    @Inject(LocalAI) private readonly ai: LocalAI,
  ) {
    this.files = new WorkspaceFiles(db);
  }
  async validateAI(choice: AISettings | undefined, options: JsonObject = {}) {
    return this.ai.validateChoice(resolveAIChoice(choice, options));
  }
  async execute(
    node: WorkflowNode,
    input: JsonObject,
    context: OperationContext,
  ): Promise<JsonObject> {
    if (context.workspaceId !== currentWorkspace())
      throw new Error('Execution workspace does not match.');
    const { config: options, type } = node;
    const definition = catalog.find((n) => n.type === type)!;
    if (['google', 'microsoft'].includes(definition.connectionKind ?? '') && options.connectionId)
      await this.connections.assertApp(String(options.connectionId), nodeApp(node));
    if (type.startsWith('trigger.')) return input;
    if (
      context.preview &&
      definition.effect === 'write' &&
      !(type === 'http.request' && options.method === 'GET')
    )
      return this.simulate(node, input);
    if (type.startsWith('ai.'))
      return this.ai.process(
        type.slice(3),
        asText(input.text),
        options,
        context.signal,
        resolveAIChoice(context.ai, options),
      );
    if (/^(drive|calendar|slack|discord|notion|outlook|excel|mysql|postgres)\./.test(type))
      return this.connections.apps.execute(node, input, context.signal);
    switch (type) {
      case 'logic.condition': {
        const value = input.value;
        const compare = input.compare;
        const operator = options.operator;
        const passed =
          operator === 'exists'
            ? value !== null && value !== '' && value !== undefined
            : operator === 'contains'
              ? asText(value).includes(asText(compare))
              : operator === 'greater'
                ? Number(value) > Number(compare)
                : asText(value) === asText(compare);
        return { _branch: passed ? 'true' : 'false', value: value ?? null };
      }
      case 'logic.split':
        return { data: Object.keys(input).length ? input : (context.predecessors[0] ?? {}) };
      case 'logic.join':
        return { items: context.predecessors };
      case 'data.map':
        return { data: input.data ?? input };
      case 'data.filter': {
        if (!Array.isArray(input.items)) throw new Error('Choose a list of items to filter.');
        return {
          items: input.items.filter(
            (item) => asText(readPath(item, String(options.field))) === asText(input.value),
          ),
        };
      }
      case 'data.json.parse':
        return { data: JSON.parse(asText(input.text)) };
      case 'data.json.create':
        return { text: JSON.stringify(input.data ?? null, null, 2) };
      case 'data.csv.parse': {
        const items = csvParse(asText(input.text), {
          columns: true,
          skip_empty_lines: true,
          max_record_size: 1_048_576,
        }) as JsonObject[];
        if (items.length > Limits.items)
          throw new Error('CSV has more than 1,000 rows. Split it into smaller files.');
        return { items };
      }
      case 'data.csv.create': {
        if (!Array.isArray(input.items)) throw new Error('Choose a list of rows.');
        return {
          text: csvStringify(
            input.items.map((i) => (typeof i === 'object' && i !== null ? i : { value: i })),
            { header: true },
          ),
        };
      }
      case 'data.text': {
        const text = asText(input.text);
        return {
          text:
            options.operation === 'upper'
              ? text.toUpperCase()
              : options.operation === 'lower'
                ? text.toLowerCase()
                : text.trim(),
        };
      }
      case 'data.date': {
        const date = new Date(asText(input.value));
        if (Number.isNaN(date.valueOf())) throw new Error('Choose a valid date.');
        return {
          text: new Intl.DateTimeFormat('en-GB', {
            timeZone: context.timezone,
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(date),
        };
      }
      case 'notes.create': {
        const note = await this.db.note.upsert({
          where: { effectKey: context.key },
          create: {
            title: asText(input.title),
            text: asText(input.text),
            effectKey: context.key,
            lastRunId: context.runId,
          },
          update: {},
        });
        return { id: note.id, title: note.title, text: note.text };
      }
      case 'notes.read': {
        const note = await this.db.note.findUniqueOrThrow({ where: { id: asText(input.id) } });
        return { id: note.id, title: note.title, text: note.text };
      }
      case 'notes.update':
        return this.db.$transaction(async (tx) => {
          const previous = await tx.artifact.findUnique({ where: { id: context.key } });
          if (previous) return previous.metadata as JsonObject;
          const note = await tx.note.update({
            where: { id: asText(input.id) },
            data: {
              text: asText(input.text),
              lastRunId: context.runId,
              ...(input.title ? { title: asText(input.title) } : {}),
            },
          });
          const output = { id: note.id, title: note.title, text: note.text };
          await tx.artifact.create({
            data: {
              id: context.key,
              runId: context.runId,
              nodeId: node.id,
              kind: 'note-effect',
              metadata: json(output),
            },
          });
          return output;
        });
      case 'notes.search': {
        const query = asText(input.query);
        const notes = await this.db.note.findMany({
          where: {
            ...(query
              ? {
                  OR: [
                    { title: { contains: query, mode: 'insensitive' } },
                    { text: { contains: query, mode: 'insensitive' } },
                  ],
                }
              : {}),
          },
          take: 1000,
          orderBy: { updatedAt: 'asc' },
        });
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: context.timezone });
        const items = notes
          .filter(
            (n) =>
              options.period !== 'today' || today.format(n.updatedAt) === today.format(new Date()),
          )
          .map((n) => ({ id: n.id, title: n.title, text: n.text }));
        return { items, text: items.map((n) => `${n.title}\n${n.text}`).join('\n\n') };
      }
      case 'files.list':
        return { items: await this.files.list(asText(input.path)) };
      case 'files.read':
        return this.files.read(asText(input.path));
      case 'files.create':
        return this.files.write(asText(input.path), asText(input.text), true);
      case 'files.update':
        return this.files.write(asText(input.path), asText(input.text), false);
      case 'http.request': {
        const headers: Record<string, string> = {};
        if (options.connectionId) {
          const connection = await this.connections.get(String(options.connectionId), 'http');
          headers.Authorization = `Bearer ${connection.credentials.token}`;
        }
        const result = await safeHttp(asText(input.url), {
          method: String(options.method ?? 'GET'),
          body: input.body,
          headers,
          allowPrivate: options.allowPrivate === true,
          signal: context.signal,
        });
        return result as JsonObject;
      }
      case 'telegram.send': {
        const result = await this.connections.telegram(
          String(options.connectionId),
          'sendMessage',
          { chat_id: String(options.chatId), text: asText(input.text).slice(0, 4096) },
          context.signal,
        );
        return { id: String(result.message_id), text: result.text };
      }
      case 'email.send': {
        const connection = await this.connections.get(String(options.connectionId), 'smtp');
        const client = this.connections.smtp(connection.credentials);
        try {
          const result = await client.sendMail({
            from: connection.credentials.from,
            to: String(options.to),
            subject: asText(input.subject).replace(/[\r\n]/g, ''),
            text: asText(input.text),
            messageId: `<${context.key}@neural-forge.local>`,
          });
          return { id: result.messageId };
        } catch (error) {
          const code = (error as any).code;
          throw new OperationError(
            'The email could not be confirmed. Check your sent messages before retrying.',
            false,
            ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET'].includes(code),
          );
        } finally {
          client.close();
        }
      }
    }
    if (type.startsWith('gmail.')) return this.gmail(node, input, context.signal);
    if (type.startsWith('sheets.')) return this.sheets(node, input, context.signal);
    throw new Error('This operation is unavailable.');
  }
  simulate(node: WorkflowNode, input: JsonObject): JsonObject {
    const meta: JsonObject = { simulated: true, notice: 'Preview only — no changes were made.' };
    if (node.type.startsWith('notes.'))
      return {
        ...meta,
        id: 'preview-note',
        title: input.title ?? 'Example note',
        text: input.text ?? '',
      };
    if (node.type.startsWith('files.')) return { ...meta, path: input.path ?? 'example.txt' };
    if (node.type.startsWith('sheets.')) return { ...meta, updated: 1, items: input.rows ?? [] };
    if (node.type === 'http.request') return { ...meta, status: 200, data: {}, text: '{}' };
    return { ...meta, id: 'preview-message', text: input.text ?? '' };
  }
  private async gmail(
    node: WorkflowNode,
    input: JsonObject,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    const gmail = google.gmail({
      version: 'v1',
      auth: await this.connections.google(String(node.config.connectionId), 'gmail'),
    });
    const opts = { retry: false, timeout: 30_000, signal };
    switch (node.type) {
      case 'gmail.search': {
        const list = await gmail.users.messages.list(
          { userId: 'me', q: asText(input.query), maxResults: 50 },
          opts,
        );
        const items = await Promise.all(
          (list.data.messages ?? []).map(async (m) =>
            gmailMessage(
              (await gmail.users.messages.get({ userId: 'me', id: m.id!, format: 'full' }, opts))
                .data,
            ),
          ),
        );
        return { items };
      }
      case 'gmail.read':
        return gmailMessage(
          (
            await gmail.users.messages.get(
              { userId: 'me', id: asText(input.id), format: 'full' },
              opts,
            )
          ).data,
        );
      case 'gmail.label': {
        const existing = (await gmail.users.labels.list({ userId: 'me' }, opts)).data.labels ?? [];
        const ids: string[] = [];
        for (const name of asText(input.labels)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)) {
          const match = existing.find((l) => l.name === name || l.id === name);
          ids.push(
            match?.id ??
              (
                await gmail.users.labels.create(
                  {
                    userId: 'me',
                    requestBody: {
                      name,
                      labelListVisibility: 'labelShow',
                      messageListVisibility: 'show',
                    },
                  },
                  opts,
                )
              ).data.id!,
          );
        }
        await gmail.users.messages.modify(
          { userId: 'me', id: asText(input.id), requestBody: { addLabelIds: ids } },
          opts,
        );
        return { id: asText(input.id) };
      }
      default: {
        const to = String(node.config.to).replace(/[\r\n]/g, '');
        const subject = Buffer.from(asText(input.subject)).toString('base64');
        const body = Buffer.from(asText(input.text)).toString('base64');
        const raw = Buffer.from(
          `To: ${to}\r\nSubject: =?UTF-8?B?${subject}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}`,
        ).toString('base64url');
        const result =
          node.type === 'gmail.draft'
            ? await gmail.users.drafts.create(
                { userId: 'me', requestBody: { message: { raw } } },
                opts,
              )
            : await gmail.users.messages.send({ userId: 'me', requestBody: { raw } }, opts);
        return { id: result.data.id ?? '' };
      }
    }
  }
  private async sheets(
    node: WorkflowNode,
    input: JsonObject,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    const sheets = google.sheets({
      version: 'v4',
      auth: await this.connections.google(String(node.config.connectionId), 'sheets'),
    });
    const spreadsheetId = sheetId(String(node.config.spreadsheetId));
    const range = String(node.config.range);
    const opts = { retry: false, timeout: 30_000, signal };
    if (node.type === 'sheets.read')
      return {
        items:
          (await sheets.spreadsheets.values.get({ spreadsheetId, range }, opts)).data.values ?? [],
      };
    const rows = input.rows;
    const columns = String(node.config.columns ?? '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);
    const rowValues = (row: Json): Json[] =>
      Array.isArray(row)
        ? row
        : row && typeof row === 'object'
          ? columns.length
            ? columns.map((key) => (Object.hasOwn(row, key) ? (row[key] ?? '') : ''))
            : Object.values(row)
          : [row ?? ''];
    const values = Array.isArray(rows) ? rows.map(rowValues) : [rowValues(rows ?? '')];
    if (values.length > Limits.items)
      throw new Error('Choose no more than 1,000 spreadsheet rows.');
    const request = { spreadsheetId, range, valueInputOption: 'RAW', requestBody: { values } };
    const result =
      node.type === 'sheets.append'
        ? await sheets.spreadsheets.values.append(
            { ...request, insertDataOption: 'INSERT_ROWS' },
            opts,
          )
        : await sheets.spreadsheets.values.update(request, opts);
    return {
      updated: (result.data as any).updatedCells ?? (result.data as any).updates?.updatedCells ?? 0,
    };
  }
}
