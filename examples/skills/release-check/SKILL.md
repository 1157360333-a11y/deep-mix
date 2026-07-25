---
name: release-check
description: Prepare a local release checklist. Use when the user asks to verify a release candidate.
metadata:
  allow-implicit-invocation: true
---

# Release check

1. Read the repository's contribution and release documentation.
2. Confirm the intended version and exact change scope.
3. Run the repository's documented type, test, build, and security checks.
4. Inspect the Git diff for secrets, generated state, and unrelated changes.
5. Report passed checks, failures, and known limitations before any Git publication step.
