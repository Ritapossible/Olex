/**
 * Shared MCP server factory.
 *
 * Both the stdio entry point (src/index.ts) and the HTTP bridge (api/mcp.ts)
 * import this to ensure identical tool registration.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerChainTools } from "./tools/chain.js";
import { registerUtilTools } from "./tools/utils.js";

export const VERSION = "0.1.0";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "olex", version: VERSION },
    {
      instructions:
        "Olex exposes the Aleo privacy blockchain to AI assistants.\n\n" +
        "Key facts to reason with:\n" +
        "- Aleo separates PUBLIC state (mappings, readable by anyone) from " +
        "PRIVATE state (encrypted records, readable only with a view key). " +
        "Balance and mapping tools only ever see the public half.\n" +
        "- All tools default to testnet. Never assume mainnet.\n" +
        "- Amounts are microcredits (1 credit = 1,000,000 microcredits).",
    },
  );

  registerChainTools(server);
  registerUtilTools(server);

  return server;
}
