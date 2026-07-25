# Changelog

All notable public changes to Deep-Mix are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow Semantic Versioning.

## [Unreleased]

### Planned

- OS-level containment for managed child processes
- Signed, packaged desktop distributions
- Broader Linux and macOS platform verification

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

[Unreleased]: https://github.com/1157360333-a11y/deep-mix/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/1157360333-a11y/deep-mix/releases/tag/v1.0.0
