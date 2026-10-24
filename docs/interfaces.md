# Local HTTP interface

All application routes use `/api/v1`. Interactive route documentation is available at `/api/docs` on the backend, or through the frontend proxy. Authenticated routes require the `forge_session` HTTP-only cookie. Browser writes also require the configured Origin and `X-Forge-Request: 1`. A webhook uses its own bearer token instead of an account session.

## Workflow definitions

The authoritative TypeScript and runtime schemas are exported from `@forge/contracts`. A workflow has `schemaVersion: 1`, `nodes`, `edges`, and `settings`. Nodes have stable IDs, a catalog type/version, a display label, configuration, and input bindings. A binding is a constant JSON value or a reference to `$input` or an earlier node output. Reference formats are `none`, `text`, `upper`, `lower`, `json`, and `date`. Paths use dot-separated object fields or array indexes. Prototype-related paths are forbidden.

```json
{
  "schemaVersion": 1,
  "settings": { "timezone": "UTC", "maxItems": 1000 },
  "nodes": [
    {
      "id": "start",
      "type": "trigger.manual",
      "version": 1,
      "label": "Start",
      "config": {},
      "inputs": {}
    },
    {
      "id": "format",
      "type": "data.text",
      "version": 1,
      "label": "Uppercase",
      "config": { "operation": "upper" },
      "inputs": {
        "text": { "kind": "reference", "nodeId": "$input", "path": "text", "format": "none" }
      }
    }
  ],
  "edges": [
    { "id": "a", "source": "start", "target": "format", "sourcePort": "out", "targetPort": "in" }
  ]
}
```

## Accounts and workspace routing

`POST auth/register` accepts `{ username, password, timezone? }`; the interface detects timezone silently. Registration transactionally creates the first administrator or an ordinary account, plus a Personal workspace. `POST auth/login` accepts `{ username, password }`; `POST auth/logout` revokes the current session; `GET auth/me` returns the signed-in account. Retired setup/invitation endpoints return 410 and direct clients to signup. `POST auth/recover` consumes a hashed one-use recovery token and revokes existing sessions. `PATCH account` edits the profile, `POST account/password` changes the password using `{ currentPassword, password }`, and `DELETE account` requires `{ password }` and moves the account to trash.

Administrator routes are `GET admin/users`, `PATCH admin/users/:id`, and `POST admin/users/:id/recovery`. User changes choose `status` and optional `isAdmin`; the final active administrator is protected. Registration invitations are revoked and no longer issued. Installation settings are administrator-only under `system/settings`. `GET system/integrations` returns safe integration metadata; `POST system/integrations/:provider` stores encrypted Google/Microsoft developer credentials. Admin access never overrides workspace membership.

`GET/POST workspaces` lists owned/shared workspaces or creates a private workspace. `PATCH/DELETE workspaces/:workspaceId` renames/trashes one; `GET workspaces?trash=true` lists recoverable trash; `POST workspaces/:workspaceId/restore` restores disabled automations; `POST workspaces/:workspaceId/purge` requires `{ password }`.

All feature routes in the table below are relative to **`/api/v1/workspaces/:workspaceId/`** except installation-wide read-only `catalog`, `templates`, and the preserved `hooks/:id` endpoint. Notes, files, connections, AI drafting and settings follow that same workspace prefix. `POST workspaces/restore` accepts `{ passphrase, backup }` and creates a new private workspace. Global callbacks remain `connections/google/callback` and `connections/microsoft/callback`; validated one-time OAuth state identifies its authorized user, workspace and connection.

`GET/POST workspaces/:workspaceId/members` lists/adds existing users; `PATCH/DELETE workspaces/:workspaceId/members/:userId` changes a role or removes membership. These operations require the owner. Roles are `owner`, `editor`, and `viewer`; members are unique per workspace/user pair. Workspace settings, trash, restore, purge and backups remain owner-only.

Every feature request verifies the active account, active owner/workspace, membership role and resource scope. Reads require viewer access; content/connection/execution mutations require editor access. Resource selectors require editor access. Inaccessible IDs return 404 and insufficient roles return 403. SSE revalidates access and closes when a session, account or membership is revoked. Workers derive context from persisted execution records; a queue workspace field cannot grant access. The portable graph has no ownership field.

## Main operations

| Method and path               | Body / behavior                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `POST workflows`              | `{ name, description?, definition }` creates a draft                                                                 |
| `PATCH workflows/:id`         | `{ name, definition, revision }`; stale revisions return 409                                                         |
| `POST workflows/:id/validate` | `{ definition? }`; returns an `issues` array                                                                         |
| `POST workflows/:id/enable`   | `{ revision }`; publishes a frozen version and enables its trigger                                                   |
| `POST workflows/:id/disable`  | Disables future trigger events                                                                                       |
| `POST workflows/:id/runs`     | `{ input, preview }`; executes the saved draft or returns validation issues                                          |
| `GET runs/:id`                | Snapshot, scopes, node states, attempts, outputs, and errors                                                         |
| `GET runs/:id/events`         | SSE with persistent IDs; supports `after` or `Last-Event-ID`                                                         |
| `POST runs/:id/cancel`        | Stops further work                                                                                                   |
| `POST runs/:id/approval`      | `{ taskId, approve }`                                                                                                |
| `POST runs/:id/retry`         | `{ taskId, inspectedDestination }`; unknown outcomes require explicit inspection; restored history cannot be retried |
| `POST ai/generate`            | `{ description, existing?, ai? }`; returns a validated draft proposal and questions                                  |
| `GET catalog`                 | Supported node types, configuration widgets, output fields, and effect classifications                               |
| `POST hooks/:id`              | JSON input; bearer authentication; optional `Idempotency-Key`                                                        |
| `POST backup`                 | `{ passphrase }`; returns an authenticated encrypted backup envelope                                                 |

Validation failures return explanatory issues with optional node and field identifiers. Errors use `{ message }`. A preview clearly marks simulated writes. External effects that cannot be confirmed become `unknown`; the engine does not claim exactly-once delivery.

## AI and apps

Workflow `settings.ai` accepts `{ provider, model?, connectionId?, dataPolicy }`. Providers are `gemini`, `ollama`, and `openai`; `dataPolicy` is `private` or `public-demo`. Cloud providers require an authorized workspace connection and explicit public-demo handling. Individual AI nodes may override provider/model/connection; publication freezes selections. Missing legacy settings preserve Ollama behavior. Connections are references only; exported workflows replace them with placeholders, including nested list bodies.

Workspace `GET apps` returns supported app definitions with connection status; a connector's presence is not proof of authorization. `GET ai/models` accepts provider/connection selection, `POST ai/test` tests that selection, and `GET ai/usage` returns metadata counters. `GET connections/:id/resources` provides authorized selectors. Secrets never appear in these responses. See [app integrations](app-integrations.md) for operations and live-test requirements.

## Connection lifecycle

`POST connections/:id/disconnect` accepts `{ appId? }` within the workspace prefix. For Google/Microsoft, an app ID disables just that app locally; omitting it removes the full saved account connection. A single-app provider is removed as a whole. The response reports paused workflows and cancelled active runs; definitions, history and local content are retained. The legacy `DELETE connections/:id` uses the same full-disconnect behavior.

`POST connections/:id/apps/:appId/connect` re-enables a previously disabled shared-provider app after checking its retained authorization. It leaves workflows disabled for review. Connection metadata includes active `apps` and local `disabledApps`; credentials remain encrypted and are never returned. Disconnection invalidates pending OAuth states, and stale callbacks/token refreshes cannot overwrite the local app policy. These endpoints require editor or owner access.
