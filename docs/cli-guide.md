# CLI guide

The CLI is the most transparent interface for runtime diagnostics and release verification.

## Launch syntax

```text
npm run cli -- [prompt] [options]
```

| Option | Meaning |
| --- | --- |
| `-h`, `--help` | Print launch help without initializing the runtime |
| `-v`, `--version` | Print the installed Deep-Mix version |
| `--prompt <text>` | Submit an initial task after startup |
| `--workspace <path>` | Select the target workspace; defaults to the current directory |
| `--mode <mode>` | `plan`, `edit`, `auto`, or `danger-full-access` |
| `--route <route>` | `governor_direct`, `coding_worker`, or `vision_worker` (legacy values remain readable) |
| `--resume [id]` | Resume a specific or latest resumable session |
| `--list-skills` | Print discovered Skills as JSON |
| `--skill-query <text>` | Filter `--list-skills` |
| `--mcp-status` | Print MCP server status as JSON |
| `--run-workflow <name>` | Execute a discovered deterministic workflow |

Examples:

```powershell
npm run cli -- --workspace C:\work\project --mode plan
npm run cli -- --workspace C:\work\project --mode auto --prompt "Find the failing test"
npm run cli -- --workspace C:\work\project --route coding_worker --mode auto --prompt "Refactor the parser"
npm run cli -- --workspace C:\work\project --resume
```

On Windows, forward slashes or quoted backslashes are safest when launching through Git Bash. The parser detects common backslash-stripping failures and stops instead of silently selecting the wrong workspace.

## Startup header

The shell displays the Deep-Mix version, resolved workspace, permission mode, route override, provider-profile status, and runtime capability summary before normal interaction. When the terminal cannot support the full TUI, Deep-Mix uses a simplified shell and explains the fallback.

## Slash commands

| Command | Behavior |
| --- | --- |
| `/help` | Show interactive commands |
| `/resume [id]` | Resume a specific or latest resumable session |
| `/continue` | Continue the current session, or resume the latest one |
| `/export` | Export the current session to local Markdown |
| `/context` | Show context budget, token usage, compaction, and duration |
| `/undo [checkpoint]` | Restore the latest or selected checkpoint when supported |
| `/session` | Show the current session ID |
| `/status` | Show session and runtime status |
| `/tools [n|latest]` | Expand a grouped tool round |
| `/processes` | List managed processes owned by the session |
| `/stop-process <id>` | Stop a managed process through the normal permission path |
| `/exit` | Exit safely while leaving resumable state |

`/processes` and `/stop-process` are useful only when experimental managed processes have been enabled. The tools remain disabled by default.

## Permission modes

- `plan`: intended for inspection and planning; mutating tool projections are withheld except for explicitly safe plan-mode actions.
- `edit`: controlled editing mode with permission enforcement.
- `auto`: recommended default; routine actions follow policy and guarded actions request approval.
- `danger-full-access`: reduces approval friction and should be restricted to disposable or fully understood workspaces.

Mode names are permission-policy inputs, not OS sandboxes. Always inspect commands and paths.

## Routing

Automatic routing keeps governance with the configured `governor` slot. Coding or vision work may be delegated to a specialist, but the worker's artifact returns to the governor for review. `--route` is primarily a validation and debugging override; it does not grant the worker direct workspace access.

Use `governor_direct` when validating the governor alone. Use `coding_worker` or `vision_worker` only after the selected slot profile probe and capability gate succeed.

## Approvals

An approval prompt identifies the requested tool and effect. Supported decisions include deny, allow once, and session-scoped approval. Choose the narrowest adequate option. Changing a prompt or target can produce a new approval key.

If a turn is waiting for approval, answer the approval rather than sending an unrelated prompt. Interrupting the process preserves durable state where possible.

## Sessions and exports

Session data is stored under `~/.deep-mix/workspaces/<workspace-id>/` by default. `/resume` still resolves by workspace identity, so launching with the wrong `--workspace` will not find the intended session.

Exports are local convenience artifacts, not automatically redacted reports. Check for private paths, code, user prompts, tool output, and provider content before sharing.

## Non-interactive inspection

These commands emit JSON and exit:

```powershell
npm run cli -- --list-skills
npm run cli -- --list-skills --skill-query release
npm run cli -- --mcp-status
npm run cli -- --run-workflow repository-smoke
```

A normal provider profile is still required for commands that initialize the governor runtime, even if a specific operation does not send a model request.
