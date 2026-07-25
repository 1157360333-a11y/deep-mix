# First task walkthrough

This walkthrough uses a low-risk repository review before allowing any change. Replace the example path with a small test repository or a disposable clone.

## 1. Protect the target repository

Check its Git state yourself:

```powershell
Set-Location C:\path\to\sample-project
git status --short --branch
```

Do not begin with an important dirty worktree. Deep-Mix preserves unrelated changes by design, but an initial clean or intentionally understood state makes review and rollback easier.

Add `.deep-mix/` to the target repository's `.gitignore` unless the repository deliberately versions allowlisted Skills, Workflows, or MCP files.

## 2. Start in plan mode

From the Deep-Mix source directory:

```powershell
npm run cli -- --workspace C:\path\to\sample-project --mode plan
```

Ask:

```text
Inspect this repository without changing it. Explain its purpose, identify the main entry points, and list the exact verification commands supported by the repository.
```

Review the answer against actual files. Useful checks include:

- did it read repository instructions such as `AGENTS.md`?
- are claimed commands present in package or build files?
- did it distinguish facts from suggestions?
- did it avoid claiming that a command was run when it was only discovered?

Use `/tools latest` to expand the most recent grouped tool round and `/status` to confirm mode and workspace.

## 3. Request a bounded implementation

Exit with `/exit`, then restart in normal approval mode:

```powershell
npm run cli -- --workspace C:\path\to\sample-project --mode auto
```

Use a narrowly testable task:

```text
Add one unit test for the existing empty-input behavior. Do not change production behavior. Run only the smallest relevant test first, then report the diff and result.
```

When an approval appears, inspect:

- the exact tool name;
- target path or command;
- whether the operation matches the request;
- whether “allow once” is sufficient.

Deny any action whose scope is unclear. A denial is a normal control-path result, not a runtime failure.

## 4. Review the result

After the turn:

```powershell
Set-Location C:\path\to\sample-project
git status --short
git diff --check
git diff
```

Confirm that only intended files changed and that the reported test actually passed. Deep-Mix does not automatically authorize a commit, push, deployment, or issue update unless the task explicitly asks for that action and the permission flow allows it.

## 5. Exercise recovery

If the change used a checkpoint-capable write tool, run:

```text
/undo
```

Then inspect the Git diff again. Undo is scoped to recorded checkpoints; it cannot reverse arbitrary external effects or every shell command.

## 6. Resume the session

Exit safely:

```text
/exit
```

Resume later:

```powershell
npm run cli -- --workspace C:\path\to\sample-project --resume
```

Use `/session` to display the current ID and `/export` to create a local Markdown transcript. Review an export before sharing it: it may contain repository content, absolute paths, prompts, and model output.

## What this demonstrates

The exercise covers the intended control loop: inspect in `plan`, move to `auto`, approve a bounded mutation, verify outside the agent, use checkpoint recovery, and resume durable state. It does not demonstrate OS isolation or make arbitrary command execution safe.
