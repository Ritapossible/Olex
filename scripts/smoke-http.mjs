/**
 * Smoke test for the HTTP bridge (api/mcp.js).
 *
 * Mounts the Vercel handler on a real local HTTP server and drives it over
 * the wire, so this exercises the same path a browser takes. Vercel supplies
 * res.status()/res.send() and a pre-parsed req.body; plain Node does not, so
 * the harness shims both to match.
 *
 * Run: node scripts/smoke-http.mjs   (requires `npm run build` first)
 */

import http from "node:http";
import handler from "../api/mcp.js";

let failures = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Collect the body, then hand Vercel-shaped req/res to the handler. */
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    try {
      req.body = raw ? JSON.parse(raw) : undefined;
    } catch {
      req.body = raw;
    }
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.send = (payload) => res.end(payload);
    try {
      await handler(req, res);
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
});

function post(port, body, method = "POST") {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        port,
        path: "/api/mcp",
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (d) => (out += d));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(out);
          } catch {
            parsed = out;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

const text = (r) =>
  (r.body?.content ?? []).map((c) => c.text ?? "").join("\n");

await new Promise((r) => server.listen(0, r));
const { port } = server.address();
console.log(`\nOlex HTTP bridge smoke test (port ${port})\n`);

try {
  console.log("tools/list");
  const list = await post(port, { method: "tools/list" });
  check("200 OK", list.status === 200, `got ${list.status}`);
  check(
    "returns 7 tools",
    list.body?.tools?.length === 7,
    `got ${list.body?.tools?.length}`,
  );
  const names = (list.body?.tools ?? []).map((t) => t.name);
  check(
    "includes olex_network_status",
    names.includes("olex_network_status"),
  );

  console.log("\nolex_network_status (real testnet call)");
  const status = await post(port, { tool: "olex_network_status" });
  check("200 OK", status.status === 200, `got ${status.status}`);
  check("not an error", status.body?.isError === false);
  check("reports latest block", /Latest block/i.test(text(status)));
  const height = text(status).match(/([\d,]{6,})/)?.[1];
  console.log(`        live height: ${height ?? "(not parsed)"}`);

  console.log("\nolex_convert_credits (pure computation)");
  const conv = await post(port, {
    tool: "olex_convert_credits",
    arguments: { amount: "1.5", from: "credits" },
  });
  check("200 OK", conv.status === 200, `got ${conv.status}`);
  check(
    "1.5 credits -> 1,500,000 microcredits",
    /1,500,000/.test(text(conv)),
    text(conv),
  );

  console.log("\nolex_get_balance with an invalid address");
  const bad = await post(port, {
    tool: "olex_get_balance",
    arguments: { address: "not-an-address" },
  });
  check("still HTTP 200", bad.status === 200, `got ${bad.status}`);
  check("flagged isError", bad.body?.isError === true);

  // A text input and most LLM clients send numbers as strings. This used to
  // fail schema validation with a raw -32602 protocol error in the playground.
  console.log("\nolex_get_block with a STRING height");
  const strHeight = await post(port, {
    tool: "olex_get_block",
    arguments: { height: "18535000" },
  });
  check("200 OK", strHeight.status === 200, `got ${strHeight.status}`);
  check("not an error", strHeight.body?.isError === false, text(strHeight));
  check("resolves block 18,535,000", /18,535,000/.test(text(strHeight)));

  const emptyHeight = await post(port, {
    tool: "olex_get_block",
    arguments: { height: "" },
  });
  check(
    "empty height falls back to latest",
    emptyHeight.body?.isError === false && /Block/.test(text(emptyHeight)),
  );

  const junkHeight = await post(port, {
    tool: "olex_get_block",
    arguments: { height: "not-a-number" },
  });
  check(
    "non-numeric height rejected readably",
    junkHeight.body?.isError === true &&
      !/-32602/.test(text(junkHeight)),
    text(junkHeight),
  );

  // Transitions were always [] because of an operator-precedence bug.
  console.log("\nolex_get_transaction lists transitions");
  const tx = await post(port, {
    tool: "olex_get_transaction",
    arguments: {
      transaction_id:
        "at1fv877phzw8hwmaguyhlar7gk364vu6ychecgnafdzv8xgaqlwqrqm9m73w",
    },
  });
  check("200 OK", tx.status === 200, `got ${tx.status}`);
  const txCount = Number(text(tx).match(/Transitions: (\d+)/)?.[1] ?? 0);
  check("reports a non-zero transition count", txCount > 0, `got ${txCount}`);
  check("lists each transition's program", /`credits\.aleo` →/.test(text(tx)));

  console.log("\nrejections");
  const unknown = await post(port, { tool: "olex_drain_wallet" });
  check("unknown tool -> 404", unknown.status === 404, `got ${unknown.status}`);

  const noTool = await post(port, {});
  check("missing tool -> 400", noTool.status === 400, `got ${noTool.status}`);

  const getReq = await post(port, undefined, "GET");
  check("GET -> 405", getReq.status === 405, `got ${getReq.status}`);
} finally {
  server.close();
}

console.log(
  failures === 0
    ? "\nALL CHECKS PASSED\n"
    : `\n${failures} CHECK(S) FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
