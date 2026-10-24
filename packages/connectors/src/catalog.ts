import {
  constant,
  ref,
  type Field,
  type Json,
  type NodeDefinition,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowTemplate,
} from '@forge/contracts';

const text = (
  key: string,
  label: string,
  required = true,
  target: Field['target'] = 'config',
): Field => ({ key, label, required, target, kind: 'text' });
const input = (
  key: string,
  label: string,
  kind: Field['kind'] = 'textarea',
  required = true,
): Field => ({ key, label, target: 'inputs', kind, required });
const connection: Field = {
  key: 'connectionId',
  label: 'Connected account',
  target: 'config',
  kind: 'connection',
  required: true,
};
const select = (key: string, label: string, options: string[], value = options[0]!): Field => ({
  key,
  label,
  target: 'config',
  kind: 'select',
  options,
  default: value,
  required: true,
});
const define = (
  type: string,
  label: string,
  category: NodeDefinition['category'],
  fields: Field[],
  outputs: string[],
  options: Partial<NodeDefinition> = {},
): NodeDefinition => ({
  type,
  version: 1,
  label,
  description: label,
  category,
  fields,
  outputs,
  effect: 'read',
  retrySafe: true,
  ...options,
});
const loopBody: WorkflowDefinition = {
  schemaVersion: 1,
  settings: { timezone: 'UTC', maxItems: 1000 },
  nodes: [
    {
      id: 'item',
      type: 'trigger.manual',
      version: 1,
      label: 'For this item',
      config: {},
      inputs: {},
    },
    {
      id: 'classify',
      type: 'ai.classify',
      version: 1,
      label: 'Classify this item',
      config: { labels: 'important, other' },
      inputs: { text: ref('$input', 'item') },
    },
  ],
  edges: [
    {
      id: 'item-classify',
      source: 'item',
      sourcePort: 'out',
      target: 'classify',
      targetPort: 'in',
    },
  ],
};

export const catalog: NodeDefinition[] = [
  define('trigger.manual', 'Start when I click Run', 'trigger', [], ['text', 'items']),
  define(
    'trigger.schedule',
    'Start on a schedule',
    'trigger',
    [
      text('cron', 'Schedule (cron)'),
      { ...text('timezone', 'Timezone'), default: 'UTC', advanced: true },
    ],
    ['scheduledAt'],
  ),
  define('trigger.webhook', 'Receive a webhook', 'trigger', [], ['body']),
  define(
    'trigger.note',
    'When a note changes',
    'trigger',
    [
      {
        key: 'includeAutomated',
        label: 'Include workflow-generated note changes',
        target: 'config',
        kind: 'boolean',
        default: false,
        advanced: true,
        help: 'Leave this off to prevent note workflows from triggering themselves.',
      },
    ],
    ['id', 'title', 'text'],
  ),
  define(
    'trigger.file',
    'When a file appears',
    'trigger',
    [text('folder', 'Folder inside your workspace', false)],
    ['path', 'text'],
  ),
  define(
    'trigger.gmail',
    'When Gmail arrives',
    'trigger',
    [connection, { ...text('query', 'Gmail search', false), default: 'in:inbox' }],
    ['id', 'subject', 'text', 'from'],
    { connectionKind: 'google' },
  ),
  define(
    'trigger.imap',
    'When an email arrives',
    'trigger',
    [connection, { ...text('mailbox', 'Mailbox'), default: 'INBOX' }],
    ['id', 'subject', 'text', 'from'],
    { connectionKind: 'imap' },
  ),
  define(
    'trigger.telegram',
    'When a Telegram message arrives',
    'trigger',
    [connection],
    ['text', 'chatId'],
    { connectionKind: 'telegram' },
  ),
  define(
    'logic.condition',
    'Check a condition',
    'logic',
    [
      input('value', 'Value to check', 'text'),
      select('operator', 'Comparison', ['equals', 'contains', 'greater', 'exists']),
      input('compare', 'Compare with', 'text', false),
    ],
    ['_branch', 'value'],
    { effect: 'control' },
  ),
  define('logic.split', 'Run branches in parallel', 'logic', [], ['data'], { effect: 'control' }),
  define('logic.join', 'Wait for branches', 'logic', [], ['items'], { effect: 'control' }),
  define(
    'logic.delay',
    'Wait before continuing',
    'logic',
    [
      {
        key: 'seconds',
        label: 'Seconds to wait',
        kind: 'number',
        target: 'config',
        required: true,
        default: 60,
      },
    ],
    ['resumedAt'],
    { effect: 'control' },
  ),
  define(
    'logic.approval',
    'Ask for approval',
    'logic',
    [
      { ...text('message', 'Approval request'), default: 'Review the result before continuing.' },
      input('details', 'Details to review', 'textarea', false),
    ],
    ['approved'],
    { effect: 'control' },
  ),
  define(
    'logic.foreach',
    'For each item',
    'logic',
    [
      input('items', 'List to process', 'json'),
      {
        key: 'body',
        label: 'Steps for each item',
        target: 'config',
        kind: 'json',
        required: true,
        default: loopBody as unknown as Json,
      },
    ],
    ['items'],
    { effect: 'control' },
  ),
  define(
    'data.filter',
    'Filter a list',
    'data',
    [
      input('items', 'List', 'json'),
      text('field', 'Field to compare'),
      input('value', 'Keep matching value', 'text'),
    ],
    ['items'],
  ),
  define(
    'data.map',
    'Choose and rename fields',
    'data',
    [input('data', 'Fields', 'json')],
    ['data'],
  ),
  define('data.json.parse', 'Read JSON text', 'data', [input('text', 'JSON text')], ['data']),
  define('data.json.create', 'Create JSON text', 'data', [input('data', 'Data', 'json')], ['text']),
  define('data.csv.parse', 'Read CSV rows', 'data', [input('text', 'CSV text')], ['items']),
  define('data.csv.create', 'Create CSV text', 'data', [input('items', 'Rows', 'json')], ['text']),
  define(
    'data.text',
    'Format text',
    'data',
    [input('text', 'Text'), select('operation', 'Formatting', ['trim', 'upper', 'lower'])],
    ['text'],
  ),
  define('data.date', 'Format a date', 'data', [input('value', 'Date', 'text')], ['text']),
  define(
    'notes.create',
    'Create a note',
    'notes',
    [input('title', 'Note title', 'text'), input('text', 'Note content')],
    ['id', 'title', 'text'],
    { effect: 'write' },
  ),
  define(
    'notes.search',
    'Find notes',
    'notes',
    [
      input('query', 'Search text', 'text', false),
      select('period', 'Time period', ['all', 'today']),
    ],
    ['items', 'text'],
  ),
  define(
    'notes.read',
    'Read a note',
    'notes',
    [{ ...input('id', 'Note', 'note') }],
    ['id', 'title', 'text'],
  ),
  define(
    'notes.update',
    'Update a note',
    'notes',
    [
      input('id', 'Note', 'note'),
      input('title', 'Title', 'text', false),
      input('text', 'New content'),
    ],
    ['id', 'title', 'text'],
    { effect: 'write' },
  ),
  define('files.list', 'Find files', 'files', [input('path', 'Folder', 'text', false)], ['items']),
  define(
    'files.read',
    'Read a text file',
    'files',
    [input('path', 'File path', 'text')],
    ['path', 'text'],
  ),
  define(
    'files.create',
    'Create a text file',
    'files',
    [input('path', 'File path', 'text'), input('text', 'Content')],
    ['path'],
    { effect: 'write' },
  ),
  define(
    'files.update',
    'Update a text file',
    'files',
    [input('path', 'File path', 'text'), input('text', 'New content')],
    ['path'],
    { effect: 'write' },
  ),
  define(
    'http.request',
    'Call an HTTP API',
    'http',
    [
      input('url', 'URL', 'text'),
      select('method', 'Method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      { ...connection, required: false },
      input('body', 'Request data', 'json', false),
      {
        key: 'allowPrivate',
        label: 'Allow private-network destination',
        target: 'config',
        kind: 'boolean',
        default: false,
        advanced: true,
      },
    ],
    ['status', 'data', 'text'],
    { retrySafe: false, effect: 'write', connectionKind: 'http' },
  ),
  define(
    'telegram.send',
    'Send a Telegram message',
    'telegram',
    [connection, text('chatId', 'Destination chat'), input('text', 'Message')],
    ['id', 'text'],
    { effect: 'write', retrySafe: false, connectionKind: 'telegram' },
  ),
  define(
    'gmail.search',
    'Find Gmail messages',
    'gmail',
    [connection, input('query', 'Search', 'text')],
    ['items'],
    { connectionKind: 'google' },
  ),
  define(
    'gmail.read',
    'Read a Gmail message',
    'gmail',
    [connection, input('id', 'Message ID', 'text')],
    ['id', 'text', 'subject', 'from'],
    { connectionKind: 'google' },
  ),
  define(
    'gmail.label',
    'Apply Gmail labels',
    'gmail',
    [
      connection,
      input('id', 'Message ID', 'text'),
      input('labels', 'Label names (comma separated)', 'text'),
    ],
    ['id'],
    { effect: 'write', connectionKind: 'google' },
  ),
  ...['draft', 'send'].map((action) =>
    define(
      `gmail.${action}`,
      action === 'draft' ? 'Create a Gmail draft' : 'Send through Gmail',
      'gmail',
      [
        connection,
        text('to', 'Recipient'),
        input('subject', 'Subject', 'text'),
        input('text', 'Message'),
      ],
      ['id'],
      { effect: 'write', retrySafe: false, connectionKind: 'google' },
    ),
  ),
  ...['read', 'append', 'update'].map((action) =>
    define(
      `sheets.${action}`,
      `${action === 'read' ? 'Read' : action === 'append' ? 'Add' : 'Update'} spreadsheet rows`,
      'sheets',
      [
        connection,
        { ...text('spreadsheetId', 'Spreadsheet ID or URL'), kind: 'sheet' },
        text('range', 'Tab and range'),
        ...(action === 'read'
          ? []
          : [
              text('columns', 'Object field order (comma separated)', false),
              input('rows', 'Rows', 'json'),
            ]),
      ],
      ['items', 'updated'],
      {
        effect: action === 'read' ? 'read' : 'write',
        retrySafe: action !== 'append',
        connectionKind: 'google',
      },
    ),
  ),
  define(
    'email.send',
    'Send an email',
    'email',
    [
      connection,
      text('to', 'Recipient'),
      input('subject', 'Subject', 'text'),
      input('text', 'Message'),
    ],
    ['id'],
    { effect: 'write', retrySafe: false, connectionKind: 'smtp' },
  ),
  ...['generate', 'summarize', 'rewrite', 'classify', 'extract'].map((action) =>
    define(
      `ai.${action}`,
      {
        generate: 'Write with AI',
        summarize: 'Summarize with AI',
        rewrite: 'Rewrite with AI',
        classify: 'Classify with AI',
        extract: 'Extract fields with AI',
      }[action]!,
      'ai',
      [
        input('text', 'Text to process'),
        { ...text('instruction', 'Instructions', false), kind: 'textarea' },
        {
          ...select('provider', 'AI provider override', ['', 'gemini', 'ollama', 'openai'], ''),
          required: false,
          advanced: true,
        },
        { ...text('model', 'Model override', false), advanced: true },
        { ...connection, required: false, advanced: true },
        ...(action === 'classify' ? [text('labels', 'Allowed labels (comma separated)')] : []),
        ...(action === 'extract'
          ? [
              {
                ...text('fields', 'Fields to extract (comma separated)'),
                default: 'name, email, message',
              },
            ]
          : []),
      ],
      ['text', 'data', 'label'],
    ),
  ),
];

const resource = (
  key: string,
  label: string,
  resourceKind: string,
  resourceParent?: string,
): Field => ({ ...text(key, label), kind: 'resource', resourceKind, resourceParent });
const add = (
  type: string,
  label: string,
  category: NodeDefinition['category'],
  fields: Field[],
  outputs: string[],
  kind: NodeDefinition['connectionKind'],
  write = false,
) =>
  catalog.push(
    define(type, label, category, [connection, ...fields], outputs, {
      connectionKind: kind,
      effect: write ? 'write' : 'read',
      retrySafe: !write,
    }),
  );
add(
  'drive.search',
  'Find Google Drive files',
  'drive',
  [input('query', 'Search expression', 'text', false)],
  ['items'],
  'google',
);
add(
  'drive.read',
  'Read a Drive text file',
  'drive',
  [resource('fileId', 'Text file', 'drive-files')],
  ['id', 'name', 'text'],
  'google',
);
add(
  'drive.create',
  'Create a Drive text file',
  'drive',
  [input('name', 'File name', 'text'), input('text', 'Content')],
  ['id', 'name'],
  'google',
  true,
);
add(
  'drive.update',
  'Update a Drive text file',
  'drive',
  [resource('fileId', 'Text file', 'drive-files'), input('text', 'Content')],
  ['id'],
  'google',
  true,
);
add(
  'calendar.list',
  'List calendar events',
  'calendar',
  [resource('calendarId', 'Calendar', 'calendars')],
  ['items'],
  'google',
);
for (const action of ['create', 'update'])
  add(
    `calendar.${action}`,
    `${action === 'create' ? 'Create' : 'Update'} a calendar event`,
    'calendar',
    [
      resource('calendarId', 'Calendar', 'calendars'),
      ...(action === 'update' ? [input('eventId', 'Event ID', 'text')] : []),
      input('title', 'Event title', 'text'),
      input('start', 'Start (ISO date/time)', 'text'),
      input('end', 'End (ISO date/time)', 'text'),
    ],
    ['id', 'link'],
    'google',
    true,
  );
add(
  'trigger.calendar',
  'When a calendar event is added',
  'trigger',
  [resource('calendarId', 'Calendar', 'calendars')],
  ['id', 'title', 'start', 'end'],
  'google',
);
add(
  'slack.read',
  'Read Slack messages',
  'slack',
  [resource('channelId', 'Channel', 'channels')],
  ['items'],
  'slack',
);
add(
  'slack.send',
  'Send a Slack message',
  'slack',
  [resource('channelId', 'Channel', 'channels'), input('text', 'Message')],
  ['id', 'text'],
  'slack',
  true,
);
add(
  'trigger.slack',
  'When a Slack message arrives',
  'trigger',
  [resource('channelId', 'Channel', 'channels')],
  ['id', 'text', 'channelId'],
  'slack',
);
add(
  'discord.send',
  'Send a Discord message',
  'discord',
  [input('text', 'Message')],
  ['id', 'text'],
  'discord',
  true,
);
add(
  'notion.search',
  'Find Notion pages',
  'notion',
  [input('query', 'Search', 'text', false)],
  ['items'],
  'notion',
);
add(
  'notion.read',
  'Read a Notion page',
  'notion',
  [resource('pageId', 'Page', 'pages')],
  ['id', 'data', 'text'],
  'notion',
);
add(
  'notion.create',
  'Create a Notion page',
  'notion',
  [
    resource('parentId', 'Parent page', 'pages'),
    input('title', 'Title', 'text'),
    input('text', 'Content'),
  ],
  ['id'],
  'notion',
  true,
);
add(
  'notion.update',
  'Update Notion page content',
  'notion',
  [resource('pageId', 'Page', 'pages'), input('text', 'Content to append')],
  ['id'],
  'notion',
  true,
);
add(
  'notion.records',
  'Read Notion records',
  'notion',
  [resource('dataSourceId', 'Data source', 'data-sources')],
  ['items'],
  'notion',
);
add(
  'notion.record.create',
  'Add a Notion record',
  'notion',
  [
    resource('dataSourceId', 'Data source', 'data-sources'),
    input('properties', 'Record properties', 'json'),
  ],
  ['id'],
  'notion',
  true,
);
add(
  'notion.record.update',
  'Update a Notion record',
  'notion',
  [input('pageId', 'Record page ID', 'text'), input('properties', 'Record properties', 'json')],
  ['id'],
  'notion',
  true,
);
add(
  'outlook.search',
  'Find Outlook messages',
  'outlook',
  [input('query', 'Search text', 'text', false)],
  ['items'],
  'microsoft',
);
add(
  'outlook.read',
  'Read an Outlook message',
  'outlook',
  [input('id', 'Message ID', 'text')],
  ['id', 'subject', 'text', 'from'],
  'microsoft',
);
for (const action of ['draft', 'send'])
  add(
    `outlook.${action}`,
    action === 'draft' ? 'Create an Outlook draft' : 'Send through Outlook',
    'outlook',
    [text('to', 'Recipient'), input('subject', 'Subject', 'text'), input('text', 'Message')],
    ['id'],
    'microsoft',
    true,
  );
add(
  'trigger.outlook',
  'When Outlook mail arrives',
  'trigger',
  [],
  ['id', 'subject', 'text', 'from'],
  'microsoft',
);
for (const action of ['read', 'append', 'update'])
  add(
    `excel.${action}`,
    `${action === 'read' ? 'Read' : action === 'append' ? 'Add' : 'Update'} Excel table rows`,
    'excel',
    [
      resource('workbookId', 'Workbook', 'workbooks'),
      resource('tableId', 'Table', 'tables', 'workbookId'),
      ...(action === 'update' ? [input('rowIndex', 'Row index', 'number')] : []),
      ...(action === 'read'
        ? []
        : [
            text('columns', 'Object field order (comma separated)', false),
            input('rows', 'Rows', 'json'),
          ]),
    ],
    ['items', 'updated'],
    'microsoft',
    action !== 'read',
  );
for (const kind of ['mysql', 'postgres'] as const)
  for (const action of ['read', 'insert', 'update'])
    add(
      `${kind}.${action}`,
      `${action === 'read' ? 'Read' : action === 'insert' ? 'Insert' : 'Update'} ${kind === 'mysql' ? 'MySQL' : 'PostgreSQL'} rows`,
      'database',
      [
        resource('table', 'Table', 'tables'),
        ...(action !== 'insert'
          ? [input('filter', 'Match columns and values', 'json', action === 'update')]
          : []),
        ...(action !== 'read' ? [input('values', 'Column values', 'json')] : []),
      ],
      ['items', 'updated'],
      kind,
      action !== 'read',
    );

export function createNode(type: string, id: string): WorkflowNode {
  const definition = catalog.find((d) => d.type === type);
  if (!definition) throw new Error('Unknown step type.');
  return {
    id,
    type,
    version: 1,
    label: definition.label,
    inputs: {},
    config: Object.fromEntries(
      definition.fields
        .filter((f) => f.target === 'config' && f.default !== undefined)
        .map((f) => [f.key, structuredClone(f.default!)]),
    ),
  };
}
function flow(nodes: WorkflowNode[]): WorkflowDefinition {
  return {
    schemaVersion: 1,
    settings: { timezone: 'UTC', maxItems: 1000 },
    nodes: nodes.map((n, i) => ({ ...n, position: { x: i * 300, y: 100 } })),
    edges: nodes.slice(1).map((n, i) => ({
      id: `e-${i}`,
      source: nodes[i]!.id,
      sourcePort: 'out',
      target: n.id,
      targetPort: 'in',
    })),
  };
}
const node = (
  type: string,
  id: string,
  config: WorkflowNode['config'] = {},
  inputs: WorkflowNode['inputs'] = {},
): WorkflowNode => ({
  ...createNode(type, id),
  config: { ...createNode(type, id).config, ...config },
  inputs,
});
export const templates: WorkflowTemplate[] = [
  {
    id: 'text-note',
    name: 'Turn a long text into a clear note',
    description: 'Paste text, summarize it privately, and keep the result in your notes.',
    category: 'Everyday',
    apps: ['Local AI', 'Notes'],
    sample: {
      text: 'We discussed the launch. Maya will prepare the design by Friday. Arun will test the signup flow. The next meeting is Monday.',
    },
    definition: flow([
      node('trigger.manual', 'start'),
      node('ai.summarize', 'summary', {}, { text: ref('$input', 'text') }),
      node(
        'notes.create',
        'save',
        {},
        { title: constant('My summary'), text: ref('summary', 'text') },
      ),
    ]),
  },
  {
    id: 'daily-notes',
    name: 'Send yourself a daily notes digest',
    description: 'Every evening, collect today’s notes and receive a short summary in Telegram.',
    category: 'Everyday',
    apps: ['Notes', 'Local AI', 'Telegram'],
    sample: {},
    definition: flow([
      node('trigger.schedule', 'start', { cron: '0 20 * * *' }),
      node('notes.search', 'notes', { period: 'today' }),
      node('ai.summarize', 'summary', {}, { text: ref('notes', 'text') }),
      node(
        'telegram.send',
        'send',
        { connectionId: '', chatId: '' },
        { text: ref('summary', 'text') },
      ),
    ]),
  },
  {
    id: 'rewrite-note',
    name: 'Give a note a fresh start',
    description: 'Rewrite an existing note clearly while keeping the original.',
    category: 'Writing',
    apps: ['Notes', 'Local AI'],
    sample: { noteId: '' },
    definition: flow([
      node('trigger.manual', 'start'),
      node('notes.read', 'note', {}, { id: constant('') }),
      node(
        'ai.rewrite',
        'rewrite',
        { instruction: 'Rewrite clearly and concisely.' },
        { text: ref('note', 'text') },
      ),
      node(
        'notes.create',
        'save',
        {},
        { title: constant('Rewritten note'), text: ref('rewrite', 'text') },
      ),
    ]),
  },
  {
    id: 'gmail-triage',
    name: 'Give incoming email the right label',
    description: 'Classify Gmail messages locally and label them automatically.',
    category: 'Email',
    apps: ['Gmail', 'Local AI'],
    sample: { id: 'sample', text: 'Can you send me the invoice?' },
    definition: flow([
      node('trigger.gmail', 'start', { connectionId: '' }),
      node(
        'ai.classify',
        'classify',
        { labels: 'Work, Personal, Other' },
        { text: ref('$input', 'text') },
      ),
      node(
        'gmail.label',
        'label',
        { connectionId: '' },
        { id: ref('$input', 'id'), labels: ref('classify', 'label') },
      ),
    ]),
  },
  {
    id: 'email-sheet',
    name: 'Turn emails into spreadsheet records',
    description: 'Extract names, email addresses, and messages into Google Sheets.',
    category: 'Productivity',
    apps: ['Gmail', 'Local AI', 'Google Sheets'],
    sample: { text: 'I am Priya. Email me at priya@example.com about the new project.' },
    definition: flow([
      node('trigger.gmail', 'start', { connectionId: '' }),
      node(
        'ai.extract',
        'extract',
        { fields: 'name, email, message' },
        { text: ref('$input', 'text') },
      ),
      node(
        'sheets.append',
        'save',
        { connectionId: '', spreadsheetId: '', range: 'Sheet1!A:C' },
        { rows: ref('extract', 'data') },
      ),
    ]),
  },
  {
    id: 'webhook-sheet',
    name: 'Collect form submissions in a sheet',
    description: 'Receive a webhook and add the submitted fields to Google Sheets.',
    category: 'Productivity',
    apps: ['Webhook', 'Google Sheets'],
    sample: { body: { name: 'Alex', email: 'alex@example.com', message: 'Hello!' } },
    definition: flow([
      node('trigger.webhook', 'start'),
      node(
        'sheets.append',
        'save',
        { connectionId: '', spreadsheetId: '', range: 'Sheet1!A:C' },
        { rows: ref('$input', 'body') },
      ),
    ]),
  },
  {
    id: 'file-email',
    name: 'Get a summary when a text file arrives',
    description: 'Watch your selected folder and email a summary of each new text file.',
    category: 'Files',
    apps: ['Files', 'Local AI', 'Email'],
    sample: {
      path: 'meeting.txt',
      text: 'The team approved the proposal. Next step: prepare a budget.',
    },
    definition: flow([
      node('trigger.file', 'start', { folder: '' }),
      node('ai.summarize', 'summary', {}, { text: ref('$input', 'text') }),
      node(
        'email.send',
        'send',
        { connectionId: '', to: '' },
        { subject: constant('A new file summary'), text: ref('summary', 'text') },
      ),
    ]),
  },
  {
    id: 'csv-classify',
    name: 'Sort a CSV with AI',
    description: 'Classify each row in a CSV and save the results to a new file.',
    category: 'Files',
    apps: ['Files', 'Local AI'],
    sample: { text: 'message\nPlease send the invoice\nLunch tomorrow?' },
    definition: flow([
      node('trigger.manual', 'start'),
      node('data.csv.parse', 'parse', {}, { text: ref('$input', 'text') }),
      node(
        'logic.foreach',
        'each',
        { body: loopBody as unknown as Json },
        { items: ref('parse', 'items') },
      ),
      node('data.csv.create', 'csv', {}, { items: ref('each', 'items') }),
      node(
        'files.create',
        'save',
        {},
        { path: constant('classified.csv'), text: ref('csv', 'text') },
      ),
    ]),
  },
];
