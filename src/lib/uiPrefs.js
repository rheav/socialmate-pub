// Panel-wide UI preferences: which parts of the panel the user wants to see at
// all. Pure (DOM-free, component-free) so the Shell's behaviour can be tested
// without React — same split as navState.js / toolsFilter.js.

export const UI_PREFS_KEY = "sw_ui_prefs";

/** Every top-level tab, in nav order. `optional` ones can be switched off. */
export const TOP_TABS = [
  { id: "research", label: "Pesquisa" },
  { id: "library", label: "Arquivo" },
  { id: "spy", label: "Spy" },
];

export const DEFAULT_UI_PREFS = {};

/**
 * A stored blob (or anything at all) read as prefs.
 *
 * Unknown keys are dropped and every value is coerced, so a hand-edited or
 * half-written storage entry can never hide a tab by accident — only an explicit
 * `false` does.
 */
export function normalizeUiPrefs(raw) {
  const out = { ...DEFAULT_UI_PREFS };
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(DEFAULT_UI_PREFS))
    if (typeof raw[key] === "boolean") out[key] = raw[key];
  return out;
}

/** The tabs to render, in nav order. */
export function visibleTabs(prefs) {
  return TOP_TABS;
}

/**
 * The tab to actually show.
 *
 * A hidden tab, or an unknown id (a rename, a stale stored nav), falls back to
 * the first visible one.
 */
export function resolveTab(tab, prefs) {
  const tabs = visibleTabs(prefs);
  return tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
}
