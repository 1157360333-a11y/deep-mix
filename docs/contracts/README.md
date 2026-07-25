# Runtime contracts

This directory publishes the principal cross-component contracts frozen for Deep-Mix v1.0.0.

- `worker-task.schema.json`: bounded task sent to a specialist worker
- `worker-artifact.schema.json`: structured worker result and artifact references
- `route-profile.schema.json`: governor routing capabilities and constraints
- `checkpoint-record.schema.json`: reversible mutation checkpoint metadata
- `supervisor-decision.schema.json`: governor review decision
- `supervisor-decision-state-machine.md`: legal supervisor-decision transitions
- `api-key-library.schema.json`: local provider-profile file shape

Large patches, images, logs, and binary data do not belong inline in these records; contracts reference separately persisted artifacts. The schemas document public boundaries, while `packages/shared-schema` is the executable TypeScript source of truth.
