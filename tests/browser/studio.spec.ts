import { test, expect, type APIRequestContext } from '@playwright/test';
import { seedBrowserAccount, headers as baseHeaders } from './fixtures';
const headers: Record<string, string> = { ...baseHeaders };
let fixture: Awaited<ReturnType<typeof seedBrowserAccount>>;
let auth: Awaited<ReturnType<APIRequestContext['storageState']>>;
const created: string[] = [];
const noteIds: string[] = [];
const scoped = (path: string) => `/api/v1/workspaces/${fixture.workspace.id}/${path}`;
test.beforeAll(async ({ request }) => {
  fixture = await seedBrowserAccount();
  auth = await fixture.login(request);
  headers.Cookie = auth.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
});
test.beforeEach(async ({ context }) => {
  await context.addCookies(auth.cookies);
});
test.afterAll(async () => {
  await fixture?.cleanup();
});
test('overview explains creation routes and opens the template gallery', async ({ page }) => {
  await page.goto(`/w/${fixture.workspace.id}`);
  await expect(page.getByRole('heading', { name: 'A little less busywork.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Describe a workflow' })).toBeVisible();
  await expect(
    page.locator('.template-card').filter({ hasText: 'Turn a long text into a clear note' }),
  ).toBeVisible();
  await page.screenshot({ path: '.local/studio-overview.png', fullPage: true });
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Useful workflows, ready to go.' })).toBeVisible();
  await page.getByLabel('Search templates').fill('clear note');
  await page.getByRole('button').filter({ hasText: 'Turn a long text into a clear note' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Use this template' }).click();
  await expect(page.getByLabel('Workflow name')).toBeVisible();
  created.push(new URL(page.url()).searchParams.get('id')!);
  await expect(page.getByRole('button', { name: 'Guided steps' })).toBeVisible();
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.screenshot({ path: '.local/studio-canvas.png', fullPage: true });
});
test('notes can be created and read using ordinary form fields', async ({ page, request }) => {
  await page.goto(`/w/${fixture.workspace.id}?view=notes`);
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  const title = `Browser test ${Date.now()}`;
  await page.getByLabel('Note title').fill(title);
  await page.getByLabel('Note content').fill('A simple note, with no JSON to edit.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  const notes = await (await request.get(scoped('notes'), { headers })).json();
  noteIds.push(notes.find((n: any) => n.title === title).id);
});
test('AI proposal remains editable and preview simulates writes', async ({ page, request }) => {
  const templates = await (await request.get('/api/v1/templates', { headers })).json();
  const definition = structuredClone(templates[0].definition);
  definition.nodes[1].type = 'data.text';
  definition.nodes[1].label = 'Format the text';
  definition.nodes[1].config = { operation: 'upper' };
  await page.route('**/api/v1/workspaces/*/ai/generate', (route) =>
    route.fulfill({
      json: {
        name: 'Browser test proposal',
        explanation: 'A controlled proposal fixture for UI testing.',
        questions: [],
        definition,
      },
    }),
  );
  await page.goto(`/w/${fixture.workspace.id}`);
  await page.getByRole('button', { name: 'Describe a workflow', exact: true }).click();
  await page
    .getByLabel('What would you like to automate?')
    .fill('Format my text and save it as a note.');
  await page.getByRole('button', { name: 'Create a proposal' }).click();
  await expect(page.getByRole('heading', { name: 'Browser test proposal' })).toBeVisible();
  await page.getByRole('button', { name: 'Open editable draft' }).click();
  await expect(page.getByLabel('Workflow name')).toHaveValue('Browser test proposal');
  created.push(new URL(page.url()).searchParams.get('id')!);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByLabel('Text to process').fill('This is a browser test.');
  await page.getByRole('button', { name: 'Start preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Every step, in the open.' })).toBeVisible();
  await page.getByRole('button').filter({ hasText: 'Browser test proposal' }).first().click();
  await expect(page.getByText('Simulated — no changes made')).toBeVisible({ timeout: 30_000 });
});
test('protected data and cross-origin writes are rejected', async ({ playwright }) => {
  const anonymous = await playwright.request.newContext({
    baseURL: process.env.TEST_APP_URL ?? 'http://localhost:4300',
  });
  expect((await anonymous.get(scoped('notes'))).status()).toBe(401);
  const forbidden = await anonymous.post(scoped('notes'), {
    headers: { Origin: 'https://untrusted.example', 'X-Forge-Request': '1' },
    data: { title: 'No', text: 'No' },
  });
  expect(forbidden.status()).toBe(403);
  await anonymous.dispose();
});

test('starter workflow runs through the real worker and native Ollama', async ({
  page,
  request,
}) => {
  test.skip(process.env.RUN_OLLAMA_TESTS !== '1', 'Opt in to real local-model browser execution.');
  const templates = await (await request.get('/api/v1/templates', { headers })).json();
  const template = templates.find((t: any) => t.id === 'text-note');
  const workflow = await (
    await request.post(scoped('workflows'), {
      headers,
      data: { name: 'Browser real local summary', definition: template.definition },
    })
  ).json();
  created.push(workflow.id);
  const runResponse = await request.post(scoped(`workflows/${workflow.id}/runs`), {
    headers,
    data: {
      preview: false,
      input: {
        text: 'The project meeting is on Monday. Priya will prepare the budget. Arun will test the signup form.',
      },
    },
  });
  const run = await runResponse.json();
  expect(run.id).toBeTruthy();
  await expect
    .poll(
      async () => (await (await request.get(scoped(`runs/${run.id}`), { headers })).json()).status,
      { timeout: 120_000, intervals: [1000] },
    )
    .toBe('succeeded');
  const result = await (await request.get(scoped(`runs/${run.id}`), { headers })).json();
  const saved = result.nodes.find((n: any) => n.nodeId === 'save');
  expect(saved.output.text.toLowerCase()).toContain('monday');
  expect(saved.output.text).not.toMatch(/<\/?think>/i);
  expect(saved.output.text.length).toBeLessThan(600);
  noteIds.push(saved.output.id);
  await page.goto(`/w/${fixture.workspace.id}?view=runs`);
  await page.getByRole('button').filter({ hasText: 'Browser real local summary' }).first().click();
  await expect(page.getByText('succeeded', { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: '.local/studio-real-run.png', fullPage: true });
});
