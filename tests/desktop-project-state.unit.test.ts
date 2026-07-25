import { describe, expect, it } from "vitest";
import {
  parseProjectPreferences,
  rememberProject,
  removeProject,
} from "../apps/desktop/src/renderer/project-state.js";

describe("desktop project state", () => {
  it("remembers a project once and keeps the most recently used project first", () => {
    expect(rememberProject(["C:\\one", "C:\\two"], "C:\\two")).toEqual(["C:\\two", "C:\\one"]);
  });

  it("removes only the sidebar project registration", () => {
    expect(removeProject(["C:\\one", "C:\\two"], "C:\\one")).toEqual(["C:\\two"]);
  });

  it("accepts only safe project display preferences", () => {
    expect(parseProjectPreferences(JSON.stringify({
      "C:\\one": { name: "  Alpha  ", pinnedAt: "2026-07-10T00:00:00.000Z", ignored: true },
      "C:\\two": null,
    }))).toEqual({
      "C:\\one": { name: "Alpha", pinnedAt: "2026-07-10T00:00:00.000Z" },
    });
  });
});
