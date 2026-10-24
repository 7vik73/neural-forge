# Portability and credentials

Status: accepted.

Docker Compose runs PostgreSQL, Redis, the worker, HTTP backend, and frontend. Native Ollama stays on loopback. Application containers use host networking when available. On Docker Desktop, a detected private-host-gateway fallback uses an isolated bridge network and loopback-published browser/backend ports; native Ollama stays on its existing loopback listener. The frontend proxies requests using its runtime backend address. Database and Redis ports bind to loopback and require generated passwords. The selected local folder is the only host folder mounted in application containers.

Connection secrets use AES-256-GCM with an installation key stored outside PostgreSQL. Owner passwords use scrypt. Sessions are random tokens with only their hashes stored. Browser writes require the expected Origin and a custom request header. Exports use connection placeholders; imports remain disabled. Google uses a per-installation web OAuth client and the same-origin callback through Next.js.

Browser backups use a separate passphrase-derived encryption key and re-encrypt connection credentials under the destination installation key. Full launcher backups include the installation encryption key inside the encrypted archive. Restore targets must be empty. Active work is stopped on restore, and workflows require review before reactivation.
