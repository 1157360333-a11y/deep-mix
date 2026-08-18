# Troubleshooting

Start with the exact workspace, command, and first error. Later errors are often consequences of one missing profile, dependency, or capability.

## `Could not find .deep-mix/api-key-library/profiles.local.json`

Create the file from the example in the selected workspace or launch root:

```powershell
New-Item -ItemType Directory -Force .deep-mix\api-key-library | Out-Null
Copy-Item examples\profiles.example.json .deep-mix\api-key-library\profiles.local.json
```

If Deep-Mix operates on a different `--workspace`, either put the protected file there or set `DEEP_MIX_API_KEY_LIBRARY_ROOT` to a trusted directory that contains `.deep-mix/api-key-library/profiles.local.json`.

## Profile exists but `hasKey` is false

Confirm that the environment variable name matches `apiKeyEnvName` and is set in the same process environment that launches npm:

```powershell
$env:DEEPSEEK_API_KEY = "your-key"
npm run probe:model -- --profile deepseek_governor
```

A variable set in another terminal or only in a `.env` file is not automatically loaded.

## Provider returns 401, 403, 404, or model-not-found

- 401/403: verify the key, account, authorization header requirements, and provider balance/permissions.
- 404: verify `baseUrl` and `chatPath` composition.
- model-not-found: update the profile to a model available to the account.
- invalid request fields: remove provider-specific `requestDefaults`, then add them back one at a time.

Provider APIs evolve independently of Deep-Mix. Compare against current official provider documentation.

## Windows workspace path is mangled

PowerShell example:

```powershell
npm run cli -- --workspace C:\work\project
```

Git Bash-safe forms:

```bash
npm run cli -- --workspace 'C:\work\project'
npm run cli -- --workspace C:/work/project
npm run cli -- --workspace /c/work/project
```

Deep-Mix rejects recognizable mangled drive paths instead of silently using an unintended directory.

## `rg` is missing

Repository search can use a fallback chain, and the capability header labels degraded operation. Install ripgrep for the fastest and most predictable search, or continue if the reported fallback is adequate. Do not interpret `rg=missing` by itself as a model failure.

## A task is waiting and no new output appears

Check for:

- a pending approval;
- a blocking structured question;
- a provider request still within its configured timeout;
- a managed process waiting for readiness or input;
- a terminal that fell back from the full TUI.

Use `/status` and `/context`. Press Ctrl+C once to request interruption; repeated force termination may leave an action with unknown external state.

## `start_process` is unavailable

This is the secure v1.1.0 default. Managed background processes are experimental. Prefer a bounded foreground command. If the task genuinely requires a server or watcher, read [Security model](security-model.md#managed-background-processes) and explicitly set:

```json
{
  "version": 1,
  "experimental": {
    "managedProcesses": true
  }
}
```

Restart the runtime after changing settings.

## Resume cannot find a session

Sessions are stored under the original target workspace. Relaunch with the same `--workspace`. If state was deleted, moved, or excluded from a copied repository, the session cannot be reconstructed from Git.

For history-integrity failures, try the latest safe resume boundary or a new session. Do not manually splice JSONL tool messages unless you understand the provider protocol.

## MCP server status is `error` or `disabled`

```powershell
npm run cli -- --workspace C:\path\to\target --mcp-status
```

Validate `.deep-mix/mcp/servers.json` as JSON, confirm the server type is supported, and check local browser/network prerequisites. `disabled` is an intentional configuration state. An MCP tool may also remain unselected when its keywords do not match the current task.

## Electron installation or first Desktop launch stalls while downloading

Electron 43 can install its JavaScript package before the platform binary is present, then fetch that binary when Electron is first required. Check registry/proxy settings, access to the official Electron GitHub Release assets, disk space, TLS interception, and the Electron download cache. Avoid committing a local npm registry or proxy setting to the repository. Retry from a normal shell after network access is restored.

If the dependency tree was manually interrupted or partially deleted, remove only this repository's generated `node_modules` directory and run `npm ci` again. Never delete a broad parent directory.

## `npm audit` differs from release documentation

Audit data changes over time. Run:

```powershell
npm ci
npm audit
npm audit --omit=dev
```

Open an issue with the advisory IDs and dependency path, but do not use `npm audit fix --force` without compatibility testing. Every release's zero-vulnerability statement is a point-in-time result.

## Spreadsheet tests fail after a dependency change

Deep-Mix imports the MUI-maintained ExcelJS fork through the alias name `exceljs`. Run:

```powershell
npx vitest run tests/phase20.spreadsheet-read.test.ts tests/phase20.spreadsheet-write.test.ts --maxWorkers=1 --fileParallelism=false
```

Also verify a clean `npm ls` result. Do not replace the alias with upstream `exceljs@4.4.0` without addressing its obsolete vulnerable dependency chain.

## Desktop window is blank or stale

Stop the dev process, run `npm ci`, then restart `npm run app`. If the production build succeeds but development still fails, capture the main-process and renderer console errors without including secrets or private workspace content.

## A broad test run appears hung

Use the layered commands in [Testing](testing.md). Start with `npm test`, then the relevant integration or platform file. Record the exact last test, process list, timeout, and OS. A timed-out run is not a pass.

## Git shows unexpected `.deep-mix` files

Add `.deep-mix/` to the target repository's ignore rules, or use an allowlist pattern if project Skills/Workflows are intentionally versioned. Before committing:

```powershell
git status --short
git diff --cached --name-status
```

Never stage a profile, session, worker artifact, approval record, checkpoint, or MCP artifact.
