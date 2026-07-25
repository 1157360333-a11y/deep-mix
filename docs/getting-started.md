# Getting started

This guide takes a clean checkout to a first local Deep-Mix task. Commands use PowerShell because Windows is the primary verified environment.

## 1. Prerequisites

- Windows 10 or 11
- Node.js 22.12 or newer
- npm 10 or newer
- Git
- a DeepSeek-compatible API key and current model name

Optional workers require their own GLM- and Kimi-compatible endpoints and credentials. They are not required for a first governor-only task.

Confirm the toolchain:

```powershell
node --version
npm --version
git --version
```

## 2. Clone and install

```powershell
git clone https://github.com/1157360333-a11y/deep-mix.git
cd deep-mix
npm ci
```

Use `npm ci` for a reproducible install. Use `npm install` only when intentionally changing dependencies.

## 3. Create a local provider profile

Create the protected local directory and copy the example:

```powershell
New-Item -ItemType Directory -Force .deep-mix\api-key-library | Out-Null
Copy-Item examples\profiles.example.json .deep-mix\api-key-library\profiles.local.json
```

The example configures the required `deepseek_governor` profile and includes disabled-by-placeholder worker profiles. Its DeepSeek model name reflects the public provider documentation at the v1.0.0 release date; model availability changes, so verify it against the [official DeepSeek API documentation](https://api-docs.deepseek.com/) for your account.

Set the referenced environment variable for the current PowerShell session:

```powershell
$env:DEEPSEEK_API_KEY = "your-key"
```

Do not add a real key to the example or to a committed JSON file. `profiles.local.json` is ignored by this repository, but any separate target workspace also needs an appropriate ignore rule for its own `.deep-mix/` runtime state.

## 4. Verify the governor connection

Run the probe from the Deep-Mix repository root:

```powershell
npm run probe:model -- --profile deepseek_governor
```

A successful result contains `"ok": true`. A 401/403 response normally means the key or account is invalid; a 404/model error normally means the model or endpoint is not available to the account.

## 5. Start the CLI

Point Deep-Mix at a repository you are willing to inspect:

```powershell
npm run cli -- --workspace C:\path\to\your-project --mode plan
```

Start with a read-only request:

```text
Explain this repository's structure and list the commands I should run before changing it.
```

Once the result looks correct, restart in `auto` mode for normal approval behavior:

```powershell
npm run cli -- --workspace C:\path\to\your-project --mode auto
```

You can also pass the first request on launch:

```powershell
npm run cli -- --workspace C:\path\to\your-project --mode auto --prompt "Find the smallest safe fix for the failing unit test"
```

Use `npm run cli -- --help` for all launch flags. Help and version output do not initialize a provider connection.

## 6. Start the Desktop app

```powershell
npm run app
```

Create a task, choose the target project directory, select a permission mode, and send the first prompt. Desktop and CLI share the same session store and permission behavior for a given workspace.

The repository currently ships source only. `npm run app` starts the development application; no signed installer is included in v1.0.0.

## 7. Configure optional workers

To use GLM coding or Kimi vision routing:

1. replace the `api.example.invalid` endpoint and placeholder model in `profiles.local.json`;
2. set `GLM_API_KEY` or `KIMI_API_KEY`;
3. probe the profile;
4. force the route once to validate it.

```powershell
$env:GLM_API_KEY = "your-key"
npm run probe:model -- --profile glm_coding_worker
npm run cli -- --workspace C:\path\to\your-project --route glm_coding --mode plan --prompt "Review this repository architecture"
```

The worker remains isolated even when the route is forced. It returns an artifact to the governor and cannot write the workspace directly.

## 8. Validate the checkout

```powershell
npm run check
npm test
npm run desktop:build
npm audit
```

See [Testing](testing.md) before running the much broader integration and platform suites.

## 9. Next steps

- Follow the [first task walkthrough](first-task-walkthrough.md).
- Learn session and approval commands in the [CLI guide](cli-guide.md).
- Review all settings in [Configuration](configuration.md).
- Read the [Security model](security-model.md) before approving commands or enabling managed processes.
