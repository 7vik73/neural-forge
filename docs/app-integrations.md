# App setup and supported actions

The catalog distinguishes implemented actions from configured accounts. Connections are scoped to a workspace; editors can use them, viewers see only redacted status. Preview simulates write/send actions. External writes whose confirmation is lost become **Outcome unknown** and require inspection before retry.

| App                | Credentials / setup                                                                | Supported actions                                                                             |
| ------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Gemini             | Own API key, model; public/demo data policy                                        | Generate, summarize, rewrite, classify, extract, draft workflows                              |
| Ollama             | Optional native service and downloaded model                                       | Same AI operations locally; private/offline input                                             |
| OpenAI             | Own API key/model; public/demo data policy in this release                         | Same AI operations through Responses API                                                      |
| Gmail              | Google OAuth; select `gmail`                                                       | Search/read mail, labels, drafts, send, new-mail trigger                                      |
| Google Sheets      | Google OAuth; select `sheets`                                                      | Read, append and update ranges/rows; tabs/column selectors                                    |
| Google Drive       | Google OAuth; select `drive`                                                       | Find/list files, read/create/update supported UTF-8 text files                                |
| Google Calendar    | Google OAuth; select `calendar`                                                    | List/create/update events, new-event trigger, calendar selector                               |
| Telegram           | Separate bot token; start a chat with the bot                                      | Send messages, new-message trigger, chat discovery                                            |
| Slack              | Internal app bot token with channels/history/write scopes; join nominated channels | Channel selector, read/send messages, new-message trigger                                     |
| Discord            | Channel webhook URL                                                                | Send text messages; automatic mentions disabled                                               |
| Notion             | Internal integration token; share nominated pages/data sources with it             | Search/read pages, create pages, append page content, read/create/update structured records   |
| Outlook            | Microsoft OAuth; select `outlook`                                                  | Find/read mail, drafts, send, new-mail trigger                                                |
| Excel 365          | Microsoft work/school OAuth; select `excel`; workbook with a table                 | Workbook/table selectors, read/append/update table rows                                       |
| MySQL / PostgreSQL | Own host, port, database, user and password                                        | Table selector; bounded structured read/filter, single-record insert, filtered bounded update |
| SMTP / IMAP        | Provider-permitted credentials; app password where applicable                      | SMTP send; IMAP new mail                                                                      |
| HTTP API           | Optional bearer token and nominated destination                                    | Guarded HTTP requests                                                                         |

Connected app cards show their status and **Disconnect in this workspace**. Connect returns after local disconnection. Google and Microsoft apps can be disconnected individually; other apps keep using the shared account. Their account card also offers **Disconnect Google account** or **Disconnect Microsoft account**, which removes the entire saved workspace connection. Other providers have a whole-connection disconnect action.

Disconnection pauses enabled workflows using that app/account, including nested list bodies and inherited AI settings, and requests cancellation of affected active runs. Completed external effects cannot be reversed. The runtime, graph validation and resource selectors enforce local app disconnection. Reconnecting does not automatically enable paused workflows. App connection changes are workspace-scoped and require editor/owner access.

Local disconnection does not revoke the provider's stored grant. The Google permissions link explains that revoking project access in Google may also disconnect that Google account in other workspaces. Installation OAuth developer credentials are retained. The add-app picker excludes already configured shared providers; disabled apps reconnect through their own cards. Reconnect for expired authorization remains available on the account card. Catalog statuses refresh after changes.

## OAuth application setup

An installation administrator saves Google/Microsoft client ID and secret once in Installation settings. Tokens belong to workspace connections. Shared application secrets remain installation references and are resolved only transiently by the server; workspace backups do not include them. Legacy connections retain their own developer credentials until reconnected.

Installation settings shows **Saved securely**, a masked-secret indicator and the last-saved time for each configured provider, including after a reload. Stored values are never returned to the browser. Use **Replace credentials** to enter both new values; cancelling leaves the saved credentials intact. Saved developer credentials still require a separate workspace account authorization.

For Google, enable the selected app APIs, configure consent/test users, and register a **Web application** callback at `http://localhost:4300/api/v1/connections/google/callback`. The Google connection’s comma-separated `apps` field chooses Gmail, Sheets, Drive and/or Calendar scopes. Google testing/verification restrictions still apply. Sheets-only connection testing does not require Drive permissions.

For Microsoft, register a confidential Web application and callback `http://localhost:4300/api/v1/connections/microsoft/callback`. Outlook needs delegated mail permissions; Excel needs delegated file access and a work/school account. Consent restrictions may require your Microsoft tenant administrator. The app refreshes tokens server-side and requests reconnection when access expires.

Outlook-only connections default to Microsoft's `common` authority, supporting personal and work/school accounts when the registered application allows them. Connections including Excel default to `organizations`; explicitly configured tenants remain unchanged. Authorization and token exchange always use the same selected authority.

## Limits and behavior

- A Gemini API key does not authorize Google Workspace or other services. Free Gemini quotas vary by project/model; consult AI Studio. No provider fallback or automatic billing changes occur.
- Drive text files are limited to UTF-8 `.txt`, Markdown, JSON or CSV-compatible content under 20 MB. PDF/OCR/media extraction is deferred.
- Notion update appends page content; structured record update changes the selected properties. API version is pinned to `2025-09-03` with data source IDs.
- Excel operations target tables in `.xlsx` workbooks. Updates require a non-negative row index and exactly one row of values; writes are limited to 1,000 rows per operation.
- Database operations have no arbitrary SQL or DDL. Reads and updates are capped at 1,000 rows. Updates require filters; identifiers are allowlisted and values parameterized. PostgreSQL partitioned updates use physical table identity as well as row location.
- Database TLS defaults to enabled with certificate hostname verification. Use the DNS hostname printed by your database provider. An IP address requires explicitly disabling TLS for a trusted local test database. Installation database/Redis/API/web/Ollama destinations and equivalent aliases are prohibited.
- Slack, Calendar and Outlook polling establish a baseline and persist cursors. Provider limits are honored; large pending batches produce actionable errors instead of silently dropping work.
- Optional commercial apps, WhatsApp vendors, public marketplace distribution and media-generation actions are deferred.

## Opt-in live verification

Automated provider-contract tests run with synthetic responses. Real-account verification is intentionally off by default. To run it, create a private JSON fixture file outside source control and nominate separate test accounts and destinations. Example structure:

```json
{
  "slack": {
    "secret": { "token": "YOUR_TEST_BOT_TOKEN" },
    "actions": [
      { "type": "slack.read", "config": { "channelId": "YOUR_TEST_CHANNEL" }, "input": {} },
      {
        "type": "slack.send",
        "allowWrites": true,
        "config": { "channelId": "YOUR_TEST_CHANNEL" },
        "input": { "text": "Synthetic integration test." }
      }
    ]
  }
}
```

Run only the configured provider:

```sh
pnpm build:packages
pnpm --filter @forge/backend build
RUN_PROVIDER_TESTS=1 LIVE_PROVIDER_FIXTURES=/absolute/private/fixtures.json pnpm exec vitest run --config vitest.integration.config.ts -t 'opt-in real slack'
```

The integration database must end in `_test`. Google/Microsoft fixtures require nominated OAuth developer credentials and authorized test tokens. Cloud-AI fixtures must contain only synthetic data. Writes require `allowWrites: true` on each nominated action and may leave test objects/messages in that external service. Local fixture accounts and database records are cleaned up; external effects are not reversed automatically.

Do not mark an app’s live operations verified until the nominated account test has passed. No provider accounts are automatically connected by installation or by the browser tests.
