import { test, expect } from '@playwright/test';
import { seedBrowserAccount, headers } from './fixtures';
let fixture: Awaited<ReturnType<typeof seedBrowserAccount>>, auth: any;
test.beforeAll(async ({ request }) => {
  fixture = await seedBrowserAccount();
  auth = await fixture.login(request);
});
test.beforeEach(async ({ context }) => context.addCookies(auth.cookies));
test.afterAll(async () => fixture?.cleanup());
const graph = {
  schemaVersion: 1,
  settings: { timezone: 'UTC', maxItems: 1000 },
  nodes: [
    { id: 'start', type: 'trigger.manual', version: 1, label: 'Start', config: {}, inputs: {} },
    {
      id: 'save',
      type: 'notes.create',
      version: 1,
      label: 'Save demo note',
      config: {},
      inputs: {
        title: { kind: 'constant', value: 'Shared workflow result' },
        text: { kind: 'constant', value: 'Synthetic demonstration data.' },
      },
    },
  ],
  edges: [{ id: 'e', source: 'start', target: 'save', sourcePort: 'out', targetPort: 'in' }],
};
test('login and signup have only username and password, with links between them', async ({
  page,
}) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await page.screenshot({ path: '.local/auth-login.png', fullPage: true });
  await page.getByRole('link', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByLabel('Timezone', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Display name', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Setup or invitation token', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: '.local/auth-signup.png', fullPage: true });
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});
test('owner shares Sales, editor connects and runs workflows, viewer cannot mutate, removal revokes access', async ({
  page,
  browser,
}) => {
  const sales = await (
    await page.request.post('/api/v1/workspaces', { headers, data: { name: 'Sales' } })
  ).json();
  const marketing = await (
    await page.request.post('/api/v1/workspaces', { headers, data: { name: 'Marketing' } })
  ).json();
  const context = await browser.newContext();
  try {
    const member = await context.newPage();
    await member.goto('/signup');
    await member.getByLabel('Username', { exact: true }).fill(`${fixture.prefix}_member`);
    await member.getByLabel('Password', { exact: true }).fill(fixture.password);
    await member.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(member.getByRole('button', { name: 'Switch workspace' })).toBeVisible();
    const me = await (await member.request.get('/api/v1/auth/me', { headers })).json();
    await page.goto(`/w/${sales.id}`);
    await page.getByRole('button', { name: 'Switch workspace' }).click();
    await page
      .locator('.account-row')
      .filter({ has: page.getByRole('button', { name: 'Open Sales', exact: true }) })
      .getByRole('button', { name: 'Share', exact: true })
      .click();
    const sharing = page.getByRole('dialog', { name: 'Share Sales', exact: true });
    await sharing.getByLabel('Member username').fill(me.username);
    await sharing.getByLabel('Role', { exact: true }).selectOption('editor');
    await sharing.getByRole('button', { name: 'Add member', exact: true }).click();
    await expect(sharing.getByText(me.username, { exact: true })).toBeVisible();
    await page.screenshot({ path: '.local/workspace-sharing.png', fullPage: true });
    await sharing.getByRole('button', { name: 'Close dialog' }).click();
    await page
      .getByRole('dialog', { name: 'Your workspaces' })
      .getByRole('button', { name: 'Close dialog' })
      .click();
    await member.reload();
    await member.getByRole('button', { name: 'Switch workspace' }).click();
    await expect(member.getByText('Shared with me · editor', { exact: true })).toBeVisible();
    await member.getByRole('button', { name: 'Open Sales', exact: true }).click();
    await expect(member).toHaveURL(new RegExp(`/w/${sales.id}`));
    expect(
      (
        await member.request.get(`/api/v1/workspaces/${marketing.id}/workflows`, { headers })
      ).status(),
    ).toBe(404);
    const connection = await member.request.post(`/api/v1/workspaces/${sales.id}/connections`, {
      headers,
      data: { name: 'Sales demo API', kind: 'http', secret: { token: 'synthetic-demo-token' } },
    });
    expect(connection.ok()).toBe(true);
    const c = await connection.json();
    await member.request.post(`/api/v1/workspaces/${sales.id}/connections/${c.id}/test`, {
      headers,
    });
    for (const name of ['Lead capture', 'Daily sales summary'])
      expect(
        (
          await member.request.post(`/api/v1/workspaces/${sales.id}/workflows`, {
            headers,
            data: { name, definition: graph },
          })
        ).ok(),
      ).toBe(true);
    const workflows = await (
      await member.request.get(`/api/v1/workspaces/${sales.id}/workflows`, { headers })
    ).json();
    expect(workflows).toHaveLength(2);
    const run = async (preview: boolean) => {
      const r = await (
        await member.request.post(
          `/api/v1/workspaces/${sales.id}/workflows/${workflows[0].id}/runs`,
          { headers, data: { input: {}, preview } },
        )
      ).json();
      expect(r.id).toBeTruthy();
      await expect
        .poll(
          async () =>
            (
              await (
                await member.request.get(`/api/v1/workspaces/${sales.id}/runs/${r.id}`, { headers })
              ).json()
            ).status,
          { timeout: 30000 },
        )
        .toBe('succeeded');
    };
    await run(true);
    expect(
      await (await member.request.get(`/api/v1/workspaces/${sales.id}/notes`, { headers })).json(),
    ).toHaveLength(0);
    await run(false);
    expect(
      await (await member.request.get(`/api/v1/workspaces/${sales.id}/notes`, { headers })).json(),
    ).toHaveLength(1);
    await member.goto(`/w/${sales.id}?view=connections`);
    await expect(
      member
        .locator('.app-card')
        .filter({ has: member.getByRole('heading', { name: 'HTTP API', exact: true }) })
        .getByText('Connected', { exact: true }),
    ).toBeVisible();
    await page.request.patch(`/api/v1/workspaces/${sales.id}/members/${me.id}`, {
      headers,
      data: { role: 'viewer' },
    });
    await member.goto(`/w/${sales.id}?view=builder&id=${workflows[0].id}`);
    await expect(member.getByText(/Viewer access ·/)).toBeVisible();
    expect(
      (
        await member.request.post(`/api/v1/workspaces/${sales.id}/notes`, {
          headers,
          data: { title: 'Denied', text: 'Denied' },
        })
      ).status(),
    ).toBe(403);
    await page.request.delete(`/api/v1/workspaces/${sales.id}/members/${me.id}`, { headers });
    expect(
      (await member.request.get(`/api/v1/workspaces/${sales.id}/workflows`, { headers })).status(),
    ).toBe(404);
  } finally {
    await context.close();
  }
});
test('app catalog is searchable and workflow AI/timezone choices are editable', async ({
  page,
}) => {
  await page.goto(`/w/${fixture.workspace.id}?view=connections`);
  await page.getByLabel('Search apps').fill('Slack');
  await expect(page.getByRole('heading', { name: 'Slack', exact: true })).toBeVisible();
  await expect(page.getByText('Not connected', { exact: true })).toBeVisible();
  await page.getByLabel('Search apps').fill('');
  await page.screenshot({ path: '.local/apps-catalog.png', fullPage: true });
  const draft = await (
    await page.request.post(`/api/v1/workspaces/${fixture.workspace.id}/workflows`, {
      headers,
      data: { name: 'Workflow AI preferences', definition: graph },
    })
  ).json();
  await page.goto(`/w/${fixture.workspace.id}?view=builder&id=${draft.id}`);
  await page.getByText('Workflow settings · timezone and AI', { exact: true }).click();
  await page.getByLabel('AI provider', { exact: true }).selectOption('gemini');
  await page.getByLabel('Data handling', { exact: true }).selectOption('public-demo');
  await page.getByLabel('Workflow timezone', { exact: true }).fill('Asia/Kolkata');
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(
              `/api/v1/workspaces/${fixture.workspace.id}/workflows/${draft.id}`,
              { headers },
            )
          ).json()
        ).draft.settings.ai?.provider,
    )
    .toBe('gemini');
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(
              `/api/v1/workspaces/${fixture.workspace.id}/workflows/${draft.id}`,
              { headers },
            )
          ).json()
        ).draft.settings.timezone,
    )
    .toBe('Asia/Kolkata');
  await page.screenshot({ path: '.local/workflow-ai-settings.png', fullPage: true });
});
