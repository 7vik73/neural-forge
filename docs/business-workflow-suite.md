# Business workflow suite

The suite in `scripts/business-workflows/` creates 34 original workflows in an existing, authorized workspace. It adapts supported examples from the reference screenshots and adds business exception alerts. It does not implement missing Shopify, WhatsApp, Shiprocket, video, social publishing, or external database services by substituting fake outputs.

## Using the saved workflows

Open **My workflows** and search for `[Sales]`, `[Finance]`, `[Management]`, `[Operations]`, `[Support]`, `[Marketing]`, `[Personal]`, `[Email]`, or `[Learning]`. Each workflow remains a disabled draft after testing. Its description identifies adaptations and synthetic demo use.

The fixture spreadsheet contains Leads, Invoices, InvoiceDrafts, Stock, Budget, Projects, Feedback, Audit and Purchases tabs. Inputs, knowledge files, notes and a calendar event are dedicated synthetic fixtures. No customers receive messages. Emails are drafts except for the two explicitly named self-delivery verification workflows. Alerts go to the selected owner-controlled Slack/Discord automation channels and private Telegram chat.

Before enabling a workflow for real work, replace its demo inputs, resource IDs, destinations and trigger configuration in the builder; choose the intended schedule and timezone. Review every write/send destination. Incoming private data must use explicitly selected local Ollama; free Gemini demonstrations must remain public/synthetic. The handbook examples read a selected document/note and do not provide vector retrieval or an indexed RAG service.

## Reproducible verification

Use the existing local API container, account and workspace. The operator reconstructs workspace authorization from that account and uses the application's saved connection adapters. It never exports connection secrets. Run phases sequentially: `inventory`, `prepare`, `create`, `run`, `report`. `diagnose` reads only suite runs and fixture metadata; `cancel` cancels only suite runs. After the real suite completes, `webhook` temporarily publishes the incident demo, checks rejection of a bad token and duplicate delivery of a harmless low-severity event, then disables it. `verify` reads the saved rows, received self-test emails, AI metadata, labels and calendar event; it also fixes the dedicated audit tab’s column headings. Do not run two mutating phases at once.

Copy `scripts/business-workflows/.` to `/app/business-workflows/` in the API container. Set `FORGE_WORKSPACE_ID` and `FORGE_USERNAME` when executing:

```text
node /app/business-workflows/operator.mjs inventory
node /app/business-workflows/operator.mjs prepare
node /app/business-workflows/operator.mjs create
node /app/business-workflows/operator.mjs run
node /app/business-workflows/operator.mjs report
```

Set `SUITE_PREVIEW=1` for simulated writes/sends. Set `SUITE_SLUGS` to a comma-separated subset for targeted tests. A real run uses normal outbox, queue and worker processing. The runner accepts approvals only in its own synthetic runs and cancels tests that exceed their deadline. It records graph hashes and reuses completed successful tests for the same definition, avoiding repeated successful sends on ordinary resume. A changed graph or failed test can execute again; inspect partially completed external effects before retrying. Unknown external outcomes are never automatically rerun.

The workspace-managed `NeuralForgeDemoSuite/manifest.json` records fixture IDs, definitions and test identities. `report.md` and `report.json` contain statuses, assertions, run IDs, screenshot coverage and limits. They contain no saved provider credentials. Preserve the manifest to resume safely. Do not reuse a manifest in another workspace.

## Verification boundaries

A successful Run now verifies the graph on the supplied test input, including real provider responses and saved outputs. It does not by itself prove unattended schedule delivery, polling checkpoints, recovery after a restart, or an incoming webhook. These require separate ingress/recovery checks and must be reported separately.

The suite includes both threshold outcomes (including the exact stock boundary), low-severity suppression, persisted delay and explicit approval. Test assertions distinguish a green execution from a result that failed verification. Provider acknowledgment is distinct from downstream email delivery or a human seeing an alert.

Google Sheets append/update supports an optional **Object field order**. Set comma-separated object keys to map persisted structured AI results into a known header order; JSON object property order is not a reliable spreadsheet column contract. Existing array rows remain unchanged.
