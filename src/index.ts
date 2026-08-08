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

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, VERSION } from "./server.js";
import { registerVaultTools } from "./tools/vault.js";
import { DEFAULT_NETWORK } from "./lib/network.js";

async function main(): Promise<void> {
  // View-key tools are registered here rather than inside createServer(), so
  // the hosted bridge — which imports createServer and nothing else — cannot
  // reach them and does not bundle the WASM cryptography they need.
  const server = createServer({ viewKeyTools: true });
  registerVaultTools(server);

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
