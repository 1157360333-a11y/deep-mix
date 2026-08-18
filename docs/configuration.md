# Configuration

Deep-Mix has three configuration layers: provider profiles, runtime settings, and launch flags. Secrets and normal preferences deliberately use different files.

## Provider profiles

Provider connections are stored outside ordinary settings. The preferred locations are:

```text
~/.deep-mix/workspaces/<workspace-id>/api-key-library/profiles.local.json
~/.deep-mix/api-key-library/profiles.local.json
```

The first path is the workspace-scoped user-state location used by Desktop. `DEEP_MIX_HOME` changes the `~/.deep-mix` root. For compatibility, the runtime can still read `<workspace>/.deep-mix/api-key-library/profiles.local.json`, `DEEP_MIX_API_KEY_LIBRARY_ROOT`, and ancestor libraries, but newly saved credentials go to user-level state. Normal tools never receive the secret-bearing profile DTO.

The default profile names are:

| Name | Classic slot | Purpose |
| --- | --- | --- |
| `deepseek_governor` | `governor` | Classic main conversation and supervision model |
| `glm_coding_worker` | `coding` | Classic complex coding specialist |
| `kimi_vision` | `vision` | Classic image and screenshot specialist |

Start from [`examples/profiles.example.json`](../examples/profiles.example.json). The shape is validated by [`docs/contracts/api-key-library.schema.json`](contracts/api-key-library.schema.json).

Important fields:

| Field | Meaning |
| --- | --- |
| `provider` | Provider identifier; not restricted to the classic providers |
| `protocol` / `adapter` | Request protocol and adapter implementation |
| `allowedSlots` | Slots this profile may serve: `governor`, `coding`, and/or `vision` |
| `capabilities` | Explicit text/image, streaming, tool-calling, structured-output, reasoning, and context-window claims |
| `apiKeyEnvName` | Preferred environment variable containing the secret |
| `apiKey` | Inline local secret; supported but discouraged |
| `baseUrl` | Provider API origin, without the chat path |
| `chatPath` | Usually an OpenAI-compatible chat-completions path |
| `model` | Provider model identifier available to your account |
| `headers` | Static non-secret request headers |
| `requestDefaults` | Provider-specific default request fields |

Environment-referenced example:

```json
{
  "version": 2,
  "revision": 0,
  "profiles": {
    "deepseek_governor": {
      "provider": "deepseek",
      "protocol": "openai_chat_completions",
      "adapter": "deepseek_compat",
      "allowedSlots": ["governor"],
      "capabilities": {
        "textInput": true,
        "imageInput": false,
        "streaming": true,
        "nativeToolCalling": true,
        "structuredOutput": true,
        "reasoning": true,
        "contextWindow": 128000
      },
      "apiKeyEnvName": "DEEPSEEK_API_KEY",
      "baseUrl": "https://api.deepseek.com",
      "chatPath": "/chat/completions",
      "model": "replace-with-a-current-compatible-model",
      "headers": {
        "Content-Type": "application/json"
      },
      "requestDefaults": {}
    }
  }
}
```

The model ecosystem changes faster than Deep-Mix releases. Confirm endpoints, model names, thinking fields, pricing, and context limits in the provider's official documentation.

## Runtime settings

Settings are deep-merged in this order:

1. `%USERPROFILE%/.deep-mix/settings.json`
2. `<workspace>/.deep-mix/settings.json`
3. CLI flags for launch-level values

Project settings override matching user settings. Version 2 settings also carry a monotonic `revision`; writes use compare-and-swap so concurrent Desktop updates fail instead of silently overwriting one another. Version 1 files are readable migration inputs and are never rewritten without an explicit save.

Copy [`examples/settings.example.json`](../examples/settings.example.json) to either settings location. Do not place API keys in a committed project settings file.

### Launch defaults

```json
{
  "version": 2,
  "revision": 0,
  "defaults": {
    "permissionMode": "auto",
    "routeOverride": "governor_direct"
  }
}
```

Valid permission modes are `plan`, `edit`, `auto`, and `danger-full-access`. Public route targets are `governor_direct`, `coding_worker`, and `vision_worker`; legacy route values remain readable. A CLI `--mode` or `--route` value wins for that launch.

### Model slots

The `models` object selects either the `classic` or `custom` preset and binds three slots:

- `governor`: the only conversation owner and supervisor; requires text, streaming, and native tool calling by default;
- `coding`: isolated structured-output worker for bounded coding tasks;
- `vision`: isolated structured-output worker that must also support image input.

Each slot has a primary profile, an ordered fallback list, an explicit fallback policy, optional parameters, and capability requirements. Persisted model overrides are snapshot with every turn/worker dispatch so historical records remain truthful after settings change. Legacy `governor`, `codingWorker`, and `visionWorker` fields and classic profile environment variables are migration-only compatibility inputs.

### Web search

```json
{
  "version": 1,
  "webSearch": {
    "braveApiKey": "local-only-value"
  }
}
```

Prefer the `BRAVE_SEARCH_API_KEY` environment variable. It has priority over project settings, which have priority over user settings. Without a Brave key, the built-in search may use a degraded, keyless fallback and will label that condition in its result.

### Git policy

```json
{
  "version": 1,
  "git": {
    "protectedBranches": ["main", "master"],
    "worktreeRoots": [".deep-mix/worktrees"]
  }
}
```

Protected branches cannot be deleted through the built-in Git tools. Worktree roots restrict where managed linked worktrees may be created relative to the workspace.

### Skills

```json
{
  "version": 1,
  "skills": {
    "enabledSkills": {
      "release-check": true,
      "manual-only": false
    }
  }
}
```

The legacy top-level `enabledSkills` object is accepted for compatibility, but new files should use `skills.enabledSkills`.

### Code intelligence

Local semantic indexing is the only default provider:

```json
{
  "version": 1,
  "codeIntelligence": {
    "defaultSemanticProvider": "local"
  }
}
```

External embeddings require an explicit enabled configuration, endpoint, allowed-host list, declared data boundary, and normal network approval. Do not enable an external provider for private code without reviewing its data policy.

### Experimental managed processes

```json
{
  "version": 1,
  "experimental": {
    "managedProcesses": false
  }
}
```

`start_process`, `process_input`, `process_output`, and `stop_process` are unavailable unless this value is exactly `true`. Enabling them is not equivalent to enabling a sandbox. Read [Security model](security-model.md#managed-background-processes) first.

## MCP servers

Project MCP configuration lives in `.deep-mix/mcp/servers.json`. A safe example is available at [`examples/mcp/servers.example.json`](../examples/mcp/servers.example.json).

v1.1.0 includes GitHub public-read and local Playwright-style adapters. An enabled server still remains subject to runtime tool selection and permission checks. MCP configuration must not contain reusable secrets.

## Target-workspace ignore rule

Deep-Mix writes runtime state to `~/.deep-mix/workspaces/<workspace-id>/` by default and does not create `.deep-mix/` in an ordinary target repository. A project may still intentionally provide explicit settings, Skills, Workflows, MCP configuration, or a legacy profile under `.deep-mix/`; if it does, ignore all non-public state by default:

```gitignore
.deep-mix/
```

If the target intentionally versions project Skills, Workflows, or MCP definitions, use allowlist exceptions and keep every other `.deep-mix` path ignored, following this repository's `.gitignore` pattern.

## Diagnosing configuration

```powershell
npm run probe:model -- --profile deepseek_governor
npm run cli -- --mcp-status
npm run cli -- --list-skills
```

The CLI header also reports profile presence, runtime capabilities, workspace, mode, and route override. Never paste unredacted profile files or `.deep-mix` state into an issue.
