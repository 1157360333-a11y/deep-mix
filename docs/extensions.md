# Extensions

Deep-Mix separates repository rules, reusable guidance, deterministic orchestration, live external tools, and specialist models. Keeping these boundaries clear prevents an extension from acquiring authority it was never meant to have.

## Boundary summary

| Mechanism | Location | Use it for | Do not use it for |
| --- | --- | --- | --- |
| Repository rules | `AGENTS.md` | Durable safety, verification, architecture conventions | One-off procedures or credentials |
| Skill | `.deep-mix/skills/<name>/SKILL.md` | Reusable guidance and process knowledge | Live external access or deterministic state machines |
| Workflow | `.deep-mix/workflows/*.workflow.json` | Fixed governor/worker/tool step sequences | Open-ended advice or hidden authorization |
| MCP | `.deep-mix/mcp/servers.json` | Live external systems and resources | Repository policy or reusable prose |
| Worker | Runtime package | Typed model specialization | Governing, approving, or direct writes |

Every action still uses the Tool Runtime and Permission Layer.

## Skills

Project Skills are discovered from `.deep-mix/skills/<name>/SKILL.md`. Compatibility Skills may be discovered from `.agents/skills/`; user and built-in locations are also supported. Higher-priority project definitions shadow lower-priority definitions with the same normalized name.

Minimal Skill:

```markdown
---
name: release-check
description: Prepare a local release checklist. Use when the user asks to verify a release candidate.
metadata:
  allow-implicit-invocation: true
---

# Release check

Run the repository's documented checks and report failures before publishing.
```

Copy the complete example from [`examples/skills/release-check`](../examples/skills/release-check/SKILL.md). Set `allow-implicit-invocation: false` when the Skill should be used only after an explicit request. A settings entry can disable a Skill by name.

A Skill may explain which tools to use, but cannot execute them by itself or bypass approval.

## Workflows

Workflow files end with `.workflow.json`. Discovery checks project, user, and built-in locations. Each file contains a name, description, and ordered `steps` array.

Supported step types:

- `governor`: `record_message` or `update_plan`;
- `worker`: `coding` or `vision` with a structured input object;
- `tool`: a registered tool name and JSON arguments.

Each step can use `"onError": "abort"` or `"continue"`; the default is abort. Continuing after a failure keeps the overall run observable as unsuccessful even if later steps execute.

See [`examples/workflows/repository-smoke.workflow.json`](../examples/workflows/repository-smoke.workflow.json). To try it in a target repository, copy it to that repository's `.deep-mix/workflows/` directory and run:

```powershell
npm run cli -- --workspace C:\path\to\target --run-workflow repository-smoke
```

Workflow arguments are not trusted code. The named tool still performs schema validation, availability checks, permissions, and checkpoints.

## MCP

MCP represents external or live systems. v1.0.0 has built-in configuration shapes for GitHub public-read operations and a Playwright-style browser adapter. Server status and tool descriptors are dynamically injected into the runtime rather than mixed with static Skill content.

Copy [`examples/mcp/servers.example.json`](../examples/mcp/servers.example.json) to `.deep-mix/mcp/servers.json`, then inspect:

```powershell
npm run cli -- --workspace C:\path\to\target --mcp-status
```

An enabled MCP server does not imply unrestricted access. Tool selection, input schemas, permission categories, network rules, and runtime availability still apply. Do not store reusable tokens in a versioned MCP file.

## Repository rules

`AGENTS.md` is loaded as durable repository context. Keep it short and stable: architecture constraints, protected paths, collaboration rules, and canonical verification commands. Place a reusable release checklist in a Skill, and place a fixed release pipeline in a Workflow.

Repository instructions can influence model behavior, but they cannot authorize an operation that the permission layer denies.

## Adding a built-in tool

Built-in tool work is a code contribution, not a project extension. Use the scaffold command:

```powershell
npm run create:tool -- <tool-name>
```

A production tool needs a stable name, JSON input schema, description, permission category, side-effect and timeout metadata, selection metadata, capability handling, bounded outputs, structured errors, tests, and documentation. Mutating tools should define checkpoint behavior where feasible.

## Review checklist

- Is this the correct extension mechanism?
- Can untrusted content turn the extension into hidden authorization?
- Are secrets absent from versioned files?
- Are paths, network hosts, output sizes, and timeouts bounded?
- Does the extension preserve the one-governor and one-side-effect-plane invariants?
- Are discovery collisions and failure behavior tested?
