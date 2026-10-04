// The MCP tool names, from the site's prefix (industry/site.ts): llms.txt, the agent page and the server
// list the same names.
import { SITE } from "@aihot/industry/site";

const p = SITE.mcpPrefix;

export const MCP_TOOL_NAMES = {
  latest: `${p}_get_latest`,
  search: `${p}_search`,
  hot: `${p}_get_hot_topics`,
  story: `${p}_get_story`,
  daily: `${p}_get_daily`,
  pilot: `${p}_get_pilot`,
} as const;

export const MCP_TOOLS = Object.values(MCP_TOOL_NAMES).map((name) => ({ name }));
