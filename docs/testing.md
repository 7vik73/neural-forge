# Verification and release gates

## Automated checks

```sh
pnpm typecheck
pnpm test
pnpm build
node scripts/test-database.mjs
RUN_OLLAMA_TESTS=1 pnpm test:integration
pnpm exec playwright install chromium
RUN_OLLAMA_TESTS=1 pnpm test:e2e
```

Integration tests use the dedicated `forge_test` database by default and reject names without the `_test` suffix. Apply all migrations first. Account and engine suites use separate temporary managed storage roots. The migration suite creates a uniquely named test database, seeds the previous owner schema, applies the account migrations, verifies password/ID/history preservation and resumable file copies, then drops only its generated database. It requires the local test PostgreSQL role’s database-creation privilege.

Browser tests run against the local app at port 4300. They seed randomly named temporary administrators using local operator database access, register temporary accounts through the actual UI, and remove only their fixture accounts and managed directories afterward. They neither need nor reset an existing user’s password. Use a development/test installation. The AI-dialog test uses a controlled draft proposal; `RUN_OLLAMA_TESTS=1` also runs the real starter through BullMQ and native `qwen3:4b`.

## Verified during implementation

The completed suites contain **88 unit/interface/provider-contract tests, 44 PostgreSQL/account/migration integration tests, and 9 Chromium browser tests**. The integration suite passed all 44 with native Ollama enabled. All nine Chromium tests passed, including the real worker/Ollama starter, simple signup/login, shared workspace roles, multiple workflows and app/AI settings. Thirteen opt-in live-provider tests were skipped because no nominated external test credentials were supplied.

| Area              | Coverage                                                                                                                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine            | Duplicate delivery, branches/joins, bounded lists, delays, approvals, cancellation, unknown outcomes, dispatch reconstruction, preview and schedule versioning                                                                                                  |
| API isolation     | Other accounts, an administrator accessing another user’s content, same-account workspace boundaries, known IDs, forged nested connections, mandatory context, composite foreign keys                                                                           |
| Worker isolation  | Persisted target resolution, forged queue workspace rejection, recovery of dispatches in two workspaces                                                                                                                                                         |
| Lifecycle         | Suspension, account deletion/reactivation, workspace trash/disabled restoration, password-confirmed permanent purge, expired-trash cleanup                                                                                                                      |
| Authentication    | Concurrent first-registration administrator election, simple registration, hashed single-use recovery tokens, expiration/revocation, last active administrator, controlled concurrent old-password login/recovery, password session replacement, SSE revocation |
| Files and backups | Separate directories, traversal rejection, encrypted private backups with fresh identities, credential re-encryption, no account state, disabled workflows, history-only imported runs                                                                          |
| Legacy migration  | Original password hash, username-completion requirement, published version/record IDs, settings, session invalidation, verified file copy preserving source                                                                                                     |
| Browser           | Signup/login → private/shared workspaces → owner/editor/viewer → independent workflows/connections → two tabs → pending edit save on switch → trash → restore with workflows disabled                                                                           |
| Local AI          | Real summary and description-to-workflow against native `qwen3:4b`; no cloud fallback                                                                                                                                                                           |

Production builds and workspace typechecking pass. Native ARM64 Docker backend/web images and all-container operation on this macOS computer are verified, using Docker Desktop’s private host gateway to native Ollama. No real external account credentials or recipients were used.

A full encrypted backup was taken before changing the installed schema. The local application was stopped for migrations. The updated full installation backup v2 command also completed; its archive was decrypted and checked for the account schema, managed-file archive and protected installation key, then services returned healthy. Verification records are temporary and are removed after tests; the running app is left ready for first-time administrator signup if there were no real accounts before testing.

## Remaining release acceptance

- Validate launchers on clean Windows, Linux and macOS machines; exercise supported host/gateway networking and CPU-only inference.
- Run the multi-architecture image workflow and verify AMD64 runtime behavior.
- Run opt-in live tests for every provider in [app integrations](app-integrations.md), including Gemini/OpenAI and external databases; verify authorization, expiration, selectors and nominated real writes.
- Exercise sleep/wake scheduling and daylight-saving transitions on target systems.
- Run the five-person beginner trial; at least four participants must finish the starter without developer help.
- Restore a full installation archive on a second physical computer and validate storage/model mappings.

These physical-system, provider-account and human tests cannot be established by local automated checks. The CI check workflow runs builds, typechecks and local integration tests; the manual images workflow creates AMD64/ARM64 artifacts without registry publication.

## Architecture review

The requested [Improve Codebase Architecture](https://github.com/mattpocock/skills/blob/main/skills/engineering/improve-codebase-architecture/SKILL.md) process included an independent read-only review. The original [engine review](architecture-review.html) remains available; the [private workspace review](architecture-workspaces.html) describes the new interfaces and resolved findings. This release also received independent reviews of membership authorization, AI adapters, connector transport, SQL boundaries and backup secrecy. Confirmed issues were corrected: installation OAuth secrets remain references in workspace backups, PostgreSQL updates identify partition rows correctly, database TLS preserves hostname verification, IPv4-mapped addresses cannot bypass protected-service checks, AI overrides use one resolver, and ambiguous write/response failures remain visible. Empty Outlook send responses and Sheets-only authorization were covered by regressions. No remaining concrete blocker was found in the targeted follow-up review. Decisions are in `docs/adr`, and domain terms are in `GLOSSARY.md`.

## Expanded-provider checks

Controlled contract tests cover every newly listed action, SQL parameterization and bounds, TLS hostname/verification settings, successful empty responses, quota and transport failures, AI selection and private-data policy. Integration checks exercise Gemini through a controlled HTTP response with Ollama unavailable, nested AI execution, scope revocation, app-specific connection status and workspace backups without installation OAuth secrets. A real PostgreSQL partition test verifies bounded updates across tables with overlapping row identities. These checks establish application behavior; they do not establish authorization or live compatibility for a real external account.

At the initial release-verification stage, no external test accounts had been configured. Later owner-authorized live checks are recorded separately below. OpenAI, external databases and other unconfigured services remain unverified. Usage counters do not establish provider billing limits.

## Per-app disconnection regression

The disconnection update passed 94 unit/contract checks, 43 targeted account/engine integration checks (the opt-in real Ollama check was skipped in this targeted run), and four browser journeys. The account suite was then rerun with an explicit stale-queue worker check; all 27 account checks passed. The new browser journey disables Gmail, keeps Calendar connected across a reload, and disconnects the whole fixture account. Real user connections are never disconnected by these tests.

Coverage includes viewer/foreign-workspace rejection, nested workflow references, inherited AI connections, pausing and cancelling affected work, preserving unrelated workflows and app access, invalidating pending authorizations, rejecting stale refresh/callback writes, blocking disconnected selectors and worker operations, and reconnecting without enabling workflows automatically. The targeted independent reviewer was unavailable for this follow-up; the implementation received a manual correctness review and the checks above.

## Live business workflow suite — 24 October 2026

The owner-authorized business suite created **34 disabled workflows** in the existing connected workspace. All 34 final definitions passed real queue/worker runs using synthetic fixtures. Six representative Preview runs passed; all 19 successful write/send steps in those previews were recorded as simulated. The critical incident's additional low-severity case sent no alerts. A real authenticated webhook rejected an invalid token and deduplicated matching submissions into one successful low-severity run.

Live operations used Gmail, Google Sheets, Drive, Calendar, Telegram, Slack, Discord, Outlook, Gemini and native Ollama. Output checks verified spreadsheet header order, receipt of both Gmail and Outlook self-test emails in the destination mailbox, the Gmail classification label, a fifteen-minute calendar reschedule, all 22 AI steps' selected providers, and disabled state for every suite workflow. This verifies the exercised operations and destinations; it does not establish every supported operation or unrelated account.

The live runs exposed and resolved two defects: object rows needed explicit spreadsheet column ordering after PostgreSQL JSON persistence, and the HTTP connector's pinned DNS lookup needed Node's `all` callback contract. Regression tests cover both. The final unit/contract suite passed **104 tests**, backend and recipe typechecks passed, and production images built successfully. The corrected public landing-page workflow was rerun successfully. Earlier failed/cancelled attempts remain in history rather than being hidden.

All 23 reference screenshot titles are mapped in the generated report to a working original, an explicitly limited adaptation, or a deferred dependency. Shared-workspace isolation, unattended polling/schedules, restart during a pending delay/approval, missing external providers, physical-system portability and release usability gates are not newly established by this business-suite run. See [the suite guide](business-workflow-suite.md) for fixtures, reproducible commands and boundaries. Installation-specific IDs, sample inputs, run IDs and the detailed report remain in the owner's managed `NeuralForgeDemoSuite` folder and local verification artifacts.
