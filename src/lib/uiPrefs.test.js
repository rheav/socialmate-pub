import { describe, it, expect } from "vitest";
import {
  DEFAULT_UI_PREFS,
  normalizeUiPrefs,
  resolveTab,
  visibleTabs,
} from "./uiPrefs.js";

describe("tabs", () => {
  it("lists the three tabs in nav order and falls back for an unknown id", () => {
    expect(normalizeUiPrefs(null)).toEqual(DEFAULT_UI_PREFS);
    expect(visibleTabs().map((t) => t.id)).toEqual(["research", "library", "spy"]);
    expect(resolveTab("spy", {})).toBe("spy");
    expect(resolveTab("ferramenta-que-nao-existe", {})).toBe("research");
  });
});
