import { catalog } from './catalog.js';
export const apps = [
  ['gmail', 'Gmail', 'google', 'google'],
  ['sheets', 'Google Sheets', 'google', 'google'],
  ['drive', 'Google Drive', 'google', 'drive'],
  ['calendar', 'Google Calendar', 'google', 'calendar'],
  ['telegram', 'Telegram', 'telegram', 'telegram'],
  ['slack', 'Slack', 'slack', 'slack'],
  ['discord', 'Discord', 'discord', 'discord'],
  ['notion', 'Notion', 'notion', 'notion'],
  ['outlook', 'Microsoft Outlook', 'microsoft', 'outlook'],
  ['excel', 'Microsoft Excel 365', 'microsoft', 'excel'],
  ['mysql', 'MySQL', 'mysql', 'database'],
  ['postgres', 'PostgreSQL', 'postgres', 'database'],
  ['gemini', 'Google Gemini', 'gemini', 'ai'],
  ['ollama', 'Ollama', 'ollama', 'ai'],
  ['openai', 'OpenAI', 'openai', 'ai'],
  ['smtp', 'Send email (SMTP)', 'smtp', 'email'],
  ['imap', 'Receive email (IMAP)', 'imap', 'email'],
  ['http', 'HTTP API', 'http', 'http'],
].map(([id, name, connectionKind, category]) => ({
  id: id!,
  name: name!,
  connectionKind: connectionKind!,
  category: category!,
  actions: catalog
    .filter(
      (n) =>
        n.type.startsWith(`${id}.`) ||
        (id === 'smtp' && n.type === 'email.send') ||
        (['gemini', 'ollama', 'openai'].includes(id!) && n.type.startsWith('ai.')) ||
        (id === 'imap' && n.type === 'trigger.imap'),
    )
    .map((n) => ({ type: n.type, label: n.label, effect: n.effect })),
  authorization:
    connectionKind === 'google' || connectionKind === 'microsoft'
      ? 'oauth'
      : connectionKind === 'ollama'
        ? 'local'
        : 'credentials',
  verification: 'Contract tested; live account verification required',
}));
