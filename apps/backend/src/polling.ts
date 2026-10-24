import { Inject, Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import { simpleParser } from 'mailparser';
import { WorkflowSchema, type JsonObject, type WorkflowNode } from '@forge/contracts';
import { Database, json } from './database.js';
import { Connections } from './connections.js';
import { Operations, gmailMessage } from './operations.js';
import { ExecutionEngine, lockRun } from './engine.js';
import { redact } from './security.js';

type Incoming = { key: string; input: JsonObject };
@Injectable()
export class Polling {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Connections) private readonly connections: Connections,
    @Inject(Operations) private readonly operations: Operations,
    @Inject(ExecutionEngine) private readonly engine: ExecutionEngine,
  ) {}
  async tick() {
    const workflows = await this.db.workflow.findMany({
      where: { enabled: true, publishedId: { not: null } },
      include: { checkpoints: true },
    });
    const telegram = new Map<
      string,
      { workflowId: string; versionId: string; initialized: boolean }[]
    >();
    for (const workflow of workflows) {
      const version = await this.db.workflowVersion.findUnique({
        where: { id: workflow.publishedId! },
      });
      if (!version) continue;
      const trigger = WorkflowSchema.parse(version.definition).nodes.find((n) =>
        n.type.startsWith('trigger.'),
      )!;
      if (trigger.type !== 'trigger.telegram') continue;
      const connectionId = String(trigger.config.connectionId);
      const group = telegram.get(connectionId) ?? [];
      group.push({
        workflowId: workflow.id,
        versionId: version.id,
        initialized:
          (workflow.checkpoints[0]?.value as JsonObject | undefined)?.initialized === true,
      });
      telegram.set(connectionId, group);
    }
    for (const [connectionId, group] of telegram) {
      try {
        await this.telegramInbox(connectionId, group);
      } catch (error) {
        for (const item of group) {
          const before = (
            await this.db.checkpoint.findUnique({ where: { workflowId: item.workflowId } })
          )?.value as JsonObject | undefined;
          await this.db.checkpoint.upsert({
            where: { workflowId: item.workflowId },
            create: {
              workflowId: item.workflowId,
              value: { error: redact((error as Error).message) },
            },
            update: { value: json({ ...before, error: redact((error as Error).message) }) },
          });
        }
      }
    }
    for (const workflow of workflows) {
      const version = await this.db.workflowVersion.findUnique({
        where: { id: workflow.publishedId! },
      });
      if (!version) continue;
      const trigger = WorkflowSchema.parse(version.definition).nodes.find((n) =>
        n.type.startsWith('trigger.'),
      )!;
      if (
        ![
          'trigger.note',
          'trigger.file',
          'trigger.gmail',
          'trigger.imap',
          'trigger.calendar',
          'trigger.slack',
          'trigger.outlook',
        ].includes(trigger.type)
      )
        continue;
      const checkpoint = workflow.checkpoints[0];
      const before = checkpoint?.value as JsonObject | undefined;
      try {
        const result = await this.read(trigger, before);
        await this.db.$transaction(
          async (tx) => {
            await lockRun(tx, workflow.id);
            const current = await tx.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
            if (!current.enabled || current.publishedId !== version.id) return;
            const latest = await tx.checkpoint.findUnique({ where: { workflowId: workflow.id } });
            if ((latest?.updatedAt.getTime() ?? null) !== (checkpoint?.updatedAt.getTime() ?? null))
              return;
            for (const incoming of result.events)
              await this.engine.createRun(
                workflow.id,
                incoming.input,
                false,
                true,
                `${workflow.id}-${version.id}-${incoming.key}`,
                tx,
              );
            await tx.checkpoint.upsert({
              where: { workflowId: workflow.id },
              create: { workflowId: workflow.id, value: json(result.checkpoint) },
              update: { value: json(result.checkpoint) },
            });
          },
          { timeout: 20_000 },
        );
      } catch (error) {
        const message = redact((error as Error).message);
        await this.db.checkpoint
          .upsert({
            where: { workflowId: workflow.id },
            create: { workflowId: workflow.id, value: { error: message } },
            update: { value: json({ ...before, error: message }) },
          })
          .catch(() => {});
      }
    }
  }
  private async telegramInbox(
    connectionId: string,
    subscribers: { workflowId: string; versionId: string; initialized: boolean }[],
  ) {
    const id = `telegram-${connectionId}`;
    const previous = await this.db.sourceCheckpoint.findUnique({ where: { id } });
    const baseline = !previous || !subscribers.some((s) => s.initialized);
    const before = previous?.value as JsonObject | undefined;
    const { identity, result: updates } = await this.connections.telegramSnapshot(
      connectionId,
      'getUpdates',
      {
        timeout: 0,
        limit: 100,
        offset: baseline ? -1 : Number(before?.offset ?? 0),
      },
    );
    let offset = Number(before?.offset ?? 0);
    for (const update of updates) offset = Math.max(offset, update.update_id + 1);
    await this.db.$transaction(
      async (tx) => {
        await lockRun(tx, id);
        const connection = await tx.connection.findUnique({ where: { id: connectionId } });
        if (connection?.secret !== identity) return;
        const latest = await tx.sourceCheckpoint.findUnique({ where: { id } });
        if ((latest?.revision ?? -1) !== (previous?.revision ?? -1)) return;
        for (const subscriber of subscribers) {
          await lockRun(tx, subscriber.workflowId);
          const workflow = await tx.workflow.findUniqueOrThrow({
            where: { id: subscriber.workflowId },
          });
          if (!workflow.enabled || workflow.publishedId !== subscriber.versionId) continue;
          if (!baseline && subscriber.initialized)
            for (const update of updates)
              if (update.message?.text)
                await this.engine.createRun(
                  workflow.id,
                  { text: update.message.text, chatId: String(update.message.chat.id) },
                  false,
                  true,
                  `${workflow.id}-${subscriber.versionId}-${update.update_id}`,
                  tx,
                );
          await tx.checkpoint.upsert({
            where: { workflowId: workflow.id },
            create: { workflowId: workflow.id, value: { initialized: true } },
            update: { value: { initialized: true } },
          });
        }
        await tx.sourceCheckpoint.upsert({
          where: { id },
          create: { id, value: { offset } },
          update: { value: { offset }, revision: { increment: 1 } },
        });
      },
      { timeout: 30_000 },
    );
  }
  private async read(
    node: WorkflowNode,
    previous?: JsonObject,
  ): Promise<{ events: Incoming[]; checkpoint: JsonObject }> {
    const initialized = previous?.initialized === true;
    const events: Incoming[] = [];
    const now = new Date().toISOString();
    switch (node.type) {
      case 'trigger.note': {
        const since = String(previous?.since ?? now);
        const notes = initialized
          ? await this.db.note.findMany({
              where: {
                updatedAt: { gte: new Date(since), lt: new Date(now) },
                ...(node.config.includeAutomated === true ? {} : { lastRunId: null }),
              },
              orderBy: { updatedAt: 'asc' },
              take: 1000,
            })
          : [];
        for (const note of notes)
          events.push({
            key: `${note.id}-${note.updatedAt.toISOString()}`,
            input: { id: note.id, title: note.title, text: note.text },
          });
        return {
          events,
          checkpoint: {
            initialized: true,
            since: notes.length === 1000 ? notes.at(-1)!.updatedAt.toISOString() : now,
          },
        };
      }
      case 'trigger.file': {
        const files = await this.operations.files.list(String(node.config.folder ?? ''));
        const seen = new Set((previous?.seen ?? []) as string[]);
        if (initialized)
          for (const file of files)
            if (!seen.has(file.path))
              events.push({ key: file.path, input: await this.operations.files.read(file.path) });
        return { events, checkpoint: { initialized: true, seen: files.map((f) => f.path) } };
      }
      case 'trigger.telegram': {
        const updates = await this.connections.telegram(
          String(node.config.connectionId),
          'getUpdates',
          {
            timeout: 0,
            limit: 100,
            ...(initialized ? { offset: Number(previous?.offset ?? 0) } : { offset: -1 }),
          },
        );
        let offset = Number(previous?.offset ?? 0);
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          if (initialized && update.message?.text)
            events.push({
              key: String(update.update_id),
              input: { text: update.message.text, chatId: String(update.message.chat.id) },
            });
        }
        return { events, checkpoint: { initialized: true, offset } };
      }
      case 'trigger.slack': {
        const channel = String(node.config.channelId),
          last = String(previous?.last ?? '0');
        let cursor: string | undefined,
          latest = last,
          count = 0;
        do {
          const result = await this.connections.apps.slack(
            String(node.config.connectionId),
            'conversations.history',
            {
              channel,
              limit: initialized ? 100 : 1,
              ...(initialized ? { oldest: last, inclusive: false } : {}),
              ...(cursor ? { cursor } : {}),
            },
          );
          for (const m of result.messages ?? []) {
            if (String(m.ts) > latest) latest = String(m.ts);
            if (initialized && m.type === 'message' && !m.subtype)
              events.push({
                key: `${channel}-${m.ts}`,
                input: { id: m.ts, text: m.text ?? '', channelId: channel },
              });
            count++;
          }
          cursor = initialized ? result.response_metadata?.next_cursor : undefined;
          if (count > 1000)
            throw new Error(
              'More than 1,000 Slack messages are pending. Narrow the channel selection.',
            );
        } while (cursor);
        events.sort((a, b) => a.key.localeCompare(b.key));
        return { events, checkpoint: { initialized: true, last: latest } };
      }
      case 'trigger.calendar': {
        const calendar = google.calendar({
          version: 'v3',
          auth: await this.connections.google(String(node.config.connectionId), 'calendar'),
        });
        let pageToken: string | undefined,
          syncToken = String(previous?.syncToken ?? ''),
          count = 0;
        const baseline = String(previous?.baseline ?? new Date().toISOString());
        do {
          const response = await calendar.events.list(
            {
              calendarId: String(node.config.calendarId),
              maxResults: 250,
              ...(initialized && syncToken ? { syncToken } : {}),
              ...(pageToken ? { pageToken } : {}),
            },
            { retry: false, timeout: 30000 },
          );
          for (const e of response.data.items ?? []) {
            count++;
            if (
              initialized &&
              e.id &&
              e.status !== 'cancelled' &&
              String(e.created ?? '') > baseline
            )
              events.push({
                key: e.id,
                input: {
                  id: e.id,
                  title: e.summary ?? '',
                  start: e.start?.dateTime ?? e.start?.date ?? '',
                  end: e.end?.dateTime ?? e.end?.date ?? '',
                },
              });
          }
          pageToken = response.data.nextPageToken ?? undefined;
          if (response.data.nextSyncToken) syncToken = response.data.nextSyncToken;
          if (count > 1000)
            throw new Error(
              'More than 1,000 calendar changes are pending. Choose a smaller calendar.',
            );
        } while (pageToken);
        return { events, checkpoint: { initialized: true, syncToken, baseline } };
      }
      case 'trigger.outlook': {
        let path = String(
            previous?.delta ??
              'me/mailFolders/Inbox/messages/delta?$select=id,subject,from,body,receivedDateTime',
          ),
          delta = path,
          count = 0;
        const baseline = String(previous?.baseline ?? new Date().toISOString());
        const graphPath = (url: string) => {
          const parsed = new URL(url);
          if (
            parsed.origin !== 'https://graph.microsoft.com' ||
            !parsed.pathname.startsWith('/v1.0/')
          )
            throw new Error('Microsoft returned an unsupported pagination URL.');
          return parsed.pathname.slice('/v1.0/'.length) + parsed.search;
        };
        while (path) {
          const result = await this.connections.microsoft(String(node.config.connectionId), path);
          for (const m of result.value ?? []) {
            count++;
            if (initialized && !m['@removed'] && m.receivedDateTime > baseline)
              events.push({
                key: m.id,
                input: {
                  id: m.id,
                  subject: m.subject ?? '',
                  text: m.body?.content ?? '',
                  from: m.from?.emailAddress?.address ?? '',
                },
              });
          }
          path = result['@odata.nextLink'] ? graphPath(result['@odata.nextLink']) : '';
          if (result['@odata.deltaLink']) delta = graphPath(result['@odata.deltaLink']);
          if (count > 1000)
            throw new Error(
              'More than 1,000 Outlook messages are pending. Choose a smaller mailbox.',
            );
        }
        return { events, checkpoint: { initialized: true, delta, baseline } };
      }
      case 'trigger.gmail': {
        const gmail = google.gmail({
          version: 'v1',
          auth: await this.connections.google(String(node.config.connectionId), 'gmail'),
        });
        const opts = { retry: false, timeout: 30_000 };
        if (!initialized) {
          const profile = await gmail.users.getProfile({ userId: 'me' }, opts);
          return { events, checkpoint: { initialized: true, historyId: profile.data.historyId! } };
        }
        let pageToken: string | undefined;
        let historyId = String(previous?.historyId);
        const ids = new Set<string>();
        do {
          const result = await gmail.users.history.list(
            {
              userId: 'me',
              startHistoryId: String(previous?.historyId),
              historyTypes: ['messageAdded'],
              maxResults: 100,
              pageToken,
            },
            opts,
          );
          for (const history of result.data.history ?? [])
            for (const item of history.messagesAdded ?? [])
              if (item.message?.id) ids.add(item.message.id);
          pageToken = result.data.nextPageToken ?? undefined;
          historyId = result.data.historyId ?? historyId;
          if (ids.size > 1000)
            throw new Error(
              'More than 1,000 new messages are pending. Narrow the Gmail search before continuing.',
            );
        } while (pageToken);
        let matching: Set<string> | undefined;
        if (node.config.query) {
          matching = new Set();
          let queryToken: string | undefined;
          do {
            const matches = await gmail.users.messages.list(
              {
                userId: 'me',
                q: String(node.config.query),
                maxResults: 500,
                pageToken: queryToken,
              },
              opts,
            );
            for (const m of matches.data.messages ?? []) if (m.id) matching.add(m.id);
            queryToken = matches.data.nextPageToken ?? undefined;
            if (matching.size > 10_000)
              throw new Error('Narrow this Gmail search so it matches fewer than 10,000 messages.');
          } while (queryToken);
        }
        for (const id of ids)
          if (!matching || matching.has(id))
            events.push({
              key: id,
              input: gmailMessage(
                (await gmail.users.messages.get({ userId: 'me', id, format: 'full' }, opts)).data,
              ),
            });
        return { events, checkpoint: { initialized: true, historyId } };
      }
      case 'trigger.imap': {
        const record = await this.connections.get(String(node.config.connectionId), 'imap');
        const client = this.connections.imap(record.credentials);
        try {
          await client.connect();
          const lock = await client.getMailboxLock(String(node.config.mailbox ?? 'INBOX'));
          try {
            const mailbox = client.mailbox;
            if (!mailbox) throw new Error('Choose an available mailbox.');
            const validity = mailbox.uidValidity.toString();
            const baseline = !initialized || previous?.validity !== validity;
            let last = baseline ? mailbox.uidNext - 1 : Number(previous?.uid ?? 0);
            if (!baseline && last < mailbox.uidNext - 1)
              for await (const message of client.fetch(
                `${last + 1}:*`,
                { uid: true, source: true },
                { uid: true },
              )) {
                if (message.uid <= last || !message.source) continue;
                const mail = await simpleParser(message.source);
                events.push({
                  key: `${validity}-${message.uid}`,
                  input: {
                    id: String(message.uid),
                    text: mail.text ?? '',
                    subject: mail.subject ?? '',
                    from: mail.from?.text ?? '',
                  },
                });
                last = message.uid;
                if (events.length === 1000) break;
              }
            return { events, checkpoint: { initialized: true, validity, uid: last } };
          } finally {
            lock.release();
          }
        } finally {
          await client.logout().catch(() => {});
        }
      }
      default:
        return { events, checkpoint: { initialized: true } };
    }
  }
}
