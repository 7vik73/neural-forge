import { test, expect, type Page } from '@playwright/test';
import { seedBrowserAccount, headers } from './fixtures';
let fixture: Awaited<ReturnType<typeof seedBrowserAccount>>;
test.beforeAll(async () => {
  fixture = await seedBrowserAccount();
});
test.afterAll(async () => {
  await fixture?.cleanup();
});
const workspaceId = (page: Page) => new URL(page.url()).pathname.split('/')[2]!;
async function createWorkspace(page: Page, name: string) {
  await page.getByRole('button', { name: 'Switch workspace' }).click();
  await page.getByLabel('New workspace name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText(name);
  return workspaceId(page);
}
async function note(page: Page, title: string) {
  await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  await page.getByLabel('Note title').fill(title);
  await page.getByLabel('Note content').fill(`Private content: ${title}`);
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}
test('signup, two private workspaces per user, switching, isolation, trash and restore', async ({
  browser,
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(fixture.user.username);
  await page.getByLabel('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage accounts', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Manage accounts', exact: true }).click();
  const first = await browser.newContext(),
    second = await browser.newContext();
  try {
    async function invite(label: string, context: typeof first) {
      const person = await context.newPage();
      await person.goto('/signup');
      await expect(person.getByRole('heading', { name: 'Create your account.' })).toBeVisible();
      await expect(person.getByLabel('Timezone', { exact: true })).toHaveCount(0);
      await expect(person.getByLabel('Display name', { exact: true })).toHaveCount(0);
      await person.getByLabel('Username', { exact: true }).fill(`${fixture.prefix}_${label}`);
      await person.getByLabel('Password', { exact: true }).fill(fixture.password);
      await person.getByRole('button', { name: 'Create account', exact: true }).click();
      await expect(person.getByRole('button', { name: 'Switch workspace' })).toContainText(
        'Personal',
      );
      return person;
    }
    const alice = await invite('alice', first);
    const alicePersonal = workspaceId(alice);
    const research = await createWorkspace(alice, 'Research');
    await note(alice, 'Research-only note');
    const simple = {
      schemaVersion: 1,
      settings: { timezone: 'UTC', maxItems: 1000 },
      nodes: [
        { id: 'start', type: 'trigger.manual', version: 1, label: 'Start', config: {}, inputs: {} },
      ],
      edges: [],
    };
    const flow = await (
      await alice.request.post(`/api/v1/workspaces/${research}/workflows`, {
        headers,
        data: { name: 'Research automation', definition: simple },
      })
    ).json();
    expect(
      (
        await alice.request.post(`/api/v1/workspaces/${research}/workflows/${flow.id}/enable`, {
          headers,
          data: { revision: 0 },
        })
      ).ok(),
    ).toBeTruthy();
    await alice.getByRole('button', { name: 'Switch workspace' }).click();
    await alice.getByRole('button', { name: 'Open Personal', exact: true }).click();
    await expect(alice).toHaveURL(new RegExp(`/w/${alicePersonal}`));
    await note(alice, 'Personal-only note');
    await expect(
      alice.getByRole('heading', { name: 'Research-only note', exact: true }),
    ).toHaveCount(0);
    const bob = await invite('bob', second);
    const bobPersonal = workspaceId(bob);
    const business = await createWorkspace(bob, 'Business');
    await note(bob, 'Bob-only note');
    for (const url of [
      `/api/v1/workspaces/${research}/notes`,
      `/api/v1/workspaces/${alicePersonal}/workflows`,
    ])
      expect((await bob.request.get(url, { headers })).status()).toBe(404);
    const aliceConnection = await alice.request.post(
      `/api/v1/workspaces/${alicePersonal}/connections`,
      {
        headers,
        data: { name: 'Alice API', kind: 'http', secret: { token: 'synthetic-browser-token' } },
      },
    );
    expect(aliceConnection.ok()).toBeTruthy();
    expect(
      await (
        await alice.request.get(`/api/v1/workspaces/${research}/connections`, { headers })
      ).json(),
    ).toEqual([]);
    expect(
      await (
        await bob.request.get(`/api/v1/workspaces/${business}/connections`, { headers })
      ).json(),
    ).toEqual([]);
    // Separate tabs retain their own workspace URL and data.
    const researchTab = await first.newPage();
    await researchTab.goto(`/w/${research}?view=notes`);
    await expect(
      researchTab.getByRole('heading', { name: 'Research-only note', exact: true }),
    ).toBeVisible();
    await expect(
      alice.getByRole('heading', { name: 'Personal-only note', exact: true }),
    ).toBeVisible();
    await researchTab.close();
    // Save the old workspace's draft before switching to another workspace.
    const draft = await (
      await alice.request.post(`/api/v1/workspaces/${alicePersonal}/workflows`, {
        headers,
        data: { name: 'Before save', definition: simple },
      })
    ).json();
    await alice.goto(`/w/${alicePersonal}?view=builder&id=${draft.id}`);
    await alice.getByLabel('Workflow name').fill('Saved before switching');
    await alice.getByRole('button', { name: 'Switch workspace' }).click();
    await alice.getByRole('button', { name: 'Open Research', exact: true }).click();
    await expect(alice).toHaveURL(new RegExp(`/w/${research}`));
    expect(
      (
        await (
          await alice.request.get(`/api/v1/workspaces/${alicePersonal}/workflows/${draft.id}`, {
            headers,
          })
        ).json()
      ).name,
    ).toBe('Saved before switching');
    // Switch back, then trash and restore the other workspace.
    await alice.getByRole('button', { name: 'Switch workspace' }).click();
    await alice.getByRole('button', { name: 'Open Personal', exact: true }).click();
    await expect(alice).toHaveURL(new RegExp(`/w/${alicePersonal}`));
    await alice.getByRole('button', { name: 'Switch workspace' }).click();
    await alice.getByRole('button', { name: 'Trash Research', exact: true }).click();
    await alice.getByRole('button', { name: 'Confirm move to trash', exact: true }).click();
    await expect(
      alice.getByRole('button', { name: 'Restore Research', exact: true }),
    ).toBeVisible();
    expect(
      (await alice.request.get(`/api/v1/workspaces/${research}/workflows`, { headers })).status(),
    ).toBe(404);
    await alice.screenshot({ path: '.local/workspaces-trash.png', fullPage: true });
    await alice.getByRole('button', { name: 'Restore Research', exact: true }).click();
    await expect(alice.getByRole('button', { name: 'Open Research', exact: true })).toBeVisible();
    expect(
      (
        await (
          await alice.request.get(`/api/v1/workspaces/${research}/workflows/${flow.id}`, {
            headers,
          })
        ).json()
      ).enabled,
    ).toBe(false);
    await alice.screenshot({ path: '.local/workspaces-switcher.png', fullPage: true });
    expect(
      (await (await bob.request.get('/api/v1/workspaces', { headers })).json())
        .map((w: any) => w.id)
        .sort(),
    ).toEqual([bobPersonal, business].sort());
    await page.screenshot({ path: '.local/accounts-administration.png', fullPage: true });
  } finally {
    await first.close();
    await second.close();
  }
});
