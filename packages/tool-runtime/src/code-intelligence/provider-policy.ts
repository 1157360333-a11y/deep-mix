import type {
  DeepMixSettings,
  ToolAccessRequest,
} from "../../../shared-schema/src/index.js";

export type SemanticProviderMode = "local" | "external";

export interface LocalSemanticProviderPolicy {
  mode: "local";
  localOnly: true;
  dataBoundary: "local_only";
  approvalRequired: false;
  accessRequests: readonly [];
}

export interface ExternalSemanticProviderPolicy {
  mode: "external";
  localOnly: false;
  dataBoundary: "approved_external_snippets";
  declaredDataBoundary: string;
  provider: string;
  endpoint: string;
  host: string;
  approvalRequired: true;
  accessRequests: readonly [ToolAccessRequest];
}

export type SemanticProviderPolicy =
  | LocalSemanticProviderPolicy
  | ExternalSemanticProviderPolicy;

export class ExternalSemanticProviderPolicyError extends Error {
  public readonly code:
    | "external_provider_disabled"
    | "external_provider_invalid";

  public constructor(
    code: ExternalSemanticProviderPolicyError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ExternalSemanticProviderPolicyError";
    this.code = code;
  }
}

function requiredText(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ExternalSemanticProviderPolicyError(
      "external_provider_invalid",
      `External semantic provider ${field} must be a non-empty string.`,
    );
  }
  const normalized = value.trim();
  if (normalized.length > maxChars) {
    throw new ExternalSemanticProviderPolicyError(
      "external_provider_invalid",
      `External semantic provider ${field} exceeds ${maxChars} characters.`,
    );
  }
  return normalized;
}

function normalizeAllowedHosts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ExternalSemanticProviderPolicyError(
      "external_provider_invalid",
      "External semantic provider allowedHosts must explicitly list at least one host.",
    );
  }
  const hosts = new Set<string>();
  for (const entry of value) {
    const host = requiredText(entry, "allowedHosts entry", 253).toLocaleLowerCase("en-US");
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u.test(host)) {
      throw new ExternalSemanticProviderPolicyError(
        "external_provider_invalid",
        "External semantic provider allowedHosts entries must be exact DNS hostnames without wildcards, paths, or ports.",
      );
    }
    hosts.add(host);
  }
  return [...hosts].sort();
}

export function resolveSemanticProviderPolicy(input: {
  requestedProvider?: SemanticProviderMode;
  settings: DeepMixSettings;
}): SemanticProviderPolicy {
  if ((input.requestedProvider ?? "local") === "local") {
    return {
      mode: "local",
      localOnly: true,
      dataBoundary: "local_only",
      approvalRequired: false,
      accessRequests: [],
    };
  }

  const configured = input.settings.codeIntelligence?.externalEmbedding;
  if (!configured?.enabled) {
    throw new ExternalSemanticProviderPolicyError(
      "external_provider_disabled",
      "External semantic search is disabled; local indexing remains the only default.",
    );
  }
  const provider = requiredText(configured.provider, "provider", 120);
  const endpointValue = requiredText(configured.endpoint, "endpoint", 2_048);
  const declaredDataBoundary = requiredText(configured.dataBoundary, "dataBoundary", 1_000);
  const allowedHosts = normalizeAllowedHosts(configured.allowedHosts);
  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new ExternalSemanticProviderPolicyError(
      "external_provider_invalid",
      "External semantic provider endpoint must be a valid HTTPS URL.",
    );
  }
  const host = endpoint.hostname.toLocaleLowerCase("en-US");
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !allowedHosts.includes(host)
  ) {
    throw new ExternalSemanticProviderPolicyError(
      "external_provider_invalid",
      "External semantic provider endpoint must be credential-free HTTPS and its exact host must appear in allowedHosts.",
    );
  }

  return {
    mode: "external",
    localOnly: false,
    dataBoundary: "approved_external_snippets",
    declaredDataBoundary,
    provider,
    endpoint: endpoint.toString(),
    host,
    approvalRequired: true,
    accessRequests: [{
      kind: "network_access",
      hosts: [host],
      reason: `Explicitly approved external semantic provider ${provider}; data boundary: ${declaredDataBoundary}`,
    }],
  };
}
