import type {
  RouteTarget,
  RoutingDecision,
  RoutingFeatures,
  RoutingReasonCode,
  VisionImageSourceType,
  VisionTaskType,
} from "../../shared-schema/src/index.js";

type RoutingFeatureKey = keyof RoutingFeatures;

export interface RoutingRule {
  id: string;
  target: RouteTarget;
  summary: string;
  all?: RoutingFeatureKey[];
  any?: RoutingFeatureKey[];
}

export interface RoutingPolicyConfig {
  rules: RoutingRule[];
  fallbackTarget: RouteTarget;
  fallbackReasonCode: RoutingReasonCode;
}

const SCREENSHOT_PATTERN =
  /\b(screenshot|image|ocr|png|jpg|jpeg|gif|webp|diagram|ui)\b|截图|识图|图片|设计稿|界面|报错图|错误截图/i;
const COMPLEX_CODING_PATTERN =
  /\b(refactor|rewrite|complex|backend|service|endpoint|route|api|migration|schema|database|controller)\b|重构|复杂编码|后端|服务层|接口|路由|数据库|迁移/i;
const CROSS_FILE_PATTERN = /\b(cross-file|multi-file|multiple files)\b|跨文件|多个文件|多文件/i;
const BACKEND_PATTERN = /\b(backend|service|endpoint|route|api|database|migration|schema|server)\b|后端|接口|路由|数据库|迁移/i;
const SMALL_PATCH_PATTERN =
  /\b(small patch|tiny fix|one-line|single-file|small script|minor fix)\b|小补丁|小修复|单文件|脚本修复|一行修复/i;
const DOCUMENT_TASK_PATTERN =
  /\b(pdf|docx|word document|word file|spreadsheet|document)\b|文档|表格|复刻|排版|样式|底色/i;
const CODING_CONTEXT_PATTERN =
  /\b(code|source|repository|repo|file changes?|implement|implementation|refactor|typescript|javascript|python|java|rust|go)\b|代码|源码|仓库|实现|开发|编程|重构|修复/i;
const IMAGE_REF_PATTERN = /(file|artifact):\/\/[^\s"'`]+/g;

const FEATURE_REASON_CODES: Record<RoutingFeatureKey, RoutingReasonCode> = {
  isScreenshotTask: "screenshot_task",
  isComplexCodingTask: "complex_coding_task",
  isCrossFile: "cross_file_task",
  requiresBackend: "backend_implementation_task",
  isSmallPatch: "small_patch_task",
};

export const DEFAULT_ROUTING_POLICY: RoutingPolicyConfig = {
  rules: [
    {
      id: "route-kimi-screenshot",
      target: "kimi_vision",
      summary: "Screenshot, OCR, UI, or diagram tasks default to Kimi vision.",
      any: ["isScreenshotTask"],
    },
    {
      id: "route-glm-complex-coding",
      target: "glm_coding",
      summary: "Complex backend or cross-file coding tasks default to the GLM coding worker.",
      any: ["isComplexCodingTask", "isCrossFile", "requiresBackend"],
    },
    {
      id: "route-ds-small-patch",
      target: "ds_direct",
      summary: "Small direct patches stay with the DeepSeek governor.",
      all: ["isSmallPatch"],
    },
  ],
  fallbackTarget: "ds_direct",
  fallbackReasonCode: "no_rule_matched",
};

function uniqueRefs(values: string[]): string[] {
  return [...new Set(values)];
}

function trimNaturalLanguageSuffix(value: string): string {
  let trimmed = value.replace(/[.,;:!?，。；：！？]+$/u, "");
  const pairs = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
    ["<", ">"],
  ] as const;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of pairs) {
      if (!trimmed.endsWith(close)) continue;
      const openCount = [...trimmed].filter((character) => character === open).length;
      const closeCount = [...trimmed].filter((character) => character === close).length;
      if (closeCount > openCount) {
        trimmed = trimmed.slice(0, -1);
        changed = true;
      }
    }
  }
  return trimmed;
}

function inferRouteReasonCodes(features: RoutingFeatures): RoutingReasonCode[] {
  return (Object.keys(FEATURE_REASON_CODES) as RoutingFeatureKey[])
    .filter((key) => features[key])
    .map((key) => FEATURE_REASON_CODES[key]);
}

function matchesRule(features: RoutingFeatures, rule: RoutingRule): boolean {
  const allMatched = (rule.all ?? []).every((feature) => features[feature]);
  const anyMatched = rule.any === undefined || rule.any.some((feature) => features[feature]);
  return allMatched && anyMatched;
}

function summarizeDecision(target: RouteTarget, reasonCodes: RoutingReasonCode[], rule: RoutingRule | undefined): string {
  const reasonText = reasonCodes.length > 0 ? reasonCodes.join(", ") : "no_reason_codes";
  const prefix =
    target === "glm_coding"
      ? "Route to GLM coding worker"
      : target === "kimi_vision"
        ? "Route to Kimi vision worker"
        : "Route to DeepSeek direct handling";
  return `${prefix} because ${reasonText}${rule ? ` (rule=${rule.id})` : ""}.`;
}

export function extractRoutingFeatures(prompt: string): RoutingFeatures {
  const fileRefs = extractContextRefs(prompt);
  const isScreenshotTask = SCREENSHOT_PATTERN.test(prompt) || extractImageRef(prompt) !== undefined;
  const isDocumentTask = DOCUMENT_TASK_PATTERN.test(prompt);
  const isCrossFile = CROSS_FILE_PATTERN.test(prompt) || (fileRefs.length > 1 && CODING_CONTEXT_PATTERN.test(prompt) && !isDocumentTask);
  const requiresBackend = BACKEND_PATTERN.test(prompt);
  const isComplexCodingTask = COMPLEX_CODING_PATTERN.test(prompt) || (requiresBackend && isCrossFile);
  const isSmallPatch =
    SMALL_PATCH_PATTERN.test(prompt) ||
    (!isScreenshotTask && !isComplexCodingTask && !requiresBackend && prompt.trim().length <= 180 && /\b(fix|rename|patch|修复)\b/i.test(prompt));

  return {
    isScreenshotTask,
    isComplexCodingTask,
    isCrossFile,
    requiresBackend,
    isSmallPatch,
  };
}

export function resolveRoutingDecision(input: {
  prompt: string;
  overrideTarget?: RouteTarget;
  policy?: RoutingPolicyConfig;
}): RoutingDecision {
  const policy = input.policy ?? DEFAULT_ROUTING_POLICY;
  const features = extractRoutingFeatures(input.prompt);
  const matchedRule = policy.rules.find((rule) => matchesRule(features, rule));
  const automaticTarget = matchedRule?.target ?? policy.fallbackTarget;
  const baseReasonCodes =
    matchedRule !== undefined ? inferRouteReasonCodes(features) : [policy.fallbackReasonCode];
  const reasonCodes =
    input.overrideTarget !== undefined
      ? (["manual_override", ...baseReasonCodes] satisfies RoutingReasonCode[])
      : baseReasonCodes;
  const finalTarget = input.overrideTarget ?? automaticTarget;

  return {
    mode: input.overrideTarget ? "manual_override" : "automatic",
    automaticTarget,
    finalTarget,
    overrideTarget: input.overrideTarget,
    ruleId: matchedRule?.id ?? "route-ds-fallback",
    reasonCodes,
    reasonSummary: summarizeDecision(finalTarget, reasonCodes, matchedRule),
    features,
  };
}

export function createFallbackRoutingDecision(input: {
  previousDecision: RoutingDecision;
  reasonCode: Extract<RoutingReasonCode, "coding_worker_failed" | "vision_worker_failed">;
}): RoutingDecision {
  return {
    mode: "fallback",
    automaticTarget: input.previousDecision.automaticTarget,
    finalTarget: "ds_direct",
    overrideTarget: input.previousDecision.overrideTarget,
    ruleId: `${input.previousDecision.ruleId}:fallback`,
    reasonCodes: [input.reasonCode, "fallback_to_governor"],
    reasonSummary: summarizeDecision("ds_direct", [input.reasonCode, "fallback_to_governor"], undefined),
    features: input.previousDecision.features,
  };
}

export function normalizeRouteOverride(value: string | undefined): RouteTarget | undefined {
  if (!value) {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case "ds":
    case "deepseek":
    case "ds_direct":
      return "ds_direct";
    case "glm":
    case "glm_coding":
      return "glm_coding";
    case "kimi":
    case "kimi_vision":
      return "kimi_vision";
    default:
      return undefined;
  }
}

export function extractContextRefs(prompt: string): Array<`file://${string}` | `artifact://${string}`> {
  const matches = prompt.match(IMAGE_REF_PATTERN) ?? [];
  return uniqueRefs(matches.map(trimNaturalLanguageSuffix))
    .filter((match): match is `file://${string}` | `artifact://${string}` => match.startsWith("file://") || match.startsWith("artifact://"));
}

export function extractImageRef(prompt: string): `file://${string}` | `artifact://${string}` | undefined {
  return extractContextRefs(prompt).find((ref) => /\.(png|jpg|jpeg|gif|webp)$/i.test(ref) || ref.includes("/images/"));
}

export function inferVisionTaskType(prompt: string): VisionTaskType {
  if (/\bocr\b|发票|扫描|文字识别/i.test(prompt)) {
    return "ocr_extract";
  }
  if (/\bui\b|\bux\b|界面|设计稿|组件|布局/i.test(prompt)) {
    return "ui_parse";
  }
  if (/\bdiagram\b|flowchart|mermaid|架构图|流程图/i.test(prompt)) {
    return "diagram_parse";
  }
  return "error_screenshot";
}

export function inferVisionSourceType(
  prompt: string,
  imageRef: `file://${string}` | `artifact://${string}`,
): VisionImageSourceType {
  if (imageRef.startsWith("file://")) {
    return "local_path";
  }
  if (/\bupload\b|上传/i.test(prompt)) {
    return "uploaded_file";
  }
  return "browser_capture";
}
