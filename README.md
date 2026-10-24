# Neural Forge

A workflow studio with username/password accounts, private or shared workspaces, a guided builder, a visual canvas and AI through Gemini, optional native Ollama or OpenAI. Built with Node.js 24, NestJS, Next.js/React, TypeScript, PostgreSQL, Redis, BullMQ and Prisma.

## Start

Install Docker Desktop or Docker Engine. Open a terminal in this directory:

```sh
./start.sh
```

On Windows PowerShell:

```powershell
./start.ps1
```

The first launch builds container images. Open [localhost:4300](http://localhost:4300), then **Create account** or **Sign in**. Registration asks for a username and password; no invitation, timezone or setup token is needed. The first registered account becomes the installation administrator. Each account starts with a Personal workspace. Keep `.env` private; it contains installation credentials and encryption keys.

Ollama is optional. To use private/offline AI, install [Ollama](https://ollama.com/download) and run:

```sh
ollama pull qwen3:4b
```

Without Ollama, the app, non-AI workflows and configured Gemini/OpenAI workflows still work. The launcher selects host networking when native Ollama is reachable, otherwise Docker bridge networking. Services listen only on loopback: web 4300, API 4301, PostgreSQL 45432 and Redis 46379. Node.js is unnecessary for the basic shell/PowerShell launchers.

## Accounts and workspaces

An account can own Personal, Sales, Marketing and other workspaces. Each workspace contains multiple workflows and its own connections, notes, files, run history and retention settings. Use the workspace switcher to create, rename or switch spaces; separate tabs can use different workspace URLs. Pending edits are saved before switching.

Owners share a workspace by adding an existing username as **Editor** or **Viewer**. Editors build and run workflows and manage connections/content; viewers inspect content and history. Only owners manage membership, workspace settings, backups and deletion. Stored secrets are never returned to members. Shared workspaces appear under “Shared with me.” Sharing is between accounts on this computer; access from other computers is not enabled.

Administrators manage account suspension, recovery and installation defaults without gaining access to other people’s workspace content. Account settings allow profile/password changes. Password recovery links expire in 30 minutes and revoke existing sessions when used.

Workspace deletion stops future automation, requests cancellation and retains data for 30 days. Restoring keeps workflows disabled until reviewed. Permanent deletion needs the owner’s password and waits for execution leases to settle. Account deletion trashes its owned workspaces; administrators can reactivate an account within 30 days. At least one active administrator must remain.

## AI and workflow settings

Open a workflow’s **Workflow settings · timezone and AI** panel to select its timezone, provider, model and connection. AI steps can override the provider/model/account in advanced fields. Legacy workflows without AI settings continue using Ollama.

To connect Gemini, open **Apps & connections → Google Gemini**, enter your own API key and test it. The initial model is `gemini-3.5-flash-lite`; available models can be loaded in the workflow panel. API keys stay encrypted on the server. OpenAI is an optional separately billed provider; its initial model is `gpt-4.1-mini`.

Free Gemini has model/project-specific request and token quotas. Check your project’s [actual limits in AI Studio](https://ai.google.dev/gemini-api/docs/rate-limits). Local usage metadata is an estimate, not a billing guarantee. The app does not enable billing or switch providers automatically.

Workflows default to **Private** data handling. Cloud AI requires an explicit **Public / synthetic demo data** choice. Use synthetic/public data for free Gemini; use Ollama for confidential/customer data. Google’s unpaid-service terms prohibit sensitive, confidential or personal information and describe how inputs/outputs may be used: [Gemini terms](https://ai.google.dev/gemini-api/terms). There is no automatic cloud fallback.

## Build a workflow

1. Choose **Describe a workflow**, **Templates**, or **Build visually**.
2. Configure missing connections and destinations using guided fields/selectors.
3. Review the workflow timezone and AI provider.
4. **Preview** runs reads and AI but simulates writes/sends.
5. **Run now** performs the real operations. Inspect Run history and notes.
6. Enable a reviewed workflow for unattended triggers.

Published versions are immutable; editing an enabled workflow makes a draft. Branches, joins, bounded lists, delays, approvals, cancellation and explicit uncertain outcomes are supported. Schedules run while the engine/computer run; missed recurring occurrences are skipped after restart. Logging out or switching workspaces does not stop automation. Polling establishes a baseline rather than processing historical events.

## Connected apps

Existing Gmail, Sheets, Telegram, SMTP/IMAP and HTTP support is joined by Drive, Calendar, Slack, Discord, Notion, Outlook, Excel 365, MySQL and PostgreSQL. The searchable app catalog lists supported actions and actual connection status. Implemented connectors are not automatically connected accounts.

Google/Microsoft OAuth developer credentials are configured once by an administrator under **Installation settings → App developer credentials**. Workspace users then authorize their own accounts. Legacy per-connection OAuth configurations remain supported. Required callback URLs:

```text
http://localhost:4300/api/v1/connections/google/callback
http://localhost:4300/api/v1/connections/microsoft/callback
```

See [app setup and supported operations](docs/app-integrations.md). Live provider tests require your nominated test accounts; no personal accounts or API keys are bundled.

The [business workflow suite guide](docs/business-workflow-suite.md) describes 34 synthetic business examples, their safe test destinations, repeatable verification and the limits of reference-workflow adaptations.

## Development and verification

Install Node.js 24 and pinned pnpm 10.34.7:

```sh
corepack enable
pnpm install
pnpm setup
docker compose up -d --wait postgres redis
node --env-file=.env apps/backend/node_modules/prisma/build/index.js migrate deploy --schema apps/backend/prisma/schema.prisma
pnpm dev
```

Shared packages build before development processes start; rebuild them after changing shared contracts. Source is organized in `apps/web`, `apps/backend`, `packages/contracts`, `packages/workflow`, `packages/connectors`, `scripts`, `infra`, `tests` and `docs`.

```sh
pnpm typecheck
pnpm test
pnpm build
docker compose exec -T postgres createdb -U forge forge_test
node scripts/test-database.mjs
pnpm test:integration
RUN_OLLAMA_TESTS=1 pnpm test:integration
RUN_OLLAMA_TESTS=1 pnpm test:e2e
```

Tests refuse unsafe database names. Browser suites seed and remove only randomly named fixture accounts/workspaces; they do not reset existing user passwords. See [verification and remaining release gates](docs/testing.md).

## Backup and upgrade

**Workspace settings → Download backup** creates a passphrase-encrypted archive of that workspace’s supported files, definitions, credentials and history, with a 50 MB browser limit. It excludes accounts, sessions, memberships and installation OAuth developer secrets. Restore creates a new private workspace with remapped resource references; connections need testing, workflows stay disabled and imported runs are history-only.

Local operator commands require Node.js 24:

```sh
node scripts/manage.mjs backup
node scripts/manage.mjs restore /absolute/path/to/backup.json
node scripts/manage.mjs upgrade
node scripts/manage.mjs reset-admin your_username
```

Full backup includes all accounts, memberships, managed files and the protected installation key inside the encrypted archive. Upgrade backs up and stops processes before migration. Full restore needs an empty installation and explicit confirmation. Legacy browser/full archives use `migrate-workspace-backup` and `migrate-backup`; see [interfaces and migration notes](docs/interfaces.md). Keep backup passphrases separately.

Architecture decisions are in [ADR-004](docs/adr/004-shared-workspaces-and-ai-providers.md); domain names are in [GLOSSARY.md](GLOSSARY.md). Public hosting, access from other computers, workspace ownership transfer, unrestricted SQL/code execution, media generation and the smaller commercial apps from the reference image remain outside this release.
