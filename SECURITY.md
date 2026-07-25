# Security Policy

## Supported versions

Security fixes are applied to the latest tagged release and the `main` branch.

| Version | Supported |
| --- | --- |
| 1.x | Yes |
| Pre-1.0 snapshots | No |

## Reporting a vulnerability

Please use GitHub's private **Report a vulnerability** flow in the repository's Security tab. If private reporting is unavailable, contact the maintainer through the GitHub profile before sharing exploit details. Do not publish API keys, private repository contents, proof-of-concept payloads, or active exploitation details in a public issue.

Include:

- affected version or commit;
- operating system and Node.js version;
- affected trust boundary or tool;
- minimal reproduction steps;
- expected impact and any known mitigation.

You should receive an acknowledgement within seven days. Remediation timing depends on severity and reproducibility. A coordinated disclosure date will be agreed before public details are released.

## Security assumptions

Deep-Mix is a local developer tool, not a hardened sandbox. It inherits the current user's operating-system privileges. Model output, repository content, attachments, MCP responses, web content, and worker artifacts must all be treated as untrusted input.

The permission layer reduces accidental or unauthorized use of registered tools; it does not contain arbitrary code after execution is approved. Managed background processes are experimental and disabled by default. See [`docs/security-model.md`](docs/security-model.md) for the full threat model and limitations.

## Secrets

- Keep provider credentials in environment variables referenced by `apiKeyEnvName`.
- Never commit `.deep-mix/api-key-library/profiles.local.json`.
- Rotate a key immediately if it appears in Git history, logs, screenshots, issues, or chat transcripts.
- Do not attach `.deep-mix/sessions`, worker artifacts, or approval records to public reports without redaction.
