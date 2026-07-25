# Configuration

Deep-Mix has three configuration layers: provider profiles, runtime settings, and launch flags. Secrets and normal preferences deliberately use different files.

## Provider profiles

Provider connections are defined in:

```text
<workspace>/.deep-mix/api-key-library/profiles.local.json
```

The runtime searches the selected workspace first, then an optional root configured by `DEEP_MIX_API_KEY_LIBRARY_ROOT`, then `.deep-mix/api-key-library/profiles.local.json` in ancestors of the current launch directory. Keep the search behavior simple in production: place one protected profile file in the workspace you launch from, or set an explicit library root.

The default profile names are:

| Name | Required role | Purpose |
| --- | --- | --- |
| `deepseek_governor` | `governor` | Required main conversation and supervision model |
| `glm_coding_worker` | `coding_worker` | Optional complex coding specialist |
| `kimi_vision` | `vision_worker` | Optional image and screenshot specialist |

Start from [`examples/profiles.example.json`](../examples/profiles.example.json). The shape is validated by [`docs/contracts/api-key-library.schema.json`](contracts/api-key-library.schema.json).

Important fields:

| Field | Meaning |
| --- | --- |
| `provider` | `deepseek`, `glm`, or `kimi` |
| `role` | Must match the profile's runtime role |
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
  "version": 1,
  "profiles": {
    "deepseek_governor": {
      "provider": "deepseek",
      "role": "governor",
      "apiKeyEnvName": "DEEPSEEK_API_KEY",
      "baseUrl": "https://api.deepseek.com",
      "chatPath": "/chat/completions",
      "model": "deepseek-v4-flash",
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

Project settings override matching user settings. A project file can therefore change one nested value without repeating the entire user configuration.

Copy [`examples/settings.example.json`](../examples/settings.example.json) to either settings location. Do not place API keys in a committed project settings file.

### Launch defaults

```json
{
  "version": 1,
  "defaults": {
    "permissionMode": "auto",
    "routeOverride": "ds_direct"
  }
}
```

Valid permission modes are `plan`, `edit`, `auto`, and `danger-full-access`. Valid route overrides are `ds_direct`, `glm_coding`, and `kimi_vision`. A CLI `--mode` or `--route` value wins for that launch.

### Governor settings

The `governor` object supports:

- `profile`, `model`, and `stream`;
- `contextWindow`, soft/compact/reserve budgets, and summary/tail limits;
- `timeoutMs`, `maxRetries`, and `temperature`;
- `thinkingMode`: `disabled`, `enabled`, or `adaptive`;
- `reasoningEffort`: `low`, `medium`, `high`, or `not_applicable`;
- `replyStyle`: `pragmatic` or `friendly`.

Provider-specific environment variables such as `DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_TIMEOUT_MS`, `DEEPSEEK_THINKING_MODE`, and `DEEPSEEK_REASONING_EFFORT` override the corresponding governor values where supported.

### Worker settings

`codingWorker` supports profile/model selection, context and timeout limits, retry/temperature settings, and maximum context files/characters. `visionWorker` supports profile/model selection, context/timeout limits, and image byte/dimension normalization limits.

Explicit profile environment variables are `DEEPSEEK_GOVERNOR_PROFILE`, `GLM_CODING_WORKER_PROFILE`, and `KIMI_VISION_WORKER_PROFILE`.

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

v1.0.0 includes GitHub public-read and local Playwright-style adapters. An enabled server still remains subject to runtime tool selection and permission checks. MCP configuration must not contain reusable secrets.

## Target-workspace ignore rule

Deep-Mix writes local state inside the selected target workspace. If that repository does not already ignore it, add at least:

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
