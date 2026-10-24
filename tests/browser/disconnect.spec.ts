import { test, expect } from '@playwright/test';
import { seedBrowserAccount } from './fixtures';
let fixture: Awaited<ReturnType<typeof seedBrowserAccount>>, auth: any;
test.beforeAll(async ({ request }) => {
  fixture = await seedBrowserAccount();
  auth = await fixture.login(request);
  const { encrypt } = await import('../../apps/backend/dist/security.js');
  await fixture.db.withWorkspace(fixture.workspace.id, () =>
    fixture.db.connection.create({
      data: {
        name: 'Fixture Google account',
        kind: 'google',
        status: 'connected',
        secret: encrypt({
          clientId: 'synthetic',
          clientSecret: 'synthetic',
          apps: 'gmail,calendar,sheets,drive',
        }),
      },
    }),
  );
});
test.afterAll(async () => fixture?.cleanup());
test('disconnects Gmail alone, keeps Calendar connected, then disconnects the whole account', async ({
  page,
  context,
}) => {
  await context.addCookies(auth.cookies);
  await page.goto(`/w/${fixture.workspace.id}?view=connections`);
  const card = (name: string) =>
    page.locator('.app-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(card('Gmail').getByText('Connected', { exact: true })).toBeVisible();
  await expect(
    card('Gmail').getByRole('button', { name: 'Connect Gmail', exact: true }),
  ).toHaveCount(0);
  page.on('dialog', (dialog) => dialog.accept());
  await card('Gmail')
    .getByRole('button', { name: 'Disconnect Gmail in this workspace', exact: true })
    .click();
  await expect(card('Gmail').getByText('Not connected', { exact: true })).toBeVisible();
  await expect(
    card('Gmail').getByRole('button', { name: 'Connect Gmail', exact: true }),
  ).toBeVisible();
  await expect(card('Google Calendar').getByText('Connected', { exact: true })).toBeVisible();
  await page.reload();
  await expect(card('Gmail').getByText('Not connected', { exact: true })).toBeVisible();
  await expect(card('Google Calendar').getByText('Connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect Google account', exact: true }).click();
  await expect(card('Google Calendar').getByText('Not connected', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Fixture Google account', exact: true }),
  ).toHaveCount(0);
});
