/**
 * Shared MCP server factory.
 *
 * Both the stdio entry point (src/index.ts) and the HTTP bridge (api/mcp.js)
 * import this to ensure identical tool registration - with one deliberate
 * exception. View-key tools are registered only when `viewKeyTools` is asked
 * for, and only the stdio entry asks.
 *
 * That is a stronger boundary than the ALLOWED_TOOLS gate in api/mcp.js, which
 * remains as defence in depth. The bridge cannot construct a key-handling tool
 * even by mistake, `tools/list` over HTTP cannot advertise one, and the WASM
 * cryptography those tools need never enters the serverless bundle.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerChainTools } from "./tools/chain.js";
import { registerUtilTools } from "./tools/utils.js";
import { registerPrivacyTools } from "./tools/privacy.js";
import { registerPrompts } from "./prompts.js";

export const VERSION = "0.1.0";

export interface ServerOptions {
  /**
   * Declares that the caller will also register the view-key tools, which
   * changes the instructions and prompts this server advertises.
   *
   * The registration itself is the caller's job, and deliberately so: this
   * module must not import `tools/vault.js`, or the WASM cryptography behind it
   * would be pulled into the serverless bundle that imports `createServer`.
   * Only src/index.ts - the local stdio binary - does that import.
   */
  viewKeyTools?: boolean;
}

export function createServer(options: ServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "olex", version: VERSION },
    {
      instructions:
        "Olex exposes the Aleo privacy blockchain to AI assistants.\n\n" +
        "Key facts to reason with:\n" +
        "- Aleo separates PUBLIC state (mappings, readable by anyone) from " +
        "PRIVATE state (encrypted records, readable only with a view key). " +
        "Balance and mapping tools only ever see the public half, so a " +
        "balance from `olex_get_balance` is a floor, not a total.\n" +
        "- `olex_analyze_privacy` reports where a program's private/public " +
        "boundary actually falls. Values that reach mapping state are public " +
        "even when they arrived as private inputs - that is the leak worth " +
        "reporting to a user.\n" +
        "- All tools default to testnet. Never assume mainnet.\n" +
        "- Amounts are microcredits (1 credit = 1,000,000 microcredits).\n" +
        (options.viewKeyTools
          ? "- View-key tools (`olex_decrypt_record`, `olex_true_balance`, " +
            "`olex_view_key_address`) are available and run locally. Prefer the " +
            "OLEX_VIEW_KEY environment variable over passing a key as an " +
            "argument: an argument is recorded in this conversation, an " +
            "environment variable is not. Never suggest a user paste a private " +
            "key (APrivateKey1...) - a view key grants read access only.\n"
          : "- View-key tools are not available on this surface: it is hosted, " +
            "and a view key must never be sent over a network. Private records " +
            "can be described here but not decrypted.\n"),
    },
  );

  registerChainTools(server);
  registerUtilTools(server);
  registerPrivacyTools(server);

  registerPrompts(server, { viewKeyTools: options.viewKeyTools === true });

  return server;
}
