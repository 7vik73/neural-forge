// Run inside the existing API container; connection secrets never leave its adapters.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Database } from '../apps/backend/dist/database.js';
import { Connections, providerFetch } from '../apps/backend/dist/connections.js';
import { LocalAI } from '../apps/backend/dist/ai.js';
import { Operations } from '../apps/backend/dist/operations.js';
import { ExecutionEngine } from '../apps/backend/dist/engine.js';
import { storagePath } from '../apps/backend/dist/storage.js';
import { buildRecipes, photoCoverage } from './recipes.ts';
import { catalog } from '../packages/connectors/dist/index.js';

const { google } = createRequire(new URL('../apps/backend/package.json', import.meta.url))(
  'googleapis',
);

const workspaceId = process.env.FORGE_WORKSPACE_ID;
const username = process.env.FORGE_USERNAME;
if (!workspaceId || !username) throw new Error('Supply FORGE_WORKSPACE_ID and FORGE_USERNAME.');
const mode = process.argv[2] || 'inventory';
const db = new Database();
const connections = new Connections(db);
const ai = new LocalAI(db);
const operations = new Operations(db, connections, ai);
const engine = new ExecutionEngine(db, operations);
const say = (value) => console.log(JSON.stringify(value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let manifest, root, folder;
const save = async () => {
  const target = join(folder, 'manifest.json'),
    temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(manifest, null, 2));
  await rename(temporary, target);
};
const options = { retry: false, timeout: 30_000 };
async function fixtureFile(name, text) {
  try {
    return await operations.files.write(name, text, true);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if ((await operations.files.read(name)).text !== text)
      throw new Error(`Existing demo fixture changed: ${name}`);
  }
}

async function inventory() {
  const records = await connections.list();
  const find = (kind) => {
    const record = records.find((item) => item.kind === kind && item.status === 'connected');
    if (!record) throw new Error(`Connect ${kind} before preparing this suite.`);
    return record.id;
  };
  const r = manifest.resources;
  r.google = find('google');
  r.gemini = find('gemini');
  r.slack = find('slack');
  r.discord = find('discord');
  r.telegram = find('telegram');
  r.microsoft = find('microsoft');
  const gmail = google.gmail({ version: 'v1', auth: await connections.google(r.google, 'gmail') });
  r.selfEmail = (await gmail.users.getProfile({ userId: 'me' }, options)).data.emailAddress;
  const channels = await connections.resources(r.slack, 'channels');
  r.slackChannel = channels.find((channel) => channel.name === 'automation')?.id;
  if (!r.slackChannel) throw new Error('The nominated Slack #automation channel is unavailable.');
  const bot = await connections.telegram(r.telegram, 'getMe');
  const chats = await connections.resources(r.telegram, 'chats');
  say({ phase: 'telegram-detection', botUsername: bot.username, detectedChats: chats.length });
  // Use only the owner's sole detected direct bot chat; never guess a group destination.
  const direct = chats.filter((chat) => !String(chat.id).startsWith('-'));
  if (direct.length === 1) r.telegramChat = direct[0].id;
  if (!r.telegramChat)
    say({
      phase: 'attention',
      message: 'A fresh message to the Telegram bot is needed before Telegram tests.',
    });
  const discord = await providerFetch((await connections.get(r.discord)).credentials.webhook);
  r.discordChannel = discord.channel_id;
  r.calendar = 'primary';
  r.model = 'gemini-3.5-flash-lite';
  await save();
  say({
    phase: 'inventory',
    connections: records.map(({ kind, status }) => ({ kind, status })),
    slackAutomationFound: true,
    telegramDirectChatFound: !!r.telegramChat,
    discordWebhookAccessible: !!discord.id,
    ownerMailboxVerified: !!r.selfEmail,
  });
}

async function prepare() {
  const r = manifest.resources;
  if (!r.google) await inventory();
  const sheets = google.sheets({
    version: 'v4',
    auth: await connections.google(r.google, 'sheets'),
  });
  if (!r.spreadsheet) {
    const created = await sheets.spreadsheets.create(
      {
        requestBody: {
          properties: { title: `Neural Forge Business Demo ${manifest.tag}` },
          sheets: [
            'Leads',
            'Invoices',
            'InvoiceDrafts',
            'Stock',
            'Budget',
            'Projects',
            'Feedback',
            'Audit',
            'Purchases',
          ].map((title) => ({ properties: { title } })),
        },
      },
      options,
    );
    r.spreadsheet = created.data.spreadsheetId;
    await save();
  }
  if (!r.seededSheets) {
    await sheets.spreadsheets.values.batchUpdate(
      {
        spreadsheetId: r.spreadsheet,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            {
              range: 'InvoiceDrafts!A1:F1',
              values: [['Reference', 'Customer', 'Item', 'Quantity', 'Unit price', 'Currency']],
            },
            {
              range: 'Leads!A1:F3',
              values: [
                ['Name', 'Email', 'Company', 'Need', 'Priority', 'Source'],
                [
                  'Demo Buyer',
                  'buyer@example.com',
                  'Example Co',
                  'Demo inventory software',
                  'high',
                  'synthetic',
                ],
                [
                  'Demo Partner',
                  'partner@example.com',
                  'Sample Ltd',
                  'Request product brochure',
                  'normal',
                  'synthetic',
                ],
              ],
            },
            {
              range: 'Invoices!A1:E3',
              values: [
                ['Invoice', 'Customer', 'Amount', 'Days overdue', 'Status'],
                ['DEMO-INV-001', 'Example Co', 2400, 12, 'unpaid'],
                ['DEMO-INV-002', 'Sample Ltd', 1500, 0, 'paid'],
              ],
            },
            {
              range: 'Stock!A1:D4',
              values: [
                ['SKU', 'Product', 'On hand', 'Reorder point'],
                ['DEMO-LOW', 'Demo paper', 3, 10],
                ['DEMO-OK', 'Demo pens', 40, 10],
                ['DEMO-EDGE', 'Demo folders', 10, 10],
              ],
            },
            {
              range: 'Budget!A1:D3',
              values: [
                ['Department', 'Budget', 'Actual', 'Variance'],
                ['Demo Marketing', 1000, 1300, 300],
                ['Demo Sales', 1000, 850, -150],
              ],
            },
            {
              range: 'Projects!A1:D3',
              values: [
                ['Project', 'Owner', 'Days late', 'Status'],
                ['Demo website', 'Demo design team', 4, 'open'],
                ['Demo training', 'Demo operations', 0, 'done'],
              ],
            },
            { range: 'Feedback!A1:C1', values: [['Sentiment', 'Feedback', 'Source']] },
            { range: 'Audit!A1:D1', values: [['Event', 'Details', 'Status', 'Source']] },
            { range: 'Purchases!A1:C1', values: [['Item', 'Amount', 'Approval']] },
          ],
        },
      },
      options,
    );
    r.seededSheets = true;
    await save();
  }
  const drive = google.drive({ version: 'v3', auth: await connections.google(r.google, 'drive') });
  if (!r.driveFolder) {
    r.driveFolder = (
      await drive.files.create(
        {
          requestBody: {
            name: `Neural Forge Demo ${manifest.tag}`,
            mimeType: 'application/vnd.google-apps.folder',
          },
          fields: 'id',
        },
        options,
      )
    ).data.id;
    await save();
  }
  if (!r.knowledgeFile) {
    const policy =
      'SYNTHETIC DEMO KNOWLEDGE. Example Co support hours are Monday to Friday, 09:00–17:00. Demo orders ship within two business days. A demo return can be requested within 14 days. Escalate a missing order to the operations lead. This is fictional training content.';
    r.knowledgeFile = (
      await drive.files.create(
        {
          requestBody: {
            name: `NFDEMO-${manifest.tag}-company-guide.txt`,
            parents: [r.driveFolder],
            mimeType: 'text/plain',
          },
          media: { mimeType: 'text/plain', body: policy },
          fields: 'id',
        },
        options,
      )
    ).data.id;
    await save();
  }
  if (!r.knowledgeNote) {
    const note = await db.note.create({
      data: {
        title: `NFDEMO ${manifest.tag} knowledge`,
        text: 'Fictional support handbook: Demo orders ship in two business days. Returns are accepted within 14 days. Support is open Monday to Friday, 09:00–17:00. Only use this synthetic knowledge for training.',
      },
    });
    r.knowledgeNote = note.id;
    await save();
  }
  await mkdir(join(root, 'NeuralForgeDemoSuite', 'inputs'), { recursive: true });
  await fixtureFile(
    'NeuralForgeDemoSuite/inputs/meeting.txt',
    'SYNTHETIC DEMO: A fictional team agreed to launch a sample campaign. Demo Design owns the mockup; Demo QA owns testing. The next review is on Monday.',
  );
  await fixtureFile(
    'NeuralForgeDemoSuite/inputs/feedback.csv',
    'id,feedback\nDEMO-1,"The demo onboarding was clear and helpful."\nDEMO-2,"The sample delivery was late; please follow up."\n',
  );
  const gmail = google.gmail({ version: 'v1', auth: await connections.google(r.google, 'gmail') });
  if (!r.demoLabel) {
    const name = `NeuralForgeDemo/${manifest.tag}`;
    r.demoLabel = (
      await gmail.users.labels.create(
        {
          userId: 'me',
          requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
        },
        options,
      )
    ).data.id;
    await save();
  }
  r.messages ||= {};
  for (const [key, subject, text] of [
    [
      'lead',
      'Lead',
      'SYNTHETIC DEMO: Name: Demo Buyer. Email: buyer@example.com. Company: Example Co. Request: a demo inventory system. Priority: high.',
    ],
    [
      'invoice',
      'Invoice',
      'SYNTHETIC DEMO invoice request. Customer: Example Co. Reference: DEMO-INV-003. Item: training service. Quantity: 2. Unit price: 100. Currency: USD.',
    ],
    [
      'sla',
      'Awaiting reply',
      'SYNTHETIC DEMO: We requested a product demonstration and have not received a response. Reference DEMO-SLA-001.',
    ],
    [
      'support',
      'Support',
      'SYNTHETIC DEMO: What are your support hours, and how many days does a demo shipment take?',
    ],
  ]) {
    if (r.messages[key]) continue;
    const date = new Date(`${manifest.today}T06:00:00Z`);
    if (key === 'sla') date.setUTCDate(date.getUTCDate() - 3);
    const raw = Buffer.from(
      `From: Fictional Demo <demo@example.com>\r\nTo: ${r.selfEmail}\r\nSubject: NFDEMO-${manifest.tag}-${subject}\r\nDate: ${date.toUTCString()}\r\nMessage-ID: <${manifest.tag}-${key}@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${text}`,
    ).toString('base64url');
    const imported = await gmail.users.messages.import(
      {
        userId: 'me',
        internalDateSource: 'dateHeader',
        requestBody: { raw, labelIds: [r.demoLabel] },
      },
      options,
    );
    r.messages[key] = imported.data.id;
    await save();
  }
  // Imported fictional messages may be classified as spam; move only our four fixture IDs.
  for (const id of Object.values(r.messages))
    await gmail.users.messages.modify(
      { userId: 'me', id, requestBody: { removeLabelIds: ['SPAM'], addLabelIds: ['INBOX'] } },
      options,
    );
  if (!r.calendarEvent) {
    const calendar = google.calendar({
      version: 'v3',
      auth: await connections.google(r.google, 'calendar'),
    });
    const future = new Date(`${manifest.today}T04:30:00Z`);
    future.setUTCDate(future.getUTCDate() + 3);
    r.eventStart = future.toISOString();
    r.eventEnd = new Date(future.getTime() + 1800000).toISOString();
    r.calendarTitle = `NFDEMO ${manifest.tag} planning review`;
    r.calendarEvent = (
      await calendar.events.insert(
        {
          calendarId: r.calendar,
          sendUpdates: 'none',
          requestBody: {
            summary: r.calendarTitle,
            description: 'Synthetic workflow test. No attendees or invitations.',
            start: { dateTime: r.eventStart },
            end: { dateTime: r.eventEnd },
          },
        },
        options,
      )
    ).data.id;
    await save();
  }
  say({
    phase: 'prepared',
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${r.spreadsheet}/edit`,
    fixtureMessages: Object.keys(r.messages).length,
    calendarEvents: 1,
    syntheticOnly: true,
  });
}

async function create() {
  const recipes = buildRecipes(manifest.resources, manifest.tag);
  manifest.workflows ||= {};
  const chosen = process.env.SUITE_SLUGS?.split(',');
  for (const recipe of recipes.filter((recipe) => !chosen || chosen.includes(recipe.slug))) {
    const issues = await engine.validate(recipe.definition);
    const waitingForChat = issues.length && issues.every((issue) => issue.field === 'chatId');
    if (issues.length && !waitingForChat)
      throw new Error(`${recipe.slug}: ${JSON.stringify(issues)}`);
    let entry = manifest.workflows[recipe.slug];
    if (!entry) {
      const workflow = await db.workflow.create({
        data: {
          name: recipe.name,
          description: recipe.description,
          draft: recipe.definition,
          enabled: false,
        },
        select: { id: true },
      });
      entry = manifest.workflows[recipe.slug] = { id: workflow.id, tests: [] };
      await save();
    } else {
      await db.workflow.update({
        where: { id: entry.id },
        data: {
          name: recipe.name,
          description: recipe.description,
          draft: recipe.definition,
          enabled: false,
          revision: { increment: 1 },
        },
      });
    }
    entry.name = recipe.name;
    entry.source = recipe.source;
    entry.input = recipe.input;
    entry.definition = recipe.definition;
    entry.ready = issues.length === 0;
    entry.setupIssues = issues;
    await save();
    say({ phase: 'created', slug: recipe.slug, name: recipe.name });
  }
}

async function runOne(recipe, preview, testInput = recipe.input, suffix = 'main') {
  const entry = manifest.workflows[recipe.slug];
  const graphHash = createHash('sha256').update(JSON.stringify(recipe.definition)).digest('hex');
  const previous = entry.tests.findLast(
    (test) => test.preview === preview && test.case === suffix && test.graphHash === graphHash,
  );
  if (previous?.status === 'succeeded' || previous?.status === 'unknown') return previous;
  const resume = previous && ['queued', 'running'].includes(previous.status);
  const run = resume ? { id: previous.id } : await engine.createRun(entry.id, testInput, preview);
  const record = resume
    ? previous
    : {
        id: run.id,
        graphHash,
        preview,
        case: suffix,
        status: 'queued',
        startedAt: new Date().toISOString(),
      };
  if (!resume) entry.tests.push(record);
  await save();
  say({ phase: 'run-start', slug: recipe.slug, preview, case: suffix });
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const current = await db.run.findUniqueOrThrow({
      where: { id: run.id },
      select: { status: true, error: true },
    });
    if (['succeeded', 'failed', 'unknown', 'cancelled'].includes(current.status)) {
      record.status = current.status;
      record.executionStatus = current.status;
      record.error = current.error;
      break;
    }
    // Only synthetic suite approvals are accepted, never an unrelated owner's pending run.
    const approvals = await db.nodeExecution.findMany({
      where: { runId: run.id, status: 'waiting', reason: 'approval' },
      select: { id: true },
    });
    if (
      await db.nodeExecution.count({ where: { runId: run.id, status: 'waiting', reason: 'delay' } })
    )
      record.delayObserved = true;
    for (const task of approvals) {
      await engine.approve(run.id, task.id, true);
      record.approvalExercised = true;
    }
    await sleep(800);
  }
  if (!['succeeded', 'failed', 'unknown', 'cancelled'].includes(record.status)) {
    await engine.cancel(run.id);
    record.status = 'cancelled';
    record.error = 'Suite timeout; cancelled without retrying uncertain effects.';
  }
  const nodes = await db.nodeExecution.findMany({
    where: { runId: run.id },
    select: { nodeId: true, scope: true, status: true, error: true, output: true },
  });
  record.steps = nodes.map(({ nodeId, scope, status, error, output }) => ({
    nodeId,
    scope,
    status,
    error,
    simulated: output?.simulated === true,
  }));
  if (record.status === 'succeeded') {
    const checks = [];
    const check = (name, ok) => checks.push({ name, passed: !!ok });
    if (!preview)
      check(
        'No simulated write/send output in real execution',
        nodes.every((node) => node.output?.simulated !== true),
      );
    for (const node of nodes.filter((node) => node.status === 'succeeded')) {
      const rootNode = recipe.definition.nodes.find(
        (definition) => definition.id === node.nodeId && node.scope === 'root',
      );
      if (rootNode?.type.startsWith('ai.'))
        check(
          `Nonempty AI result: ${node.nodeId}`,
          typeof node.output?.text === 'string' && node.output.text.length > 0,
        );
      if (!preview && rootNode?.type === 'notes.create')
        check(
          `Note persisted: ${node.nodeId}`,
          await db.note.count({ where: { id: node.output.id } }),
        );
      if (!preview && rootNode?.type === 'sheets.append')
        check(`Spreadsheet cells written: ${node.nodeId}`, Number(node.output?.updated) > 0);
    }
    if (recipe.slug === 'stock-alert' && !preview) {
      check(
        'Only below-threshold stock alerted Slack',
        nodes.filter((node) => node.nodeId === 'slack' && node.status === 'succeeded').length === 1,
      );
      check(
        'At/above threshold suppressed alerts',
        nodes.filter((node) => node.nodeId === 'quiet' && node.status === 'succeeded').length === 2,
      );
    }
    if (recipe.slug === 'budget-alert' && !preview) {
      check(
        'Over-budget department alerted once',
        nodes.filter((node) => node.nodeId === 'alert' && node.status === 'succeeded').length === 1,
      );
      check(
        'Within-budget department suppressed alert',
        nodes.some((node) => node.nodeId === 'quiet' && node.status === 'succeeded'),
      );
    }
    if (recipe.slug === 'email-sla')
      check(
        'Backdated awaiting-reply demo message matched',
        nodes.find((node) => node.nodeId === 'overdue')?.output?.items?.length === 1,
      );
    if (recipe.slug === 'incident-alert') {
      const sends = nodes.filter(
        (node) =>
          ['slack', 'telegram', 'discord'].includes(node.nodeId) && node.status === 'succeeded',
      );
      check(
        suffix === 'main'
          ? 'Critical incident reached three branches'
          : 'Low-severity event sent no alert',
        sends.length === (suffix === 'main' ? 3 : 0),
      );
    }
    if (!preview && recipe.definition.nodes.some((node) => node.type === 'logic.approval'))
      check(
        'Approval persisted and explicitly accepted in synthetic test',
        record.approvalExercised,
      );
    if (!preview && recipe.slug === 'delay-followup')
      check('Delay survived waiting state before continuation', record.delayObserved);
    record.assertions = checks;
    const failed = checks.filter((check) => !check.passed);
    if (failed.length) {
      record.status = 'verification_failed';
      record.error = failed.map((check) => check.name).join('; ');
    }
  }
  record.finishedAt = new Date().toISOString();
  await save();
  say({
    phase: 'run-finish',
    slug: recipe.slug,
    preview,
    case: suffix,
    status: record.status,
    error: record.error,
    steps: nodes.length,
  });
  return record;
}

async function run() {
  const recipes = buildRecipes(manifest.resources, manifest.tag);
  const chosen = process.env.SUITE_SLUGS?.split(',');
  for (const recipe of recipes.filter((recipe) => !chosen || chosen.includes(recipe.slug))) {
    if (!manifest.workflows[recipe.slug]?.ready) {
      say({ phase: 'pending', slug: recipe.slug, reason: 'Missing test destination' });
      continue;
    }
    if (process.env.SUITE_PREVIEW === '1') await runOne(recipe, true);
    else {
      await runOne(recipe, false);
      for (const variant of recipe.cases || [])
        await runOne(recipe, false, variant.input, variant.name);
    }
    // Pace cloud calls; a quota failure remains visible and is never hidden by another provider.
    if (
      recipe.definition.nodes.some(
        (node) => node.type.startsWith('ai.') || node.type === 'logic.foreach',
      )
    )
      await sleep(5500);
  }
}

async function cancelSuite() {
  for (const entry of Object.values(manifest.workflows))
    for (const test of entry.tests) {
      const run = await db.run.findUnique({ where: { id: test.id } });
      if (run && ['queued', 'running', 'waiting'].includes(run.status)) {
        await engine.cancel(run.id);
        test.status = 'cancelled';
        test.error = 'Cancelled to correct recipe configuration before retesting.';
      }
    }
  await save();
}

async function diagnose() {
  const r = manifest.resources;
  const gmail = google.gmail({ version: 'v1', auth: await connections.google(r.google, 'gmail') });
  for (const q of [
    `subject:NFDEMO-${manifest.tag}-Awaiting`,
    `label:NeuralForgeDemo/${manifest.tag}`,
    `subject:NFDEMO-${manifest.tag}-Awaiting older_than:1d`,
  ]) {
    const result = await gmail.users.messages.list(
      { userId: 'me', q, maxResults: 10, includeSpamTrash: true },
      options,
    );
    say({ phase: 'gmail-query', q, count: result.data.messages?.length ?? 0 });
  }
  const fixture = await gmail.users.messages.get(
    { userId: 'me', id: r.messages.sla, format: 'metadata', metadataHeaders: ['Date', 'Subject'] },
    options,
  );
  say({
    phase: 'fixture-date',
    internalDate: fixture.data.internalDate,
    labels: fixture.data.labelIds,
    headers: fixture.data.payload?.headers,
  });
  for (const [slug, entry] of Object.entries(manifest.workflows)) {
    const latest = entry.tests.at(-1);
    if (!latest) continue;
    const tasks = await db.nodeExecution.findMany({
      where: { runId: latest.id },
      select: { nodeId: true, status: true, error: true, reason: true, output: true },
    });
    say({
      phase: 'diagnose',
      slug,
      tasks: tasks.map((t) => ({
        ...t,
        output: t.output ? JSON.stringify(t.output).slice(0, 600) : null,
      })),
    });
  }
}

async function verifyOutputs() {
  const r = manifest.resources;
  const sheets = google.sheets({
    version: 'v4',
    auth: await connections.google(r.google, 'sheets'),
  });
  await sheets.spreadsheets.values.update(
    {
      spreadsheetId: r.spreadsheet,
      range: 'Audit!A1:D1',
      valueInputOption: 'RAW',
      requestBody: { values: [['Note ID', 'Title', 'Text', '']] },
    },
    options,
  );
  const checks = [];
  const check = (name, passed) => checks.push({ name, passed: !!passed });
  for (const [tab, expected] of [
    ['Leads', ['Demo Buyer', 'buyer@example.com', 'Example Co']],
    ['InvoiceDrafts', ['DEMO-INV-003', 'Example Co']],
    ['Purchases', ['Fictional training handbook', 200]],
  ]) {
    const rows =
      (
        await sheets.spreadsheets.values.get(
          { spreadsheetId: r.spreadsheet, range: `${tab}!A2:F100` },
          options,
        )
      ).data.values ?? [];
    check(
      `${tab}: persisted values match header order`,
      rows.some((row) => expected.every((v, i) => String(row[i]).replace(/\.$/, '') === String(v))),
    );
  }
  const gmail = google.gmail({ version: 'v1', auth: await connections.google(r.google, 'gmail') });
  for (const provider of ['Gmail', 'Outlook']) {
    const found = await gmail.users.messages.list(
      {
        userId: 'me',
        q: `in:anywhere to:${r.selfEmail} subject:"[NF DEMO ${manifest.tag}] ${provider} workflow delivery"`,
        maxResults: 10,
      },
      options,
    );
    let received = false;
    for (const message of found.data.messages ?? []) {
      const metadata = (
        await gmail.users.messages.get({ userId: 'me', id: message.id, format: 'minimal' }, options)
      ).data;
      if (metadata.labelIds?.some((label) => label === 'INBOX' || label === 'SPAM'))
        received = true;
    }
    check(`${provider} self-test email received in destination Inbox/Spam`, received);
  }
  const classifyRun = manifest.workflows['gmail-label'].tests.findLast(
    (test) => !test.preview && test.status === 'succeeded',
  );
  if (classifyRun) {
    const task = await db.nodeExecution.findFirst({
      where: { runId: classifyRun.id, nodeId: 'classify' },
    });
    const labels = (await gmail.users.labels.list({ userId: 'me' }, options)).data.labels ?? [];
    const expected = labels.find((label) => label.name === task?.output?.label);
    const actual = await gmail.users.messages.get(
      { userId: 'me', id: r.messages.lead, format: 'minimal' },
      options,
    );
    check(
      'AI-classified Gmail label persisted on the fixture',
      expected && actual.data.labelIds?.includes(expected.id),
    );
  }
  const calendar = google.calendar({
    version: 'v3',
    auth: await connections.google(r.google, 'calendar'),
  });
  const event = (
    await calendar.events.get({ calendarId: r.calendar, eventId: r.calendarEvent }, options)
  ).data;
  check(
    'Calendar fixture rescheduled by fifteen minutes',
    Date.parse(event.start?.dateTime ?? '') === Date.parse(r.eventStart) + 15 * 60_000,
  );
  let aiSelections = true,
    aiSteps = 0;
  for (const entry of Object.values(manifest.workflows)) {
    const test = entry.tests.findLast(
      (test) => !test.preview && test.case === 'main' && test.status === 'succeeded',
    );
    if (!test) continue;
    const scopes = await db.runScope.findMany({
      where: { runId: test.id },
      select: { key: true, definition: true },
    });
    const nodes = await db.nodeExecution.findMany({
      where: { runId: test.id, status: 'succeeded' },
      select: { scope: true, nodeId: true, output: true },
    });
    for (const task of nodes) {
      const definition = scopes.find((scope) => scope.key === task.scope)?.definition;
      const node = definition?.nodes?.find((node) => node.id === task.nodeId);
      if (!node?.type.startsWith('ai.')) continue;
      aiSteps++;
      const expected = node.config.provider || definition.settings.ai?.provider || 'ollama';
      if (task.output?.provider !== expected) aiSelections = false;
    }
  }
  check(
    `All ${aiSteps} AI executions retained their explicit provider`,
    aiSelections && aiSteps > 0,
  );
  let previewWrites = 0,
    previewSimulation = true;
  for (const entry of Object.values(manifest.workflows)) {
    const test = entry.tests.findLast((test) => test.preview && test.status === 'succeeded');
    if (!test) continue;
    const scopes = await db.runScope.findMany({
      where: { runId: test.id },
      select: { key: true, definition: true },
    });
    const tasks = await db.nodeExecution.findMany({
      where: { runId: test.id, status: 'succeeded' },
      select: { scope: true, nodeId: true, output: true },
    });
    for (const task of tasks) {
      const node = scopes
        .find((scope) => scope.key === task.scope)
        ?.definition?.nodes?.find((node) => node.id === task.nodeId);
      if (catalog.find((definition) => definition.type === node?.type)?.effect === 'write') {
        previewWrites++;
        if (task.output?.simulated !== true) previewSimulation = false;
      }
    }
  }
  check(
    `All ${previewWrites} successful Preview writes/sends were simulated`,
    previewWrites > 0 && previewSimulation,
  );
  const enabled = await db.workflow.count({
    where: { id: { in: Object.values(manifest.workflows).map((w) => w.id) }, enabled: true },
  });
  check('All suite workflows are disabled', enabled === 0);
  manifest.outputVerification = { at: new Date().toISOString(), checks };
  await save();
  say({ phase: 'output-verification', checks });
}

async function verifyWebhook() {
  const entry = manifest.workflows['incident-alert'];
  const workflow = await db.workflow.findUniqueOrThrow({ where: { id: entry.id } });
  const published = await engine.publish(entry.id, workflow.revision);
  if (!published.ok) throw new Error('Webhook test publication failed.');
  try {
    const invoke = async (token) =>
      fetch(`http://127.0.0.1:4301/api/v1/hooks/${entry.id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': `${manifest.tag}-low-severity-ingress`,
        },
        body: JSON.stringify({
          severity: 1,
          reference: 'NF-DEMO-INGRESS',
          message: 'Synthetic low severity: do not alert.',
        }),
        signal: AbortSignal.timeout(10000),
      });
    const rejected = await invoke('invalid-fixture-token');
    const response = await invoke(published.webhookToken);
    if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
    const first = await response.json();
    const again = await invoke(published.webhookToken);
    const second = await again.json();
    let status = 'queued';
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      status = (await db.run.findUniqueOrThrow({ where: { id: first.id } })).status;
      if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(status)) break;
      await sleep(800);
    }
    const sends = await db.nodeExecution.count({
      where: {
        runId: first.id,
        nodeId: { in: ['slack', 'telegram', 'discord'] },
        status: 'succeeded',
      },
    });
    manifest.webhookVerification = {
      at: new Date().toISOString(),
      runId: first.id,
      unauthorizedRejected: rejected.status === 401,
      duplicateDeduplicated: first.id === second.id,
      status,
      noAlerts: sends === 0,
    };
    say({ phase: 'webhook-verification', ...manifest.webhookVerification });
  } finally {
    await db.workflow.update({ where: { id: entry.id }, data: { enabled: false } });
    await save();
  }
}

async function report() {
  const recipes = buildRecipes(manifest.resources, manifest.tag);
  const rows = recipes.map((recipe) => {
    const entry = manifest.workflows[recipe.slug];
    const tests = entry?.tests || [];
    return {
      slug: recipe.slug,
      name: recipe.name,
      source: recipe.source,
      id: entry?.id,
      tests,
      sampleInput: recipe.input,
      url: `http://localhost:4300/w/${workspaceId}?view=builder&id=${entry?.id}`,
      lastRealStatus:
        tests
          .filter(
            (test) =>
              !test.preview &&
              test.case === 'main' &&
              test.graphHash ===
                createHash('sha256').update(JSON.stringify(recipe.definition)).digest('hex'),
          )
          .at(-1)?.status || 'not run',
    };
  });
  const result = {
    generatedAt: new Date().toISOString(),
    workspaceId,
    tag: manifest.tag,
    photoCoverage,
    workflows: rows,
    totals: {
      created: rows.filter((row) => row.id).length,
      succeeded: rows.filter((row) => row.lastRealStatus === 'succeeded').length,
      pending: rows.filter(
        (row) =>
          !['succeeded', 'failed', 'unknown', 'cancelled', 'verification_failed'].includes(
            row.lastRealStatus,
          ),
      ).length,
      failed: rows.filter((row) =>
        ['failed', 'unknown', 'cancelled', 'verification_failed'].includes(row.lastRealStatus),
      ).length,
    },
    outputVerification: manifest.outputVerification,
    webhookVerification: manifest.webhookVerification,
    resources: {
      spreadsheet: `https://docs.google.com/spreadsheets/d/${manifest.resources.spreadsheet}/edit`,
      driveFolder: `https://drive.google.com/drive/folders/${manifest.resources.driveFolder}`,
    },
    boundaries: [
      'Synthetic fixture data only.',
      'Real writes are limited to dedicated demo resources, owner-controlled automation channels and self-addressed test emails.',
      'All workflows remain disabled after these Run now tests.',
      'Run now tests exercise the saved graph through the queue/worker; unattended polling and schedule delivery are separate checks.',
      'Approval nodes were accepted only in these synthetic test runs.',
    ],
  };
  await writeFile(join(folder, 'report.json'), JSON.stringify(result, null, 2));
  const lines = [
    '# Business workflow suite verification',
    '',
    `Created ${result.totals.created}; successful real runs ${result.totals.succeeded}; failed ${result.totals.failed}; pending ${result.totals.pending}.`,
    '',
    ...result.boundaries.map((value) => `- ${value}`),
    '',
    '## Output verification',
    '',
    ...(manifest.outputVerification?.checks ?? []).map(
      (check) => `- ${check.passed ? 'PASS' : 'PENDING/FAIL'}: ${check.name}`,
    ),
    ...(manifest.webhookVerification
      ? [`- Webhook ingress: ${JSON.stringify(manifest.webhookVerification)}`]
      : []),
    '',
    '## Workflows',
    '',
    '| Workflow | Real run | Tests |',
    '| --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| [${row.name}](${row.url}) | ${row.lastRealStatus} | ${row.tests.map((test) => `${test.preview ? 'preview' : 'real'} ${test.case}: ${test.status}`).join('; ')} |`,
    ),
    '',
    '## Sample inputs',
    '',
    'Use these synthetic inputs in the workflow Run now or Preview dialog. For triggers, they simulate the incoming event; they do not verify unattended ingress.',
    '',
    ...rows.flatMap((row) => [
      `### ${row.name}`,
      '',
      '```json',
      JSON.stringify(row.sampleInput, null, 2),
      '```',
      '',
    ]),
    '## Earlier photo coverage',
    '',
    '| Photo workflow | Delivery |',
    '| --- | --- |',
    ...photoCoverage.map((row) => `| ${row.title} | ${row.delivery} |`),
    '',
    '## Demo resources',
    '',
    `- [Business demo spreadsheet](${result.resources.spreadsheet})`,
    `- [Demo knowledge folder](${result.resources.driveFolder})`,
    '',
  ];
  await writeFile(join(folder, 'report.md'), lines.join('\n'));
  say({
    phase: 'report',
    ...result.totals,
    reportDirectory: folder,
    failures: rows
      .filter((row) => row.lastRealStatus !== 'succeeded')
      .map(({ slug, lastRealStatus }) => ({ slug, status: lastRealStatus })),
  });
}

try {
  const user = await db.system.user.findUniqueOrThrow({
    where: { username },
    select: { id: true, status: true },
  });
  if (user.status !== 'active') throw new Error('The account must be active.');
  await db.withWorkspace(
    workspaceId,
    async () => {
      root = await storagePath(db);
      folder = join(root, 'NeuralForgeDemoSuite');
      await mkdir(folder, { recursive: true });
      manifest = await readFile(join(folder, 'manifest.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => ({
          version: 1,
          tag: 'NF-BIZ-20261024',
          today: process.env.SUITE_TODAY || new Date().toISOString().slice(0, 10),
          resources: {},
          workflows: {},
        }));
      if (mode === 'inventory') await inventory();
      else if (mode === 'prepare') await prepare();
      else if (mode === 'create') await create();
      else if (mode === 'run') await run();
      else if (mode === 'report') await report();
      else if (mode === 'diagnose') await diagnose();
      else if (mode === 'cancel') await cancelSuite();
      else if (mode === 'verify') await verifyOutputs();
      else if (mode === 'webhook') await verifyWebhook();
      else throw new Error('Unknown suite phase.');
    },
    { userId: user.id },
  );
} catch (error) {
  say({ phase: 'error', message: error.message });
  process.exitCode = 1;
} finally {
  await ai.onModuleDestroy();
  await db.$disconnect();
}
