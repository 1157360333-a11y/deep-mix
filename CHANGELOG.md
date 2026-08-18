# Changelog

All notable public changes to Deep-Mix are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow Semantic Versioning.

## [Unreleased]

### Planned

- OS-level containment for managed child processes
- Signed, packaged desktop distributions
- Broader Linux and macOS platform verification

## [1.1.0] - 2026-08-18

### Added

- Configurable `governor`, `coding`, and `vision` model slots with capability manifests, ordered fallbacks, immutable assignment snapshots, and a `classic` compatibility preset
- Provider-neutral OpenAI-compatible model adapter and trusted Profile Service control plane
- User-level workspace state isolation through stable workspace IDs and `DEEP_MIX_HOME`
- Desktop model-profile editor, settings redesign, configurable keyboard shortcuts, slash-command discovery, and improved session/message flows
- Phase 22 verification for model orchestration, profile redaction, migration, capability gates, and workspace isolation

### Changed

- Legacy `ds_direct`, `glm_coding`, and `kimi_vision` route values remain readable, while public semantic targets are now `governor_direct`, `coding_worker`, and `vision_worker`
- Version 1 settings are migrated explicitly to revisioned version 2 model-slot settings; migration previews never rewrite files implicitly
- Runtime state defaults to `~/.deep-mix/workspaces/<workspace-id>/` instead of creating state in target repositories
- Session titles, Desktop layout, attachment handling, worker status, copy controls, and settings feedback were revised
- All workspace package versions are aligned to `1.1.0`

### Security

- Profile DTOs redact credentials, sensitive headers, and URL query data before they reach renderer, logs, telemetry, exports, or errors
- Updated `fast-uri` and `nanoid` to patched releases
- Vendored the reviewed PptxGenJS 4.0.1 runtime bundles without the unused, unpatched `image-size` dependency; presentation images remain limited to bounded in-memory PNG/JPEG input
- Full and production dependency audits report zero known vulnerabilities at release time

## [1.0.0] - 2026-07-26

### Added

- First public source release with a clean Git history
- DeepSeek governor and supervisor runtime
- Isolated GLM coding and Kimi vision worker contracts
- Shared CLI and Electron Desktop runtime
- Permission modes, approval persistence, checkpoints, rollback, and undo
- Local Skills, deterministic Workflows, and MCP boundaries
- Repository, Git, shell, network, document, spreadsheet, presentation, notebook, archive, and quality tools
- Public architecture, configuration, security, testing, contribution, and usage documentation
- Windows CI, dependency audit, CodeQL, and Dependabot configuration

### Changed

- All workspace package versions are aligned to `1.0.0`
- Managed background-process tools are experimental and disabled by default
- Electron, electron-vite, Vite, and related build dependencies are upgraded for the public release
- Spreadsheet support uses the maintained MIT-licensed MUI ExcelJS fork through an npm alias

### Security

- Local runtime state and API-key profiles are excluded from version control
- Production and full dependency audits report zero known vulnerabilities at release time
- Public documentation explicitly states that the permission layer is not an OS sandbox

[Unreleased]: https://github.com/1157360333-a11y/deep-mix/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/1157360333-a11y/deep-mix/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/1157360333-a11y/deep-mix/releases/tag/v1.0.0
