import type { PlanItem } from "../../shared-schema/src/index.js";

export function validatePlanItems(items: PlanItem[]): void {
  const inProgressCount = items.filter((item) => item.status === "in_progress").length;
  if (inProgressCount > 1) {
    throw new Error("Only one plan item may be in_progress at a time.");
  }
}

export function renderPlanItems(items: PlanItem[]): string {
  if (items.length === 0) {
    return "No active plan.";
  }

  return items
    .map((item) => {
      const suffix = item.blockedReason ? ` blockedReason=${item.blockedReason}` : "";
      const notes = item.notes ? ` notes=${item.notes}` : "";
      return `- [${item.status}] ${item.id}: ${item.title}${notes}${suffix}`;
    })
    .join("\n");
}
