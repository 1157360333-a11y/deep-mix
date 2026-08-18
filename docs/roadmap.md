# Roadmap

This roadmap describes engineering priorities after v1.1.0. It is not a release-date promise and does not expand the guarantees of the current version.

## Guiding principles

- Keep one accountable governor.
- Preserve worker isolation and typed artifacts.
- Route every side effect through the permissioned runtime.
- Prefer local, inspectable state and explicit data boundaries.
- Make limitations visible rather than hiding them behind optimistic UI.
- Add a capability only with failure-closed tests and documentation.

## Highest-priority work

### OS-level process containment

Introduce platform adapters for Windows Job Objects and appropriate Linux/macOS containment, descendant tracking, resource budgets, and verified teardown. Managed background processes remain experimental until containment has adversarial tests.

### Signed desktop distribution

Add repeatable packaging, code signing, checksums, provenance, release automation, update policy, and installer testing. The source repository must remain usable without a packaged build.

### Cross-platform verification

Run core and platform suites on Linux and macOS, document capability differences, and remove Windows-only assumptions where safe. Platform-specific tools should report unavailable rather than fail unpredictably.

### Public contract migrations

Version settings, session state, worker artifacts, and workflow contracts with explicit migration and compatibility tests before making breaking changes.

## Runtime improvements

- More precise per-turn tool selection and schema-token accounting
- Stronger prompt-injection provenance and external-content labeling
- Better resumability for interrupted external calls
- Structured diff review and patch provenance in both interfaces
- Expanded local code-intelligence adapters without overstating reference precision
- Configurable retention and redaction for sessions and artifacts
- Improved Desktop accessibility, keyboard navigation, and diagnostics

## Extension ecosystem

- Schema-backed validation and authoring tools for Skills and Workflows
- Additional MCP transports and authenticated connectors with explicit secret stores
- Versioned community extension compatibility policy
- Extension trust metadata, signatures, or provenance where practical

## Release engineering

- Reproducible SBOM and license inventory
- Automated secret scanning and artifact attestation
- Performance budgets for install, startup, context compilation, and large repositories
- Stable end-to-end fixtures that avoid live paid providers

## Explicit non-commitments

Deep-Mix does not currently promise cloud hosting, team synchronization, a plugin marketplace, autonomous deployment, or support for every model provider. Any such feature must preserve the security and governance invariants before it enters a release.
