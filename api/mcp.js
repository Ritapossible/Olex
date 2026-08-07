/**
 * HTTP bridge to the real Olex MCP server.
 *
 * The playground must exercise the actual product, not a browser-side
 * reimplementation of it. So every request here spins up a genuine MCP
 * client/server pair over an in-memory transport, performs the real
 * handshake, and dispatches a real `tools/call`. The tool code that runs is
 * byte-for-byte the code an editor gets over stdio.
 *
 * Why not StreamableHTTPServerTransport? It enforces session state: a fresh
 * transport has `_initialized = false` and rejects any non-initialize request
 * with 400. Serverless invocations are independent, so that state can never
 * carry across the handshake and the call. The in-memory pair sidesteps this
 * by keeping both halves of a full session inside one invocation.
 *
 * Imports resolve to compiled dist/ output (not src/) so Vercel's dependency
 * tracer bundles them without tripping over NodeNext .js-extension imports
 * that point at .ts sources.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, VERSION } from "../dist/server.js";

// Read-only chain queries. Listed explicitly so a typo in the client cannot
// probe for tools that were never meant to be reachable from the browser.
const ALLOWED_TOOLS = new Set([
  "olex_network_status",
  "olex_get_balance",
  "olex_get_program",
  "olex_get_mapping_value",
  "olex_get_block",
  "olex_get_transaction",
  "olex_convert_credits",
]);

/** Run one full MCP session and hand back the client, plus a closer. */
async function openSession() {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const server = createServer();
  const client = new Client({ name: "olex-web", version: VERSION });

  // Both ends must be connected before the handshake can complete.
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    close: async () => {
      // Never let a teardown failure mask a successful result.
      await Promise.allSettled([client.close(), server.close()]);
    },
  };
}

function send(res, status, payload) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Results reflect live chain state; a cached response would be wrong.
  res.setHeader("Cache-Control", "no-store");
  res.send(JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Method not allowed. Use POST." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return send(res, 400, { error: "Invalid JSON body." });
    }
  }
  if (!body || typeof body !== "object") {
    return send(res, 400, { error: "Expected a JSON object body." });
  }

  const started = Date.now();
  let session;

  try {
    // tools/list — lets the page render the catalog from the server itself.
    if (body.method === "tools/list") {
      session = await openSession();
      const listed = await session.client.listTools();
      return send(res, 200, {
        ok: true,
        tools: listed.tools,
        elapsedMs: Date.now() - started,
      });
    }

    const tool = body.tool;
    if (typeof tool !== "string" || !tool) {
      return send(res, 400, { error: "Missing 'tool' name." });
    }
    if (!ALLOWED_TOOLS.has(tool)) {
      return send(res, 404, { error: `Unknown tool: ${tool}` });
    }

    const args =
      body.arguments && typeof body.arguments === "object"
        ? body.arguments
        : {};

    session = await openSession();
    const result = await session.client.callTool({
      name: tool,
      arguments: args,
    });

    // A tool that reports a domain error (bad address, missing block) is a
    // successful HTTP exchange — the transport worked. Surface isError so the
    // page can style it as a failure without treating it as a 500.
    return send(res, 200, {
      ok: true,
      tool,
      isError: result.isError === true,
      content: result.content ?? [],
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return send(res, 502, {
      error: `Bridge failure: ${message}`,
      elapsedMs: Date.now() - started,
    });
  } finally {
    if (session) await session.close();
  }
}
