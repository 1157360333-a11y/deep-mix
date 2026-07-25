# Contributing to Deep-Mix

Thanks for improving Deep-Mix. Small, reviewable changes with explicit tests are easiest to accept.

## Before opening a change

1. Search existing issues and pull requests.
2. Read [`AGENTS.md`](AGENTS.md), the [architecture](docs/deep-mix-architecture.md), and the [security model](docs/security-model.md).
3. For behavior changes, open an issue first when the architecture or public contract may change.
4. Never include provider keys, local sessions, worker artifacts, private evaluation data, or personal filesystem paths.

## Development setup

```powershell
git clone https://github.com/1157360333-a11y/deep-mix.git
cd deep-mix
npm ci
npm run check
npm test
```

Node.js `22.12+` and npm `10+` are required. The primary verified development environment is Windows with PowerShell.

## Architecture rules

- DeepSeek remains the only governor and supervisor.
- GLM and Kimi are isolated workers and return structured artifacts; they do not write the workspace directly.
- File writes, commands, tests, Git operations, and MCP calls go through the Tool Runtime and Permission Layer.
- Long-lived repository rules belong in `AGENTS.md`.
- Reusable guidance belongs in a `SKILL.md`.
- Deterministic multi-step orchestration belongs in a workflow file.
- Never weaken protected-path, approval, checkpoint, or artifact-boundary behavior to make a test pass.

## Tests

Run the smallest relevant tests while developing, then the release gate before submitting:

```powershell
npm run check
npm test
npm run desktop:build
npm audit
```

Use `npm run test:integration` for cross-package behavior and `npm run test:platform` when changing process, shell, Git, or platform-specific code. Document any test that cannot run in your environment.

## Pull requests

- Use a focused title and explain the user-visible outcome first.
- Link the issue or explain why no issue is needed.
- List security-boundary changes explicitly.
- Include tests and documentation for public behavior.
- Keep generated files and unrelated formatting out of the change.
- Confirm that no secrets or personal paths were added.

Contributions are accepted under the repository's Apache-2.0 license.
