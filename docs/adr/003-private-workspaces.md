# Accounts and private workspaces

Status: accepted. Supersedes the single-owner restriction in ADR-001 and ADR-002.

An installation has invited username/password accounts. Each account owns multiple private workspaces. Administrator status manages accounts and installation defaults; it does not bypass workspace ownership. Access remains local to the host computer. Collaboration, public signup and internet hosting remain deferred.

Workspace identity is persisted outside the portable workflow graph. Automation records carry workspace IDs; composite foreign keys keep parent/child relationships inside the same workspace. The published version must belong to its workflow and workspace.

The authentication module establishes an explicit request context. The workspace guard verifies ownership and attaches the authorized workspace. The database module fences all automation model operations, including transaction operations, against that context. A missing context fails closed. SSE operations revalidate sessions, workspace availability and owner status. Background execution enters a context reconstructed from the persisted job target; it never trusts an incoming workspace field. A separate, explicitly named system client exists only for account administration, maintenance and initial job/webhook resolution. It is not exposed through a generic HTTP interface. Raw SQL remains restricted to fixed maintenance, migration and advisory-lock statements.

Workspace settings, file directories, connections and backups remain private. One shared queue has four execution slots, and the installation-wide Ollama semaphore permits one AI request. A workspace switch changes navigation, not running automation.

Workspace trash lasts 30 days. Trashing or suspending access blocks future work and requests cancellation; completed external effects remain completed. Restoration leaves workflows disabled. Permanently deleting a workspace waits for execution leases to settle and removes only its server-generated managed directory.

The legacy owner becomes an administrator with a Personal workspace. Password hashes and existing record IDs are preserved; old sessions are revoked. File migration uses verified, resumable copies and preserves the original folder. New workspace backups exclude accounts and installation secrets and restore with fresh persisted identities. Full installation recovery is a local operator capability.

Credential verification and session issuance hold the same user-row lock as recovery, password changes and suspension. This makes session revocation effective even when an old-password sign-in is already in flight. All these operations commit their state together.

Imported workspace run records carry `restoredAt`. They remain inspectable historical snapshots and cannot be retried, because arbitrary provider payloads may contain the source installation’s IDs. Fresh runs use the remapped, disabled workflow definition after review; the engine never resumes imported pending work.
