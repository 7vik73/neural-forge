# Local modular workflow engine

Status: accepted by the implementation plan.

Use the required Node.js, NestJS, PostgreSQL, Redis, BullMQ, Next.js/React, and TypeScript stack. Ollama is the only AI implementation. A workspace keeps the applications and shared packages together. The HTTP and worker entrypoints use the same NestJS modules.

The workflow package owns graph validation, frontier calculation, and binding resolution. PostgreSQL owns durable state. The execution module owns claims, attempts, leases, branch propagation, recovery, and transitions. Queue delivery is at least once and is deliberately separate from graph semantics. Provider implementations belong to the connection/operation modules. These modules expose meaningful behavior rather than generic forwarding repositories.

Bindings do not execute JavaScript. Lists use scoped acyclic child graphs and cannot nest. External effects cannot be guaranteed exactly once; ambiguous outcomes require explicit inspection. Published versions and each run’s scopes are immutable even when a draft changes.

The local browser is the owner’s control surface. No team tenancy, cloud AI fallback, arbitrary code execution, or public service hosting is introduced.
