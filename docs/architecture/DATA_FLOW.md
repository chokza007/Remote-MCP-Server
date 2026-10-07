# Data Flow

1. A client connects to the Streamable HTTP MCP endpoint. Local development accepts a long random loopback token; remote use requires HTTPS, OAuth authorization code with PKCE, and a trusted reverse-proxy origin.
2. Authentication resolves a stable principal, client, server device, and session. The session may change on reconnect; the stable identity must not.
3. The MCP gateway validates the tool schema, derives canonical targets, and asks the policy engine for authorization. Public metadata tools bypass grants; all other tools require a matching grant. Emergency Stop is checked before normal execution.
4. A persistent Full Access grant with `computer:*` automatically satisfies the policy level. Restricted modes may create an interactive approval. Authorization is re-evaluated for every call and before every durable job/schedule/watch step.
5. The adapter performs the operation with central size/time/concurrency limits. Mutations use explicit destinations, atomic replacement, locks, transactions, recycle/recovery, or verification where applicable.
6. Results return as structured MCP content. External/file/document content is tagged as untrusted data before model presentation. Important actions and failures are written to the append-oriented audit log after secret redaction.

Operational SQLite state contains grants, sessions/tokens, jobs, approvals, schedules, watches, audit events, runtime checkpoints, and artifact path references. User project knowledge remains at its project path. The checkpoint helper reads and atomically updates a project-owned file but does not store the body in the MCP database.

Credentials flow by opaque reference: metadata enters the model-facing layer, while secret material is retrieved from the Windows credential boundary only for an authorized adapter call. Privileged requests use a short-lived signed capability, payload hash, nonce, exact action/target, current authorization snapshot, and a local named-pipe broker.

On reconnect or restart, the database restores operational state. In-flight OS processes that cannot be reattached are reported as orphaned; durable jobs resume from persisted verified steps. Revoke, device unlink, epoch rotation, or Emergency Stop changes authorization before the next step.
