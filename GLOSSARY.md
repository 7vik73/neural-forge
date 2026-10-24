# Domain language

- **Workflow**: an automation with a mutable draft and immutable published versions.
- **Step / node**: one operation on the graph, identified independently from its label.
- **Trigger**: the single starting event for a workflow.
- **Binding**: a constant or safe reference to an earlier output or trigger input.
- **Connection**: a named account whose secrets are encrypted separately from workflows.
- **Run**: one execution with a frozen graph and input.
- **Scope**: a persisted instance of a graph, either the root or one bounded-list item.
- **Node execution**: the durable state of one node in one scope.
- **Attempt**: one claimed execution of a node, including its lease and outcome.
- **Outbox**: PostgreSQL dispatch records delivered to BullMQ after transaction commit.
- **Checkpoint**: a durable position in a polled event source.
- **Preview**: a run that executes reads/AI but simulates writes and sends.
- **Outcome unknown**: an operation may have changed its destination but confirmation was lost.
- **Approval**: a persisted wait for the owner’s decision, without occupying a worker slot.

- **Account**: a username/password identity that owns workspaces and may be a member of shared workspaces.
- **Administrator**: an account permitted to manage installation defaults, integration developer credentials and account access; this role does not grant another account’s workspace contents.
- **Workspace**: one owner’s private or explicitly shared collection of workflows, connections, notes, managed files, settings and run history.
- **Workspace context**: the authorized workspace and, for browser requests, authenticated account/session. Every automation data operation requires it.
- **Managed storage**: a separate directory chosen by the installation for each workspace, identified by an opaque server-generated key.
- **Workspace trash**: a 30-day recovery period in which automation is disabled and data remains recoverable.

- **Workspace member**: an existing account granted editor or viewer access by the workspace owner.
- **Workspace role**: owner, editor or viewer; checked against current persisted access on each operation.
- **AI provider**: Gemini, native Ollama or OpenAI behind the same AI operation interface.
- **Data policy**: private processing through local AI, or an explicit public/synthetic demo choice allowing cloud AI.
- **Installation OAuth application**: shared developer credentials resolved transiently by the server; a workspace stores only their reference and its own authorization tokens.
- **App catalog**: supported provider actions plus actual workspace connection status; connector availability does not mean an account is authorized.
