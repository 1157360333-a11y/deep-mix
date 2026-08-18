import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ConversationMessage,
  ContextBudgetSnapshot,
  ContextCompactionRecord,
  ContextSummaryRecord,
  HistoryIntegrityAction,
  HistoryIntegrityIssue,
  McpServerStatus,
  MessageRecord,
  PlanItem,
  RuntimeCapabilitySnapshot,
  RoutingDecision,
  ReplyStyle,
  SkillMatch,
  SkillRecord,
  ToolDefinition,
  WorkflowDefinition,
} from "../../shared-schema/src/index.js";
import { estimateMessageRecordTokens, estimateTextTokens, estimateToolDefinitionTokens } from "./context-usage.js";
import { renderPlanItems } from "./plan-engine.js";
import {
  isPostExposureToolSummaryEligible,
  prepareMessagesForModel,
  PROVIDER_TURN_CONTEXT_METADATA_KEY,
} from "./history-integrity.js";

export interface PromptCompileInput {
  workspaceRoot: string;
  currentUserRequest: string;
  planItems: PlanItem[];
  toolDefinitions: ToolDefinition[];
  recentMessages: MessageRecord[];
  contextSummaries?: ContextSummaryRecord[];
  routingDecision?: RoutingDecision;
  runtimeCapabilities?: RuntimeCapabilitySnapshot;
  availableSkills?: SkillRecord[];
  matchedSkills?: SkillMatch[];
  availableWorkflows?: WorkflowDefinition[];
  mcpStatuses?: McpServerStatus[];
  extensionErrors?: {
    skills?: string[];
    workflows?: string[];
    mcp?: string[];
  };
}

export interface PromptCompileOutput {
  systemPrompt: string;
  turnContext: string;
  providerContextMessages: ConversationMessage[];
  truncatedMessages: MessageRecord[];
  historyReport: {
    outcome: "clean" | "auto_repaired" | "fallback_to_safe_boundary" | "blocked";
    summary: string;
    messageCountBefore: number;
    messageCountAfter: number;
    safeBoundaryTurnId?: string;
    issues: HistoryIntegrityIssue[];
    actions: HistoryIntegrityAction[];
  };
  contextBudget: ContextBudgetSnapshot;
  compaction: ContextCompactionRecord;
  selectedSummaryIds: string[];
}

function isProviderTurnContextMessage(message: MessageRecord): boolean {
  const marker = message.metadata?.[PROVIDER_TURN_CONTEXT_METADATA_KEY];
  return marker === true || (
    typeof marker === "object" &&
    marker !== null &&
    (marker as { version?: unknown }).version === 1
  );
}

export interface PromptCompilerOptions {
  model: string;
  contextWindow: number;
  softLimitTokens: number;
  compactThresholdTokens: number;
  reserveOutputTokens: number;
  summaryMaxTokens: number;
  recentTailMaxTokens: number;
  legacyMaxMessages?: number;
  legacyMaxChars?: number;
  replyStyle?: ReplyStyle;
}

interface SummarySelectionResult {
  selected: ContextSummaryRecord[];
  tokens: number;
}

function now(): string {
  return new Date().toISOString();
}

function formatRoutingDecision(decision: RoutingDecision | undefined): string {
  if (!decision) {
    return "No routing decision recorded for this turn.";
  }

  return [
    `mode=${decision.mode}`,
    `automaticTarget=${decision.automaticTarget}`,
    `finalTarget=${decision.finalTarget}`,
    decision.overrideTarget ? `overrideTarget=${decision.overrideTarget}` : undefined,
    `ruleId=${decision.ruleId}`,
    `reasons=${decision.reasonCodes.join(", ") || "none"}`,
    `summary=${decision.reasonSummary}`,
    `features=${JSON.stringify(decision.features)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatHistoryReport(report: PromptCompileOutput["historyReport"]): string {
  const lines = [
    `outcome=${report.outcome}`,
    `summary=${report.summary}`,
  ];
  if (report.safeBoundaryTurnId) {
    lines.push(`safeBoundaryTurnId=${report.safeBoundaryTurnId}`);
  }
  return lines.join("\n");
}

export function formatReplyStyleRules(style: ReplyStyle = "pragmatic"): string {
  if (style === "friendly") {
    return [
      "Use a warm, collaborative, and considerate tone while remaining technically precise.",
      "Prefer natural language and helpful transitions; concise encouragement is acceptable when it is genuine.",
      "Emoji are optional and must be used sparingly, never as decorative headings or repeated status markers.",
    ].join("\n");
  }
  return [
    "Use a pragmatic, restrained, and rigorous professional tone.",
    "Lead with the outcome, stay concise and direct, and avoid performative enthusiasm.",
    "Do not use emoji, emoticons, or decorative symbols in headings, summaries, status updates, or conclusions.",
  ].join("\n");
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 16)}\n...[truncated]`;
}

function formatAvailableSkills(skills: SkillRecord[] | undefined): string {
  if (!skills || skills.length === 0) {
    return "No skills discovered.";
  }

  return skills
    .map(
      (skill) =>
        `- ${skill.name} [${skill.enabled ? "enabled" : "disabled"}] allowImplicit=${String(skill.allowImplicitInvocation)} source=${skill.sourceScope}\n  ${skill.description}`,
    )
    .join("\n");
}

function formatMatchedSkills(matches: SkillMatch[] | undefined): string {
  if (!matches || matches.length === 0) {
    return "No skills matched this request.";
  }

  return matches
    .map((match) =>
      [
        `### ${match.skill.name}`,
        `score=${match.score}`,
        `reasons=${match.reasons.join("; ") || "none"}`,
        truncate(match.skill.body, 2400),
      ].join("\n"),
    )
    .join("\n\n");
}

function formatWorkflowCatalog(workflows: WorkflowDefinition[] | undefined): string {
  if (!workflows || workflows.length === 0) {
    return "No workflows discovered.";
  }

  return workflows
    .map(
      (workflow) =>
        `- ${workflow.name} source=${workflow.sourceScope} steps=${workflow.steps.length}\n  ${workflow.description}`,
    )
    .join("\n");
}

function formatMcpStatuses(statuses: McpServerStatus[] | undefined): string {
  if (!statuses || statuses.length === 0) {
    return "No MCP servers configured or healthy.";
  }

  return statuses
    .map(
      (status) =>
        `- ${status.name} type=${status.type} state=${status.state} enabled=${String(status.enabled)} tools=${status.toolCount}${
          status.error ? ` error=${status.error}` : ""
        }`,
    )
    .join("\n");
}

function formatExtensionErrors(errors: PromptCompileInput["extensionErrors"]): string {
  const blocks: string[] = [];
  if (errors?.skills?.length) {
    blocks.push(`skills: ${errors.skills.join(" | ")}`);
  }
  if (errors?.workflows?.length) {
    blocks.push(`workflows: ${errors.workflows.join(" | ")}`);
  }
  if (errors?.mcp?.length) {
    blocks.push(`mcp: ${errors.mcp.join(" | ")}`);
  }
  return blocks.length > 0 ? blocks.join("\n") : "No extension loader errors.";
}

function formatRuntimeCapabilities(snapshot: RuntimeCapabilitySnapshot | undefined): string {
  if (!snapshot) {
    return "No runtime capability snapshot recorded.";
  }

  const lines = [
    `checkedAt=${snapshot.checkedAt}`,
    `fallbacks=list_files:${snapshot.fallbacks.listFiles}, search_files:${snapshot.fallbacks.searchFiles}`,
  ];
  for (const [name, capability] of Object.entries(snapshot.capabilities)) {
    lines.push(
      `- ${name} available=${String(capability.available)} command=${capability.command}${
        capability.version ? ` version=${capability.version}` : ""
      }${capability.errorType ? ` errorType=${capability.errorType}` : ""} message=${capability.message}`,
    );
  }
  return lines.join("\n");
}

function formatContextSummaries(summaries: ContextSummaryRecord[]): string {
  if (summaries.length === 0) {
    return "No compressed context summaries selected for this request.";
  }

  return summaries
    .map((summary) => {
      const ref = summary.summaryId.slice(0, 8);
      const tool = summary.sourceToolName ? `${summary.sourceToolName} ` : "";
      const pathHints = summary.keyPaths?.slice(0, 3).join(", ");
      const commandHint = summary.command ? ` command=${summary.command}` : "";
      const pathLine = pathHints ? ` paths=${pathHints}` : "";
      return `- [${ref}] ${tool}${summary.summary}${pathLine}${commandHint}`;
    })
    .join("\n");
}

function selectContextSummaries(
  summaries: ContextSummaryRecord[] | undefined,
  budgetTokens: number,
  options: {
    excludedSummaryIds: Set<string>;
    presentMessageIds?: Set<string>;
    presentToolCallIds?: Set<string>;
  },
): SummarySelectionResult {
  if (!summaries || summaries.length === 0 || budgetTokens <= 0) {
    return {
      selected: [],
      tokens: 0,
    };
  }

  const selected: ContextSummaryRecord[] = [];
  let usedTokens = 0;
  for (const summary of [...summaries].sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
    if (options.excludedSummaryIds.has(summary.summaryId)) {
      continue;
    }
    if (summary.sourceType === "tool_output") {
      if (summary.toolOutputLifecycle !== "raw_once_then_summary_v1") {
        continue;
      }
      const sourceStillPresent =
        (summary.sourceMessageId ? options.presentMessageIds?.has(summary.sourceMessageId) : false) ||
        (summary.sourceToolCallId ? options.presentToolCallIds?.has(summary.sourceToolCallId) : false);
      if (sourceStillPresent) {
        continue;
      }
      if (!isPostExposureToolSummaryEligible(summary.sourceToolName, summary.sourceRawChars ?? 0)) {
        // Legacy records used to summarize nearly every tool. Do not inject
        // those records as standalone context now that raw retention is the
        // default, and do not duplicate a tool result already in history.
        continue;
      }
    }
    const entryTokens = estimateTextTokens(formatContextSummaries([summary]));
    if (usedTokens > 0 && usedTokens + entryTokens > budgetTokens) {
      continue;
    }
    if (entryTokens > budgetTokens) {
      continue;
    }
    selected.push(summary);
    usedTokens += entryTokens;
  }

  return {
    selected: selected.reverse(),
    tokens: usedTokens,
  };
}

async function readAgentsRules(workspaceRoot: string): Promise<string> {
  const agentsPath = path.join(workspaceRoot, "AGENTS.md");
  try {
    return await fs.readFile(agentsPath, "utf8");
  } catch {
    return "No AGENTS.md found.";
  }
}

export class PromptCompiler {
  private readonly options: PromptCompilerOptions;

  public constructor(options: PromptCompilerOptions) {
    this.options = options;
  }

  public async compile(input: PromptCompileInput): Promise<PromptCompileOutput> {
    const repoRules = await readAgentsRules(input.workspaceRoot);
    const baseBlocks = [
      "## System Rules",
      [
        "You are the Deep-Mix Governor and Supervisor, the runtime's only orchestration bus.",
        "Use tools through the runtime instead of claiming filesystem changes without tool output.",
        "Honor the recorded routing decision for this turn unless a later fallback record changes it.",
        "Use invoke_coding_worker for complex backend, cross-file, or refactor-heavy coding tasks.",
        "Use invoke_vision_worker for OCR, UI parsing, error screenshot analysis, or diagram parsing tasks that depend on image understanding.",
        "Do not dump whole-repository content into invoke_coding_worker; pass only the necessary file or summary refs.",
        "Do not dump raw binary content into invoke_vision_worker; pass only the necessary image ref plus short instructions.",
        "The coding worker is isolated and returns the complete structured CodeArtifact record plus its patch reference; it never writes workspace files directly.",
        "The vision worker is isolated and returns the complete structured VisionArtifact record plus all artifact references; it never writes workspace files directly.",
        "The main session should continue with normal runtime tools after worker results when verification or follow-up edits are needed.",
        "Post-edit diagnostics now include LSP, lint, and typecheck feedback inside tool results.",
        "For an existing text file, use apply_patch action=replace_text with exact oldText/newText anchors and expectedOccurrences. Never send a fragment through upsert: upsert is a complete-file replacement, and each normalized path may appear only once per call.",
        "If an intentional complete-file replacement would remove most existing content, first obtain the current SHA-256 with file_metadata(includeHash=true), then use expectedSha256 plus allowDestructiveReplace=true. A guarded failure also reports the current hash for recovery; ordinary edits must not bypass this safeguard.",
        "When exploring repository structure or reading code, use list_files, search_files, and read_file before run_shell.",
        "For file-name lookup or path-existence checks, use list_files, glob_files, or file_metadata. search_files searches text contents only; a zero-match search_files result never proves that a file path is absent.",
        "Never claim that a file is missing when a listing/search reports truncation, omitted paths, skipped files, or incomplete scope. Narrow the cwd/glob or verify the exact path first.",
        "If list_files or search_files reports fallback active, keep using the built-in fallback path instead of switching to run_shell.",
        "Only consider run_shell after the built-in read/search tools and their fallback chains have both failed.",
        "Use run_shell only for one-shot commands expected to finish within 60 seconds without ongoing stdin or incremental output.",
        "For development servers, watch tasks, listeners, interactive commands, or any command managed across tool calls, use start_process, process_output, process_input, and stop_process as one owned lifecycle; never emulate background execution through run_shell.",
        "Use the structured build, format, test_coverage, and inspect_logs tools for those intents instead of reconstructing their results with run_shell.",
        "When asked which tools exist, call list_tools and distinguish the complete Registry catalog from the smaller Provider tool subset selected for the current turn.",
        "Only invoke tools whose schemas are present in the current Provider request. A tool_not_selected result means only that the schema was omitted for this turn; it does not mean the capability is globally disabled.",
        "A provider-history tool result is shown as authoritative raw output on first consumption. After a durable response or tool-cycle checkpoint it may appear as a stable [summary] that points back to the raw audit message. If omitted details matter, obtain a fresh read-only observation; never repeat a side effect only to recover output text.",
        "Treat the persisted Turn Context message as the turn-start snapshot for the request, routing decision, plan, runtime capabilities, and extensions. Later tool results remain authoritative for newer facts.",
        "Treat the Current Workspace block as authoritative. Use '.' or workspace-relative path/cwd arguments and never reuse an absolute path from another session or workspace.",
        "After a recoverable tool error, correct the arguments or choose another selected tool and keep working. Do not stop merely because one tool call failed.",
        "For change/build/output requests, do not claim completion until the requested workspace file or tool artifact has been created and verified through tool output.",
        "Keep replies concise and factual.",
      ].join("\n"),
      "## Reply Style",
      formatReplyStyleRules(this.options.replyStyle),
      "## Repository Rules",
      repoRules,
      "## Current Workspace",
      `root=${input.workspaceRoot}\nUse '.' or paths relative to this root for tool path and cwd arguments.`,
    ];
    const turnContextBlocks = [
      "## Turn Context",
      "Captured once at turn start. Do not reinterpret this snapshot as a live update after later tool results.",
      "## User Request",
      input.currentUserRequest,
      "## Routing Decision",
      formatRoutingDecision(input.routingDecision),
      "## Plan State",
      renderPlanItems(input.planItems),
      "## Runtime Capabilities",
      formatRuntimeCapabilities(input.runtimeCapabilities),
      "## Available Skills",
      formatAvailableSkills(input.availableSkills),
      "## Loaded Skill Instructions",
      formatMatchedSkills(input.matchedSkills),
      "## Workflow Catalog",
      formatWorkflowCatalog(input.availableWorkflows),
      "## MCP Status",
      formatMcpStatuses(input.mcpStatuses),
      "## Extension Loader Errors",
      formatExtensionErrors(input.extensionErrors),
    ];

    const basePromptText = baseBlocks.join("\n\n");
    const basePromptTokens = estimateTextTokens(basePromptText);
    const toolTokens = estimateToolDefinitionTokens(input.toolDefinitions);

    const inputBudgetTokens = Math.min(
      this.options.contextWindow - this.options.reserveOutputTokens,
      this.options.softLimitTokens,
    );
    const freeAfterFixed = Math.max(0, inputBudgetTokens - basePromptTokens - toolTokens);
    const guaranteedRecentBudget = Math.min(this.options.recentTailMaxTokens, freeAfterFixed);
    const nonToolSummaryDemand = selectContextSummaries(
      input.contextSummaries?.filter((summary) => summary.sourceType !== "tool_output"),
      this.options.summaryMaxTokens,
      { excludedSummaryIds: new Set() },
    ).tokens;
    const summaryBudget = Math.min(
      nonToolSummaryDemand,
      Math.max(0, freeAfterFixed - guaranteedRecentBudget),
    );
    const messageBudget = Math.max(0, freeAfterFixed - summaryBudget);

    const preparedHistory = prepareMessagesForModel(input.recentMessages, {
      tokenBudget: messageBudget,
      maxMessages: this.options.legacyMaxMessages,
      maxChars: this.options.legacyMaxChars,
      contextSummaries: input.contextSummaries,
    });

    const historyReport = preparedHistory.report;
    const turnContext = [
      ...turnContextBlocks,
      "## Initial History Integrity",
      formatHistoryReport(historyReport),
    ].join("\n\n");
    const adjustedFree = Math.max(
      0,
      inputBudgetTokens - basePromptTokens - toolTokens - preparedHistory.estimatedTokensAfter,
    );
    const adjustedSummaryBudget = Math.min(this.options.summaryMaxTokens, adjustedFree);

    const selectedSummaryIds = new Set(preparedHistory.usedSummaryIds);
    const presentMessageIds = new Set(preparedHistory.messages.map((message) => message.messageId));
    const presentToolCallIds = new Set(preparedHistory.messages
      .map((message) => message.toolCallId)
      .filter((value): value is string => typeof value === "string"));
    let summarySelection = selectContextSummaries(input.contextSummaries, adjustedSummaryBudget, {
      excludedSummaryIds: selectedSummaryIds,
      presentMessageIds,
      presentToolCallIds,
    });
    let summaryBlock =
      summarySelection.selected.length > 0
        ? ["## Context Summaries", formatContextSummaries(summarySelection.selected)].join("\n\n")
        : "";
    let summaryTokens = summarySelection.selected.length > 0 ? estimateTextTokens(summaryBlock) : 0;

    while (
      summarySelection.selected.length > 0 &&
      basePromptTokens + toolTokens + preparedHistory.estimatedTokensAfter + summaryTokens > inputBudgetTokens
    ) {
      summarySelection.selected.shift();
      summaryBlock =
        summarySelection.selected.length > 0
          ? ["## Context Summaries", formatContextSummaries(summarySelection.selected)].join("\n\n")
          : "";
      summaryTokens = summarySelection.selected.length > 0 ? estimateTextTokens(summaryBlock) : 0;
    }

    const systemPrompt = basePromptText;
    const providerContextMessages: ConversationMessage[] = summaryBlock
      ? [{ role: "system", content: summaryBlock }]
      : [];
    const usedInputTokens =
      basePromptTokens + toolTokens + preparedHistory.estimatedTokensAfter + summaryTokens;
    const remainingInputTokens = Math.max(0, inputBudgetTokens - usedInputTokens);
    const turnContextTokens = preparedHistory.messages
      .filter(isProviderTurnContextMessage)
      .reduce((total, message) => total + estimateMessageRecordTokens(message), 0);
    const recentMessageTokens = Math.max(0, preparedHistory.estimatedTokensAfter - turnContextTokens);
    const selectedSummaryIdsAll = [
      ...new Set([
        ...preparedHistory.usedSummaryIds,
        ...summarySelection.selected.map((summary) => summary.summaryId),
      ]),
    ];

    const contextBudget: ContextBudgetSnapshot = {
      source: "local_estimated",
      model: this.options.model,
      recordedAt: now(),
      contextWindowTokens: this.options.contextWindow,
      inputBudgetTokens,
      softLimitTokens: this.options.softLimitTokens,
      compactThresholdTokens: this.options.compactThresholdTokens,
      reserveOutputTokens: this.options.reserveOutputTokens,
      usedInputTokens,
      remainingInputTokens,
      usagePercent: inputBudgetTokens === 0 ? 0 : Math.round((usedInputTokens / inputBudgetTokens) * 1000) / 10,
      selectedMessageCount: preparedHistory.messages.length,
      selectedSummaryCount: selectedSummaryIdsAll.length,
      toolOutputExposure: preparedHistory.toolOutputExposure,
      categories: [
        { key: "system_prompt", label: "system prompt", estimatedTokens: basePromptTokens },
        { key: "tools", label: "tools", estimatedTokens: toolTokens },
        { key: "skills_workflows_mcp", label: "turn context + extensions", estimatedTokens: turnContextTokens },
        { key: "recent_messages", label: "recent messages", estimatedTokens: recentMessageTokens },
        { key: "summaries", label: "summaries", estimatedTokens: summaryTokens },
        { key: "free", label: "free", estimatedTokens: remainingInputTokens },
      ],
    };

    const compactionActions = historyReport.actions.filter((action) =>
      ["trim_tool_message", "drop_tool_group_for_budget", "truncate_plain_message"].includes(action.type));
    const droppedMessageCount = Math.max(0, historyReport.messageCountBefore - historyReport.messageCountAfter);
    const compactionTriggered =
      preparedHistory.usedSummaryIds.length > 0 ||
      compactionActions.length > 0 ||
      droppedMessageCount > 0;
    const compactedAfterTokens = preparedHistory.estimatedTokensAfter + summaryTokens;
    const tokensSaved = Math.max(0, preparedHistory.estimatedTokensBefore - compactedAfterTokens);
    const compactionSummaryIds = compactionTriggered ? selectedSummaryIdsAll : [];
    const compaction: ContextCompactionRecord = {
      createdAt: contextBudget.recordedAt,
      source: "local_estimated",
      triggered: compactionTriggered,
      triggerReason:
        preparedHistory.usedSummaryIds.length > 0
          ? "post-exposure summary substitution applied"
          : compactionActions.length > 0 || droppedMessageCount > 0
            ? "model context budget truncation or dropping applied"
            : undefined,
      beforeTokens: preparedHistory.estimatedTokensBefore,
      afterTokens: compactedAfterTokens,
      tokensSaved,
      droppedMessageCount,
      summaryCount: compactionSummaryIds.length,
      retained: [
        `recent messages=${preparedHistory.messages.length}`,
        `tool outputs=raw:${preparedHistory.toolOutputExposure.rawMessageCount}, summarized:${preparedHistory.toolOutputExposure.summarizedMessageCount}, budget-truncated:${preparedHistory.toolOutputExposure.budgetTruncatedMessageCount}`,
        ...(summarySelection.selected.length > 0
          ? [`summary refs=${summarySelection.selected.map((summary) => summary.summaryId.slice(0, 8)).join(", ")}`]
          : []),
      ],
      summaryRefs: compactionSummaryIds,
    };

    return {
      systemPrompt,
      turnContext,
      providerContextMessages,
      truncatedMessages: preparedHistory.messages,
      historyReport,
      contextBudget,
      compaction,
      selectedSummaryIds: selectedSummaryIdsAll,
    };
  }
}
