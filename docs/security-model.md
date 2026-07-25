# Security model

Deep-Mix is a local developer agent with a permissioned tool runtime. It is not an operating-system sandbox, container, virtual machine, endpoint-security product, or substitute for repository review.

## Assets to protect

- provider API keys and other credentials;
- private source code and attached documents;
- Git history, branches, tags, remotes, and uncommitted work;
- local files outside the selected workspace;
- external systems reachable through network or MCP tools;
- session transcripts, worker artifacts, approval records, and checkpoints;
- availability of the host, including CPU, memory, disk, and child processes.

## Untrusted inputs

Treat all of the following as untrusted:

- user-supplied repository content and instructions;
- model and worker output;
- web pages, search snippets, downloaded files, and URLs;
- MCP server descriptions, resources, and results;
- archives, office documents, notebooks, images, and metadata;
- command output and Git metadata;
- restored sessions created by an older or interrupted runtime.

Prompt injection can appear in any textual input. Repository instructions are useful context, not an authorization token. Only the permission layer and explicit user intent authorize side effects.

## Security controls

### Single side-effect plane

Final writes, shell commands, tests, Git actions, network operations, and MCP calls are executed through the Tool Runtime and Permission Layer. Workers have no direct workspace-write capability.

Every registered tool has an input schema and metadata for permissions, side effects, timeouts, capabilities, and selection. Invalid or unavailable calls fail closed with a structured result.

### Permission modes and approvals

`plan`, `edit`, `auto`, and `danger-full-access` alter which actions are offered and when approval is required. Approval records are bound to normalized request information so a materially different command or target does not silently reuse an unrelated decision.

`danger-full-access` is not a sandbox bypass because no sandbox exists; it is a high-trust operating mode. Use it only when the workspace and requested commands are understood.

### Workspace and path controls

Built-in file tools resolve paths against the selected workspace, apply traversal and protected-path checks, and enforce tool-specific size/output limits. The API-key library is a protected runtime path and should never be edited by normal agent write tools.

Path controls do not constrain an arbitrary approved executable after it starts. A shell program running as the user can use any access the OS grants it.

### Checkpoints and rollback

Supported mutating tools create checkpoint and rollback records. These improve recovery from normal edits but are not transactional isolation. Remote API calls, arbitrary commands, process effects, and unsupported file operations may be irreversible.

### Network policy

Network tools declare network permission and use bounded response sizes, timeouts, redirect policy, and host controls where implemented. External semantic providers require explicit opt-in and a declared data boundary. MCP tools remain subject to the same runtime selection and permission flow.

Local `dependency_audit` and `security_scan` tools are report-oriented by default: they should not install scanners, upgrade dependencies, call an external model, or remediate source implicitly.

### Durable history integrity

Before provider requests, the governor validates tool-call history and repairs or falls back from incomplete groups. This protects protocol integrity after interruption; it does not prove that previously stored content is benign.

## Managed background processes

The tools `start_process`, `process_input`, `process_output`, and `stop_process` support development servers, watchers, and interactive commands across tool calls. In v1.0.0 they are **experimental and disabled by default**:

```json
{
  "version": 1,
  "experimental": {
    "managedProcesses": false
  }
}
```

When explicitly enabled, the runtime tracks process ownership, input/output cursors, readiness, exit state, session interruption, and stop attempts. It also rejects common shell detachment patterns in normal command tools.

Limitations:

- there is no Windows Job Object, Linux cgroup/namespace, macOS sandbox profile, or equivalent OS containment;
- a malicious executable may spawn a grandchild, double-fork, detach, rename itself, or otherwise escape lifecycle tracking;
- stopping the tracked parent does not prove that every descendant stopped;
- processes inherit the current user's filesystem and network privileges;
- output redaction and size limits cannot prevent every application-level leak.

Only enable managed processes in a disposable or trusted workspace, and independently inspect the host process list after abnormal termination. OS-level containment is a roadmap item, not a hidden claim.

## Secrets and local state

Preferred profile pattern:

```json
{
  "apiKeyEnvName": "DEEPSEEK_API_KEY"
}
```

Do not commit:

- `.deep-mix/api-key-library/profiles.local.json`;
- `.env` or shell history containing real keys;
- `.deep-mix/sessions`, approvals, checkpoints, telemetry, MCP artifacts, or worker artifacts;
- screenshots or exported transcripts containing secrets or private code.

The repository `.gitignore` uses a deny-by-default `.deep-mix` policy and allowlists only public boundary documentation/configuration. A target project should normally ignore its entire `.deep-mix/` directory.

If a credential enters Git, removing it from the latest file is insufficient. Revoke or rotate it immediately, then clean history if required by the repository's incident process.

## Documents, archives, and formulas

Document tools apply size and selection bounds. Archive handling must defend against traversal and decompression abuse. Spreadsheet writers neutralize CSV/TSV formula injection by default and reject high-risk external-execution formulas while preserving explicitly supported ordinary formulas.

Opening a generated or analyzed document in another application crosses into that application's security model. Keep Office protected view and endpoint protections enabled for untrusted inputs.

## Dependencies and supply chain

The release lock file is committed and CI uses `npm ci`. `npm audit` runs in the security workflow. Dependabot proposes dependency updates. The spreadsheet layer uses `@mui/x-internal-exceljs-fork` through the local dependency name `exceljs` because upstream `exceljs@4.4.0` retained vulnerable, obsolete transitive dependencies at the v1.0.0 release date.

An audit result is a point-in-time signal, not a guarantee. Review lock-file changes, install scripts, maintainer changes, provenance, and release notes before accepting dependency updates.

## Recommended operating practices

1. Use a non-administrator account.
2. Start unfamiliar repositories in `plan` mode.
3. Work in a disposable clone with a known Git state.
4. Review every command, path, URL, and external target before approval.
5. Prefer allow-once approvals.
6. Keep backups and remote branch protection enabled.
7. Do not expose the Desktop dev server to untrusted networks.
8. Keep managed processes disabled unless the task genuinely requires them.
9. Inspect `git diff`, test output, and external state independently before publishing or deploying.

## What Deep-Mix does not protect against

- a malicious or compromised operating-system user;
- arbitrary code you explicitly approve with your own privileges;
- provider-side retention or misuse of submitted data;
- a compromised npm package or model provider;
- secrets already present in repository history or process environment;
- irreversible remote actions that were correctly approved;
- physical access, malware, kernel compromise, or endpoint compromise.

Report vulnerabilities according to [`SECURITY.md`](../SECURITY.md).
