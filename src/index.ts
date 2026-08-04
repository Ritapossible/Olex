#!/usr/bin/env node
/**
 * Olex — the bridge between AI agents and Aleo's privacy ecosystem.
 *
 * An MCP server that gives any MCP-compatible client (Claude Code, Cursor,
 * VS Code, ...) first-class access to the Aleo blockchain.
 *
 * Transport is stdio: the client spawns this process and speaks JSON-RPC over
 * stdin/stdout. Nothing may be written to stdout except protocol frames —
 * every diagnostic goes to stderr, or it corrupts the stream.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerChainTools } from "./tools/chain.js";
import { registerUtilTools } from "./tools/utils.js";
import { DEFAULT_NETWORK } from "./lib/network.js";

const VERSION = "0.1.0";

function createServer(): McpServer {
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

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // stderr is safe; stdout belongs to the protocol.
  process.stderr.write(
    `olex ${VERSION} ready — default network: ${DEFAULT_NETWORK}\n`,
  );

  const shutdown = async (): Promise<void> => {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `olex failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
