// Pure (DOM-free, component-free) tool-registry selector — kept separate from
// tools.jsx so unit tests never pull the React component tree.

// Given any tool array + platform, the platform's non-global tools (order preserved).
export const filterToolsForPlatform = (tools, platform) =>
  tools.filter((t) => t.platforms !== "global" && t.platforms.includes(platform));

export const WORKSPACE_EXCLUDED = [];
export const workspaceToolsForPlatform = (tools, platform) =>
  filterToolsForPlatform(tools, platform).filter((t) => !WORKSPACE_EXCLUDED.includes(t.id));
