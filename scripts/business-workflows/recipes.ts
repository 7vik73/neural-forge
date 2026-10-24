import { createNode } from '@forge/connectors';
import {
  constant as c,
  type Binding,
  type Json,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@forge/contracts';

type Resources = {
  google: string;
  gemini: string;
  slack: string;
  discord: string;
  telegram: string;
  microsoft: string;
  selfEmail: string;
  slackChannel: string;
  telegramChat: string;
  spreadsheet: string;
  knowledgeFile: string;
  knowledgeNote: string;
  calendar: string;
  calendarTitle: string;
  calendarEvent: string;
  eventStart: string;
  eventEnd: string;
  model: string;
  messages: { lead: string; invoice: string; sla: string; support: string };
  demoLabel: string;
};
export type Recipe = {
  slug: string;
  name: string;
  description: string;
  source: string;
  definition: WorkflowDefinition;
  input: Record<string, Json>;
  cases?: { name: string; input: Record<string, Json> }[];
};
const r = (id: string, path: string, format: 'none' | 'json' = 'none'): Binding => ({
  kind: 'reference',
  nodeId: id,
  path,
  format,
});
const n = (
  type: string,
  id: string,
  config: Record<string, Json> = {},
  inputs: Record<string, Binding> = {},
  label?: string,
): WorkflowNode => {
  const node = createNode(type, id);
  return { ...node, label: label || node.label, config: { ...node.config, ...config }, inputs };
};
const link = (source: string, target: string, sourcePort: 'out' | 'true' | 'false' = 'out') => ({
  id: `${source}-${sourcePort}-${target}`,
  source,
  target,
  sourcePort,
  targetPort: 'in',
});

export function buildRecipes(a: Resources, tag: string): Recipe[] {
  const settings = {
    timezone: 'Asia/Kolkata',
    maxItems: 25,
    ai: {
      provider: 'gemini' as const,
      connectionId: a.gemini,
      model: a.model,
      dataPolicy: 'public-demo' as const,
    },
  };
  const graph = (
    nodes: WorkflowNode[],
    edges = nodes.slice(1).map((node, i) => link(nodes[i]!.id, node.id)),
  ): WorkflowDefinition => ({
    schemaVersion: 1,
    settings: structuredClone(settings),
    nodes,
    edges,
  });
  const manual = () => n('trigger.manual', 'start');
  const schedule = (cron = '0 9 * * 1-5') =>
    n('trigger.schedule', 'start', { cron, timezone: settings.timezone });
  const note = (id: string, title: string, text: Binding) =>
    n('notes.create', id, {}, { title: c(`NFDEMO ${tag} ${title}`), text });
  const summary = (
    id: string,
    text: Binding,
    instruction = 'Summarize this synthetic demonstration in three concise bullet points. Prefix the first line [NF DEMO].',
  ) => n('ai.summarize', id, { instruction }, { text });
  const write = (id: string, text: Binding, instruction: string) =>
    n('ai.generate', id, { instruction }, { text });
  const extract = (id: string, text: Binding, fields: string, instruction: string) =>
    n('ai.extract', id, { fields, instruction }, { text });
  const slack = (id: string, text: Binding) =>
    n('slack.send', id, { connectionId: a.slack, channelId: a.slackChannel }, { text });
  const telegram = (id: string, text: Binding) =>
    n('telegram.send', id, { connectionId: a.telegram, chatId: a.telegramChat || '' }, { text });
  const discord = (id: string, text: Binding) =>
    n('discord.send', id, { connectionId: a.discord }, { text });
  const sheet = (id: string, action: 'read' | 'append', range: string, rows?: Binding) =>
    n(
      `sheets.${action}`,
      id,
      {
        connectionId: a.google,
        spreadsheetId: a.spreadsheet,
        range,
        ...(action === 'read'
          ? {}
          : {
              columns:
                (
                  {
                    Leads: 'name,email,company,request,priority,source',
                    InvoiceDrafts: 'reference,customer,item,quantity,unit_price,currency',
                    Audit: 'id,title,text',
                    Purchases: 'item,amount,approval',
                    Feedback: 'sentiment,feedback,source',
                  } as Record<string, string>
                )[range.split('!')[0]!] || '',
            }),
      },
      rows ? { rows } : {},
    );
  const gmailDraft = (id: string, subject: string, text: Binding) =>
    n(
      'gmail.draft',
      id,
      { connectionId: a.google, to: a.selfEmail },
      { subject: c(`[NF DEMO] ${subject}`), text },
    );
  const foreach = (id: string, items: Binding, body: WorkflowDefinition) =>
    n('logic.foreach', id, { body: body as unknown as Json }, { items });
  const condition = (id: string, value: Binding, operator: string, compare: Binding = c('')) =>
    n('logic.condition', id, { operator }, { value, compare });
  const quiet = (id = 'quiet') =>
    n(
      'data.text',
      id,
      { operation: 'trim' },
      { text: c('[NF DEMO] No alert required for this item.') },
    );
  const add = (
    slug: string,
    name: string,
    source: string,
    definition: WorkflowDefinition,
    input: Record<string, Json> = {},
    purpose = '',
  ): Recipe => ({
    slug,
    name,
    source,
    definition,
    input,
    description:
      `${purpose || name}. Demo-safe: synthetic fixture data, owner automation destinations, disabled after testing. ${source}`.slice(
        0,
        500,
      ),
  });
  const recipes: Recipe[] = [];
  const demoLead =
    'SYNTHETIC DEMO: Name: Demo Buyer. Email: buyer@example.com. Company: Example Co. Request: inventory software demonstration. Priority: high.';
  const demoQuestion =
    'SYNTHETIC DEMO: What are your support hours and how long do demo orders take to ship?';

  recipes.push(
    add(
      'lead-capture',
      '[Sales] Website leads → CRM and alerts',
      'Photo: website lead capture; Telegram replaces unavailable WhatsApp.',
      graph([
        n('trigger.webhook', 'start'),
        extract(
          'lead',
          r('$input', 'body', 'json'),
          'name, email, company, request, priority, source',
          'Extract the fictional lead fields in the stated order. Never invent missing contact details.',
        ),
        sheet('crm', 'append', 'Leads!A:F', r('lead', 'data')),
        slack('sales_alert', r('lead', 'text')),
        telegram('mobile_alert', r('lead', 'text')),
        gmailDraft('followup', 'New demo lead — follow-up draft', r('lead', 'text')),
      ]),
      {
        body: {
          name: 'Demo Buyer',
          email: 'buyer@example.com',
          company: 'Example Co',
          request: 'Inventory software demo',
          priority: 'high',
          source: 'synthetic webhook',
        },
      },
    ),
  );

  const slaBody = graph([
    manual(),
    n('gmail.read', 'message', { connectionId: a.google }, { id: r('$input', 'item.id') }),
    n(
      'gmail.label',
      'label',
      { connectionId: a.google },
      { id: r('message', 'id'), labels: c('NeuralForgeDemo/SLA-Escalated') },
    ),
    slack('alert', r('message', 'text')),
    note('audit', 'SLA escalation', r('message', 'text')),
  ]);
  recipes.push(
    add(
      'email-sla',
      '[Sales] Unanswered Gmail SLA escalation',
      'Photo: Gmail reply SLA → Sheets/Slack; Gemini is optional.',
      graph([
        schedule('0 10 * * 1-5'),
        n(
          'gmail.search',
          'overdue',
          { connectionId: a.google },
          { query: c(`label:NeuralForgeDemo/${tag} subject:NFDEMO-${tag}-Awaiting older_than:1d`) },
        ),
        foreach('escalations', r('overdue', 'items'), slaBody),
        sheet('audit', 'append', 'Audit!A:D', r('escalations', 'items')),
      ]),
      {},
      'Find messages in the dedicated awaiting-reply demo label older than one day, label/escalate them and append an audit. Customize the label/search window for real SLA tracking',
    ),
  );

  recipes.push(
    add(
      'invoice-draft',
      '[Finance] Email → invoice draft and review',
      'Photo: invoice drafts from chat/forms, using Gemini and Google Workspace.',
      graph([
        n('trigger.gmail', 'start', {
          connectionId: a.google,
          query: `label:NeuralForgeDemo/${tag} subject:NFDEMO-${tag}-Invoice`,
        }),
        extract(
          'details',
          r('$input', 'text'),
          'reference, customer, item, quantity, unit_price, currency',
          'Extract factual fields from this fictional invoice request. This is a draft; do not invent tax or payment details.',
        ),
        sheet('ledger', 'append', 'InvoiceDrafts!A:F', r('details', 'data')),
        write(
          'invoice',
          r('details', 'text'),
          'Write a clearly marked [NF DEMO — DRAFT] invoice in plain text. Show quantity, unit price, and arithmetic total. State that a human must verify tax and totals before issuing. Never send it to a customer.',
        ),
        n(
          'drive.create',
          'document',
          { connectionId: a.google },
          { name: c(`NFDEMO-${tag}-invoice-draft.txt`), text: r('invoice', 'text') },
        ),
        n(
          'logic.approval',
          'review',
          { message: 'Review this synthetic invoice draft before preparing the email.' },
          { details: r('invoice', 'text') },
        ),
        gmailDraft('draft', 'Invoice draft awaiting verification', r('invoice', 'text')),
      ]),
      {
        id: a.messages.invoice,
        text: 'SYNTHETIC DEMO invoice request. Reference DEMO-INV-003. Customer Example Co. Training service, quantity 2, unit price 100 USD.',
      },
    ),
  );

  function support(kind: 'gmail' | 'telegram' | 'slack') {
    const start =
      kind === 'gmail'
        ? n('trigger.gmail', 'start', {
            connectionId: a.google,
            query: `label:NeuralForgeDemo/${tag} subject:NFDEMO-${tag}-Support`,
          })
        : kind === 'telegram'
          ? n('trigger.telegram', 'start', { connectionId: a.telegram })
          : n('trigger.slack', 'start', { connectionId: a.slack, channelId: a.slackChannel });
    const nodes = [
      start,
      n('notes.read', 'handbook', {}, { id: c(a.knowledgeNote) }),
      n('data.map', 'question', {}, { data: r('$input', 'text') }),
      n('logic.join', 'context'),
      write(
        'answer',
        r('context', 'items', 'json'),
        'Draft an answer to the fictional question using only the included handbook. Prefix [NF DEMO]. If the handbook does not answer it, ask for human review. No external knowledge or invented policies.',
      ),
      kind === 'gmail'
        ? gmailDraft('reply', 'Support reply for human review', r('answer', 'text'))
        : kind === 'telegram'
          ? telegram('reply', r('answer', 'text'))
          : note('reply', 'Slack support reply draft', r('answer', 'text')),
    ];
    const edges = [
      link('start', 'handbook'),
      link('start', 'question'),
      link('handbook', 'context'),
      link('question', 'context'),
      link('context', 'answer'),
      link('answer', 'reply'),
    ];
    return add(
      `support-${kind}`,
      `[Support] ${kind === 'gmail' ? 'Gmail' : kind === 'telegram' ? 'Telegram' : 'Slack'} handbook answer ${kind === 'telegram' ? 'bot' : 'draft'}`,
      'Photo: multi-channel support; built-in handbook retrieval replaces unavailable Supabase/vector RAG.',
      graph(nodes, edges),
      { text: demoQuestion, id: a.messages.support, chatId: a.telegramChat },
    );
  }
  recipes.push(support('gmail'), support('telegram'), support('slack'));

  recipes.push(
    add(
      'contract-checklist',
      '[Management] Contract obligations → review checklist',
      'Photo: legal-document review, adapted to factual extraction and human review.',
      graph([
        manual(),
        extract(
          'obligations',
          r('$input', 'text'),
          'parties, deliverables, deadlines, missing_information',
          'Extract only explicit facts from this fictional training contract. Do not claim legal compliance, enforceability, or provide legal advice. Mark ambiguity for a human reviewer.',
        ),
        note('checklist', 'Contract obligation checklist — draft', r('obligations', 'text')),
        n(
          'logic.approval',
          'review',
          { message: 'Review the extracted fictional obligations; this is not legal advice.' },
          { details: r('obligations', 'text') },
        ),
        slack('alert', r('obligations', 'text')),
      ]),
      {
        text: 'FICTIONAL TRAINING CONTRACT: Example Co supplies a demo handbook to Sample Ltd by 30 October 2026. Sample Ltd reviews it within five business days. Governing law and cancellation terms are not specified.',
      },
    ),
  );

  recipes.push(
    add(
      'telegram-assistant',
      '[Personal] Telegram text → action checklist',
      'Photo: Angie assistant; text supported, voice processing deferred.',
      graph([
        n('trigger.telegram', 'start', { connectionId: a.telegram }),
        write(
          'plan',
          r('$input', 'text'),
          'Turn this fictional request into a short actionable checklist. Prefix [NF DEMO]. Do not claim actions are completed, create meetings, send emails or infer missing dates.',
        ),
        note('save', 'Personal task checklist', r('plan', 'text')),
        telegram('reply', r('plan', 'text')),
      ]),
      {
        text: 'SYNTHETIC DEMO: Prepare a sample campaign brief, review the mockup, and remind the demo team about the Monday review.',
        chatId: a.telegramChat,
      },
    ),
  );

  const qaNodes = [
    manual(),
    sheet('rows', 'read', 'Budget!A1:D3'),
    n('data.map', 'question', {}, { data: r('$input', 'text') }),
    n('logic.join', 'context'),
    write(
      'answer',
      r('context', 'items', 'json'),
      'Answer the question using only these synthetic spreadsheet rows. Explain arithmetic and cite the department row. Do not invent figures or make investment recommendations.',
    ),
    note('save', 'Spreadsheet question answer', r('answer', 'text')),
    slack('share', r('answer', 'text')),
  ];
  recipes.push(
    add(
      'sheet-qa',
      '[Management] Ask questions about the demo budget',
      'Photo: chat with a database, adapted to connected Google Sheets; external SQL databases are unavailable.',
      graph(qaNodes, [
        link('start', 'rows'),
        link('start', 'question'),
        link('rows', 'context'),
        link('question', 'context'),
        link('context', 'answer'),
        link('answer', 'save'),
        link('save', 'share'),
      ]),
      { text: 'Which demo department is over budget, and by how much?' },
    ),
  );

  const handbookNodes = [
    manual(),
    n('drive.read', 'handbook', { connectionId: a.google, fileId: a.knowledgeFile }),
    n('data.map', 'question', {}, { data: r('$input', 'text') }),
    n('logic.join', 'context'),
    write(
      'answer',
      r('context', 'items', 'json'),
      'Answer the question using only the supplied fictional document. Cite its filename. If the answer is absent, say it is absent and request review. This is selected-document retrieval, not a vector search index.',
    ),
    note('save', 'Drive handbook answer', r('answer', 'text')),
    telegram('share', r('answer', 'text')),
  ];
  recipes.push(
    add(
      'handbook-qa',
      '[Support] Drive handbook → grounded answer',
      'Photo: company-document RAG using Drive/Gemini; selected-document retrieval without a vector index.',
      graph(handbookNodes, [
        link('start', 'handbook'),
        link('start', 'question'),
        link('handbook', 'context'),
        link('question', 'context'),
        link('context', 'answer'),
        link('answer', 'save'),
        link('save', 'share'),
      ]),
      { text: demoQuestion },
    ),
  );

  recipes.push(
    add(
      'gmail-label',
      '[Email] Classify and label demo Gmail',
      'Photo: automatic Gmail labeling, Gemini replaces OpenAI.',
      graph([
        n('trigger.gmail', 'start', {
          connectionId: a.google,
          query: `label:NeuralForgeDemo/${tag}`,
        }),
        n(
          'ai.classify',
          'classify',
          {
            labels: 'Sales, Support, Finance, Other',
            instruction: 'Classify this fictional email into exactly one allowed category.',
          },
          { text: r('$input', 'text') },
        ),
        n(
          'gmail.label',
          'label',
          { connectionId: a.google },
          { id: r('$input', 'id'), labels: r('classify', 'label') },
        ),
        note('audit', 'Email classification', r('classify', 'label')),
      ]),
      { id: a.messages.lead, text: demoLead },
    ),
  );

  recipes.push(
    add(
      'landing-audit',
      '[Marketing] Public landing-page improvement draft',
      'Photo: landing-page analysis, using Gemini instead of OpenAI.',
      graph([
        manual(),
        n(
          'http.request',
          'page',
          { method: 'GET', allowPrivate: false },
          { url: c('https://example.com') },
        ),
        write(
          'review',
          r('page', 'text'),
          'Review this public demonstration HTML page for clarity, headings, accessibility and a call to action. Prefix [NF DEMO]. Distinguish what is visible from recommendations; do not invent analytics or conversion rates.',
        ),
        note('save', 'Public landing-page review', r('review', 'text')),
        slack('share', r('review', 'text')),
      ]),
      {},
    ),
  );

  recipes.push(
    add(
      'daily-agenda',
      '[Personal] Calendar → Telegram brief with local AI',
      'Photo: personal life manager using Telegram/Google; voice is deferred.',
      graph([
        schedule('0 8 * * *'),
        n('calendar.list', 'events', { connectionId: a.google, calendarId: a.calendar }),
        n(
          'data.filter',
          'demo_events',
          { field: 'summary' },
          { items: r('events', 'items'), value: c(a.calendarTitle) },
        ),
        n('data.csv.create', 'brief', {}, { items: r('demo_events', 'items') }),
        // Calendar metadata can contain real organizer addresses; local AI keeps this private.
        n(
          'ai.summarize',
          'summary',
          {
            provider: 'ollama',
            model: 'qwen3:4b',
            instruction:
              'Summarize only the listed demonstration calendar events as a brief agenda. Prefix [NF DEMO].',
          },
          { text: r('brief', 'text') },
        ),
        telegram('send', r('summary', 'text')),
      ]),
      {},
      'Scheduled local-AI agenda. The demo event filter limits testing; keep local AI for real private calendar data',
    ),
  );

  recipes.push(
    add(
      'learn-json',
      '[Learning] JSON basics → readable note',
      'Photo: interactive JSON basics, adapted to executable field mapping.',
      graph([
        manual(),
        n('data.json.parse', 'parse', {}, { text: r('$input', 'text') }),
        note('result', 'JSON field mapping', r('parse', 'data.customer.name')),
      ]),
      {
        text: '{"customer":{"name":"Fictional Demo Buyer","priority":"high"},"items":["demo handbook","sample training"]}',
      },
    ),
  );
  recipes.push(
    add(
      'learn-basics',
      '[Learning] Workflow basics in three steps',
      'Photo: n8n basics, adapted to this engine; n8n-format compatibility is deferred.',
      graph([
        manual(),
        n('data.text', 'format', { operation: 'upper' }, { text: r('$input', 'text') }),
        note('save', 'Three-step workflow result', r('format', 'text')),
      ]),
      { text: 'A trigger starts work, a step processes it, and the last step saves the result.' },
    ),
  );
  recipes.push(
    add(
      'learn-mappings',
      '[Learning] No-code data mapping tutorial',
      'Photo: JavaScript code-node tutorial, adapted to safe field mapping; arbitrary code is unsupported.',
      graph([
        manual(),
        n('data.json.parse', 'parse', {}, { text: r('$input', 'text') }),
        n('data.map', 'select', {}, { data: r('parse', 'data.customer') }),
        n('data.json.create', 'format', {}, { data: r('select', 'data') }),
        note('save', 'Selected customer fields', r('format', 'text')),
      ]),
      {
        text: '{"customer":{"name":"Fictional Buyer","team":"Demo Sales"},"internal_example":"Not selected"}',
      },
    ),
  );

  const stockBody = graph(
    [
      manual(),
      condition('low', r('$input', 'item.3'), 'greater', r('$input', 'item.2')),
      slack('slack', r('$input', 'item', 'json')),
      telegram('telegram', r('$input', 'item', 'json')),
      n('logic.join', 'sent'),
      quiet(),
    ],
    [
      link('start', 'low'),
      link('low', 'slack', 'true'),
      link('low', 'telegram', 'true'),
      link('slack', 'sent'),
      link('telegram', 'sent'),
      link('low', 'quiet', 'false'),
    ],
  );
  recipes.push(
    add(
      'stock-alert',
      '[Operations] Low-stock alerts with boundary checks',
      'Original advanced business workflow.',
      graph([
        schedule('0 9,16 * * 1-5'),
        sheet('stock', 'read', 'Stock!A2:D4'),
        foreach('check_stock', r('stock', 'items'), stockBody),
        note('audit', 'Stock checks', r('check_stock', 'items', 'json')),
      ]),
      {},
      'Checks on-hand against each reorder point; below alerts, equal/above do not. Tests contain all three cases',
    ),
  );

  const budgetBody = graph(
    [
      manual(),
      condition('over', r('$input', 'item.3'), 'greater', c(0)),
      slack('alert', r('$input', 'item', 'json')),
      quiet(),
    ],
    [link('start', 'over'), link('over', 'alert', 'true'), link('over', 'quiet', 'false')],
  );
  recipes.push(
    add(
      'budget-alert',
      '[Finance] Budget variance exception alerts',
      'Original advanced business workflow.',
      graph([
        schedule('0 17 * * 5'),
        sheet('budget', 'read', 'Budget!A2:D3'),
        foreach('check_budget', r('budget', 'items'), budgetBody),
        note('audit', 'Budget exception audit', r('check_budget', 'items', 'json')),
      ]),
      {},
      'Deterministic variance alert; synthetic over-budget and within-budget rows exercise both branches',
    ),
  );

  const overdueBody = graph(
    [
      manual(),
      condition('late', r('$input', 'item.3'), 'greater', c(0)),
      slack('alert', r('$input', 'item', 'json')),
      gmailDraft(
        'draft',
        'Overdue invoice reminder — review before sending',
        r('$input', 'item', 'json'),
      ),
      quiet(),
    ],
    [
      link('start', 'late'),
      link('late', 'alert', 'true'),
      link('alert', 'draft'),
      link('late', 'quiet', 'false'),
    ],
  );
  recipes.push(
    add(
      'invoice-overdue',
      '[Finance] Unpaid invoice escalation and reminder draft',
      'Original advanced business workflow.',
      graph([
        schedule('0 10 * * 1-5'),
        sheet('invoices', 'read', 'Invoices!A2:E3'),
        n(
          'data.filter',
          'unpaid',
          { field: '4' },
          { items: r('invoices', 'items'), value: c('unpaid') },
        ),
        foreach('reminders', r('unpaid', 'items'), overdueBody),
      ]),
      {},
      'Filters unpaid rows before checking days overdue, alerts Slack, and creates a self-addressed draft rather than emailing customers',
    ),
  );

  const riskBody = graph(
    [
      manual(),
      condition('late', r('$input', 'item.2'), 'greater', c(0)),
      discord('risk', r('$input', 'item', 'json')),
      quiet(),
    ],
    [link('start', 'late'), link('late', 'risk', 'true'), link('late', 'quiet', 'false')],
  );
  recipes.push(
    add(
      'project-risk',
      '[Management] Open-project deadline risk alerts',
      'Original advanced business workflow.',
      graph([
        schedule('0 16 * * 1-5'),
        sheet('projects', 'read', 'Projects!A2:D3'),
        n(
          'data.filter',
          'open',
          { field: '3' },
          { items: r('projects', 'items'), value: c('open') },
        ),
        foreach('risks', r('open', 'items'), riskBody),
        note('audit', 'Project risk audit', r('risks', 'items', 'json')),
      ]),
    ),
  );

  recipes.push(
    add(
      'purchase-approval',
      '[Management] Purchase request → approval and ledger',
      'Original advanced business workflow.',
      graph([
        manual(),
        n(
          'logic.approval',
          'approval',
          {
            message:
              'Review this synthetic purchase request. Approve only when the amount and item are acceptable.',
          },
          { details: r('$input', 'body', 'json') },
        ),
        sheet('ledger', 'append', 'Purchases!A:C', r('$input', 'body')),
        slack('receipt', r('$input', 'body', 'json')),
        note('audit', 'Purchase approval', r('$input', 'body', 'json')),
      ]),
      {
        body: {
          item: 'Fictional training handbook',
          amount: 200,
          approval: 'approved synthetic test',
        },
      },
    ),
  );

  const incidentGraph = graph(
    [
      n('trigger.webhook', 'start'),
      condition('critical', r('$input', 'body.severity'), 'greater', c(2)),
      slack('slack', r('$input', 'body', 'json')),
      telegram('telegram', r('$input', 'body', 'json')),
      discord('discord', r('$input', 'body', 'json')),
      n('logic.join', 'notifications'),
      note('audit', 'Critical incident delivery audit', r('notifications', 'items', 'json')),
      quiet(),
    ],
    [
      link('start', 'critical'),
      link('critical', 'slack', 'true'),
      link('critical', 'telegram', 'true'),
      link('critical', 'discord', 'true'),
      link('slack', 'notifications'),
      link('telegram', 'notifications'),
      link('discord', 'notifications'),
      link('notifications', 'audit'),
      link('critical', 'quiet', 'false'),
    ],
  );
  const incident = add(
    'incident-alert',
    '[Operations] Critical incident → parallel channel alerts',
    'Original advanced business workflow.',
    incidentGraph,
    {
      body: {
        reference: 'NF-DEMO-INC-001',
        severity: 3,
        message: 'SYNTHETIC TEST: demo service is unavailable. No real incident.',
      },
    },
  );
  incident.cases = [
    {
      name: 'low-severity-no-alert',
      input: {
        body: {
          reference: 'NF-DEMO-INC-LOW',
          severity: 1,
          message: 'SYNTHETIC TEST: informational event only.',
        },
      },
    },
  ];
  recipes.push(incident);

  recipes.push(
    add(
      'meeting-brief',
      '[Management] Meeting notes → brief and follow-up draft',
      'Original advanced business workflow.',
      graph([
        manual(),
        summary(
          'brief',
          r('$input', 'text'),
          'Extract fictional decisions, action owners and next steps. Prefix [NF DEMO]. Do not infer unprovided deadlines.',
        ),
        n(
          'drive.create',
          'document',
          { connectionId: a.google },
          { name: c(`NFDEMO-${tag}-meeting-brief.txt`), text: r('brief', 'text') },
        ),
        gmailDraft('email', 'Meeting actions — draft', r('brief', 'text')),
        slack('share', r('brief', 'text')),
      ]),
      {
        text: 'SYNTHETIC DEMO MEETING: Demo Design will prepare a mockup. Demo QA will test signup. The fictional team will review progress on Monday. No real attendees or customer details.',
      },
    ),
  );

  const managementNodes = [
    schedule('0 17 * * 5'),
    sheet('budget', 'read', 'Budget!A1:D3'),
    sheet('stock', 'read', 'Stock!A1:D4'),
    sheet('projects', 'read', 'Projects!A1:D3'),
    n('logic.join', 'facts'),
    summary(
      'report',
      r('facts', 'items', 'json'),
      'Create a concise [NF DEMO] management digest from these fictional budget, stock and project rows. Show exceptions, arithmetic and proposed owners for human review. No invented metrics.',
    ),
    note('save', 'Weekly management digest', r('report', 'text')),
    slack('slack', r('report', 'text')),
    discord('discord', r('report', 'text')),
    n('logic.join', 'delivered'),
  ];
  recipes.push(
    add(
      'weekly-management',
      '[Management] Parallel KPI reads → weekly exception digest',
      'Original advanced business workflow; a data-fed report rather than live stock-market analysis.',
      graph(managementNodes, [
        link('start', 'budget'),
        link('start', 'stock'),
        link('start', 'projects'),
        link('budget', 'facts'),
        link('stock', 'facts'),
        link('projects', 'facts'),
        link('facts', 'report'),
        link('report', 'save'),
        link('save', 'slack'),
        link('save', 'discord'),
        link('slack', 'delivered'),
        link('discord', 'delivered'),
      ]),
    ),
  );

  recipes.push(
    add(
      'feedback-triage',
      '[Support] Feedback classification → exception alert',
      'Original advanced business workflow.',
      graph(
        [
          n('trigger.webhook', 'start'),
          extract(
            'sentiment',
            r('$input', 'body', 'json'),
            'sentiment, feedback, source',
            'Extract the fictional feedback and source. Set sentiment to exactly positive, negative, or neutral. Preserve the feedback wording.',
          ),
          sheet('ledger', 'append', 'Feedback!A:C', r('sentiment', 'data')),
          condition('negative', r('sentiment', 'data.sentiment'), 'equals', c('negative')),
          slack('alert', r('$input', 'body.feedback')),
          quiet(),
        ],
        [
          link('start', 'sentiment'),
          link('sentiment', 'ledger'),
          link('ledger', 'negative'),
          link('negative', 'alert', 'true'),
          link('negative', 'quiet', 'false'),
        ],
      ),
      {
        body: {
          feedback:
            'SYNTHETIC DEMO: The sample shipment was late and the response was unhelpful. Please investigate.',
        },
      },
    ),
  );

  const classifyBody = graph([
    manual(),
    n(
      'ai.classify',
      'classify',
      {
        labels: 'positive, negative, neutral',
        instruction: 'Classify the fictional feedback only.',
      },
      { text: r('$input', 'item.feedback') },
    ),
    note('save', 'CSV feedback classification', r('classify', 'label')),
  ]);
  recipes.push(
    add(
      'csv-batch-classify',
      '[Operations] CSV feedback → bounded AI classification',
      'Starter template expansion: CSV rows, local file, bounded list.',
      graph([
        manual(),
        n('files.read', 'csv', {}, { path: c('NeuralForgeDemoSuite/inputs/feedback.csv') }),
        n('data.csv.parse', 'rows', {}, { text: r('csv', 'text') }),
        foreach('classifications', r('rows', 'items'), classifyBody),
        n('data.json.create', 'results', {}, { data: r('classifications', 'items') }),
        n(
          'drive.create',
          'export',
          { connectionId: a.google },
          { name: c(`NFDEMO-${tag}-feedback-results.json`), text: r('results', 'text') },
        ),
      ]),
    ),
  );
  recipes.push(
    add(
      'file-summary',
      '[Operations] New text file → AI summary and email draft',
      'Starter template expansion: file summary, Gmail instead of unconnected SMTP.',
      graph([
        n('trigger.file', 'start', { folder: 'NeuralForgeDemoSuite/inputs' }),
        n('files.read', 'file', {}, { path: r('$input', 'path') }),
        summary('summary', r('file', 'text')),
        gmailDraft('draft', 'New demo file summary', r('summary', 'text')),
        discord('alert', r('summary', 'text')),
      ]),
      { path: 'NeuralForgeDemoSuite/inputs/meeting.txt' },
    ),
  );

  recipes.push(
    add(
      'outlook-followup',
      '[Sales] Outlook mail → follow-up draft and Slack',
      'Original business workflow using connected personal Outlook.',
      graph([
        n('trigger.outlook', 'start', { connectionId: a.microsoft }),
        write(
          'reply',
          r('$input', 'text'),
          'Draft a courteous follow-up to this fictional request. Prefix [NF DEMO]. Do not promise prices or dates not supplied.',
        ),
        n(
          'outlook.draft',
          'draft',
          { connectionId: a.microsoft, to: a.selfEmail },
          { subject: c('[NF DEMO] Follow-up draft'), text: r('reply', 'text') },
        ),
        slack('review', r('reply', 'text')),
      ]),
      {
        id: 'synthetic-trigger-payload',
        text: 'SYNTHETIC DEMO: Example Co requested a training demonstration and asked which times are available. No appointment time has been agreed.',
      },
    ),
  );
  recipes.push(
    add(
      'gmail-self-delivery',
      '[Email] Gmail self-delivery verification',
      'Original connector verification workflow; sends only to the connected owner.',
      graph([
        manual(),
        n(
          'gmail.send',
          'send',
          { connectionId: a.google, to: a.selfEmail },
          {
            subject: c(`[NF DEMO ${tag}] Gmail workflow delivery`),
            text: c(
              'SYNTHETIC WORKFLOW TEST. Neural Forge completed its Gmail send step. No customer action is required.',
            ),
          },
        ),
        note('audit', 'Gmail send receipt', r('send', 'id')),
      ]),
    ),
  );
  recipes.push(
    add(
      'outlook-self-delivery',
      '[Email] Outlook self-delivery verification',
      'Original connector verification workflow; sends only to the connected owner.',
      graph([
        manual(),
        n(
          'outlook.send',
          'send',
          { connectionId: a.microsoft, to: a.selfEmail },
          {
            subject: c(`[NF DEMO ${tag}] Outlook workflow delivery`),
            text: c(
              'SYNTHETIC WORKFLOW TEST. Neural Forge completed its Outlook send step. No customer action is required.',
            ),
          },
        ),
        note('audit', 'Outlook send receipt', r('send', 'id')),
      ]),
    ),
  );
  recipes.push(
    add(
      'delay-followup',
      '[Sales] Durable delay → follow-up draft and alert',
      'Original advanced business workflow.',
      graph([
        manual(),
        n('logic.delay', 'wait', { seconds: 2 }),
        gmailDraft('draft', 'Delayed follow-up draft', r('$input', 'text')),
        slack('ready', c('[NF DEMO] The delayed follow-up draft is ready for review.')),
      ]),
      {
        text: 'SYNTHETIC DEMO: Thank you for your interest in the fictional training session. Please propose a convenient time.',
      },
      'The two-second demo delay is persisted by the engine; edit it to the desired business interval before enabling',
    ),
  );
  recipes.push(
    add(
      'calendar-update',
      '[Management] Reschedule a demo calendar review',
      'Original connector verification workflow; modifies only the fixture event.',
      graph([
        manual(),
        n(
          'calendar.update',
          'update',
          { connectionId: a.google, calendarId: a.calendar },
          {
            eventId: c(a.calendarEvent),
            title: c(a.calendarTitle),
            start: c(new Date(new Date(a.eventStart).getTime() + 15 * 60_000).toISOString()),
            end: c(new Date(new Date(a.eventEnd).getTime() + 15 * 60_000).toISOString()),
          },
        ),
        slack(
          'alert',
          c(
            '[NF DEMO] The synthetic planning-review calendar event was updated. No attendees were invited.',
          ),
        ),
      ]),
    ),
  );
  recipes.push(
    add(
      'notes-rewrite',
      '[Management] Rewrite a note and preserve its source',
      'Starter template: rewrite a note and save separately.',
      graph([
        manual(),
        n('notes.read', 'original', {}, { id: c(a.knowledgeNote) }),
        n(
          'ai.rewrite',
          'rewrite',
          {
            instruction:
              'Rewrite this fictional handbook clearly without changing facts. Prefix [NF DEMO].',
          },
          { text: r('original', 'text') },
        ),
        note('save', 'Rewritten handbook copy', r('rewrite', 'text')),
      ]),
    ),
  );
  recipes.push(
    add(
      'daily-notes-summary',
      '[Management] Daily demo notes summary → Telegram',
      'Starter template: daily notes summary and alert.',
      graph([
        schedule('0 20 * * *'),
        n('notes.search', 'notes', { period: 'today' }, { query: c(`NFDEMO ${tag} knowledge`) }),
        summary('summary', r('notes', 'text')),
        telegram('share', r('summary', 'text')),
      ]),
    ),
  );
  for (const recipe of recipes) {
    if (
      ['support-telegram', 'support-slack', 'telegram-assistant', 'outlook-followup'].includes(
        recipe.slug,
      )
    ) {
      recipe.definition.settings.ai = {
        provider: 'ollama',
        model: 'qwen3:4b',
        dataPolicy: 'private',
      };
      recipe.description =
        `${recipe.description} Uses local AI for private incoming messages.`.slice(0, 500);
    }
  }
  return recipes;
}

export const photoCoverage = [
  {
    title: 'Capture website leads in Sheets CRM with WhatsApp/Gmail alerts',
    delivery: 'Created: lead-capture; Telegram substitutes for unconnected WhatsApp.',
  },
  {
    title: 'Answer Shopify order-status questions on WhatsApp',
    delivery: 'Deferred: Shopify and WhatsApp are not connected.',
  },
  {
    title: 'Process Shopify returns with Shiprocket/WhatsApp/Gmail',
    delivery: 'Deferred: Shopify, Shiprocket and WhatsApp are not connected.',
  },
  {
    title: 'Convert Instagram carousels into TikTok/Reels videos',
    delivery: 'Deferred: media extraction/rendering and publishing connectors are unavailable.',
  },
  {
    title: 'Track client reply SLAs in Gmail with AI, Sheets and Slack',
    delivery:
      'Created: email-sla; Gmail search-window escalation with audit. Demo uses a backdated imported message.',
  },
  {
    title: 'Create invoice drafts from chat/forms with AI and Google Workspace',
    delivery:
      'Created: invoice-draft and lead-capture; Gemini replaces Claude; human approval retained.',
  },
  {
    title: 'AI stock reports with fundamental, technical and news analysis',
    delivery:
      'Deferred: market/news data feeds are not configured. weekly-management covers supplied business KPI data only.',
  },
  {
    title: 'Facebook Messenger chatbot',
    delivery: 'Deferred: Facebook Messenger is not connected.',
  },
  {
    title: 'WordPress news-digest videos to YouTube',
    delivery: 'Deferred: WordPress, video rendering and YouTube publishing are unavailable.',
  },
  {
    title: 'Multi-channel support with OpenAI RAG and Supabase',
    delivery:
      'Adapted: support-gmail, support-telegram and support-slack use a built-in fictional handbook; no Supabase/vector index.',
  },
  {
    title: 'Extract external YouTube transcripts',
    delivery: 'Deferred: no supported transcript connector is connected.',
  },
  {
    title: 'Intelligent legal document review and compliance automation',
    delivery:
      'Adapted: contract-checklist extracts fictional obligations for human review; it does not certify legal compliance.',
  },
  {
    title: 'Angie Telegram voice/text personal assistant',
    delivery: 'Adapted: telegram-assistant supports text checklists; voice is unsupported.',
  },
  {
    title: 'Generate viral videos with NanoBanana/VEO and share on social media',
    delivery:
      'Deferred: video generation and social publishing are outside the implemented catalog.',
  },
  {
    title: 'Chat with a database using AI',
    delivery:
      'Adapted: sheet-qa uses the connected demo spreadsheet; external SQL database chat remains deferred.',
  },
  {
    title: 'RAG chatbot for company Drive documents with Gemini',
    delivery:
      'Adapted: handbook-qa retrieves one selected Drive document and cites its filename; no vector-search index.',
  },
  {
    title: 'Automatic Gmail labeling with OpenAI',
    delivery: 'Created: gmail-label; Gemini replaces OpenAI.',
  },
  {
    title: 'Analyze a landing page with AI and get optimization tips',
    delivery: 'Created: landing-audit for public example.com.',
  },
  {
    title: 'Telegram/Google personal life manager with voice AI',
    delivery: 'Adapted: daily-agenda and daily-notes-summary; voice is deferred.',
  },
  {
    title: 'Generate VEO videos and upload to TikTok',
    delivery: 'Deferred: VEO and TikTok are not connected.',
  },
  {
    title: 'Learn JSON with an interactive beginner tutorial',
    delivery: 'Created: learn-json and learn-mappings demonstrate parsing and field selection.',
  },
  {
    title: 'Learn n8n basics in three steps',
    delivery:
      'Adapted: learn-basics teaches this engine. n8n workflow-format compatibility is unsupported.',
  },
  {
    title: 'Learn JavaScript Code Node through an interactive tutorial',
    delivery:
      'Adapted: learn-mappings teaches safe no-code mapping; arbitrary JavaScript is outside v1.',
  },
];
