# Testing

Deep-Mix uses TypeScript checks, Vitest suites, Electron/Vite builds, dependency audit, and CI security analysis. Test breadth is split so the normal command stays useful during development.

## Release gate

```powershell
npm ci
npm run verify:release
npm audit
```

`verify:release` runs TypeScript checks, the fast test suite, and the Desktop production build.

## Commands

| Command | Scope |
| --- | --- |
| `npm run check` | Root TypeScript plus Desktop TypeScript |
| `npm test` | Alias for the fast deterministic release test set |
| `npm run test:fast` | Unit, core integration, and selected Desktop tests with one worker |
| `npm run test:integration` | Broad suite excluding platform-heavy phase 17/18 tests |
| `npm run test:platform` | Managed process, quality tool, Git, shell, and platform lifecycle coverage |
| `npm run test:full` | Every Vitest test; slowest and most environment-sensitive |
| `npm run desktop:build` | Electron main/preload/renderer production bundles |
| `npm run audit:production` | Production dependency audit at high severity |
| `npm audit` | Full dependency audit |

Phase-specific scripts remain available for focused diagnosis, for example `npm run verify:phase6`, `npm run verify:phase17`, `npm run verify:phase20`, `npm run verify:phase21`, and `npm run verify:phase22`.

## Why `npm test` is not the entire suite

The complete suite includes process lifecycle, Git worktree, shell behavior, browser/document capabilities, and long-running recovery cases. Running all of them on every edit is slow and can be sensitive to host tools. `npm test` is a stable inner-loop gate; it does not replace integration/platform testing for relevant changes.

## Choosing tests by risk

- Parser, settings, routing, or pure schema change: focused unit test, `npm run check`, then `npm test`.
- Governor, persistence, approvals, or tool selection: focused integration test plus `test:integration`.
- Shell, process, Git, filesystem boundary, or network change: `test:platform` on the supported OS.
- Document or spreadsheet change: phase 20 format-specific tests and production bundle verification.
- Security boundary change: phase 21 tests, full audit, and explicit review of failure-closed behavior.
- Model profile, slot binding, capability, fallback, or settings migration change: phase 22 plus redaction and workspace-isolation coverage.
- Desktop UI/IPC change: Desktop unit tests, `npm run check`, and `npm run desktop:build`.

## Clean-install verification

Before a release, validate the lock file from a clean dependency tree:

```powershell
npm ci
npm ls --all
npm audit
```

Do not use `npm audit fix --force` as an automated release step. Review dependency and lock-file changes intentionally, then run the document/spreadsheet tests when replacing format libraries.

## Tests that need credentials

The normal release gate does not require live provider keys. Model probes and evaluation scripts are separate:

```powershell
npm run probe:model -- --profile deepseek_governor
npm run eval:phase7
```

Live probes can cost money and send their prompt to a provider. Never run them in untrusted CI or with production credentials.

## CI

The main CI workflow runs on Windows with Node.js 22 and performs clean install, check, fast tests, build, and audit. CodeQL and Dependabot provide additional signals. A green CI result is required for release but is not proof of sandboxing or absence of vulnerabilities.

## Reporting results

For a pull request or release, report the exact command, OS/Node version when relevant, exit result, and any skipped suite. Do not summarize a timed-out or hung test as passed.
