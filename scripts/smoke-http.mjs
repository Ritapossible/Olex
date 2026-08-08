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
    "returns 10 tools",
    list.body?.tools?.length === 10,
    `got ${list.body?.tools?.length}`,
  );
  const names = (list.body?.tools ?? []).map((t) => t.name);
  check(
    "includes olex_network_status",
    names.includes("olex_network_status"),
  );
  check(
    "includes the privacy analyzer",
    names.includes("olex_analyze_privacy"),
  );

  // The security boundary, asserted rather than assumed. View-key tools are not
  // registered on this surface at all, so they must be absent from the catalog —
  // not merely blocked at the ALLOWED_TOOLS gate.
  console.log("\nview-key tools must not exist on the hosted surface");
  for (const secret of [
    "olex_decrypt_record",
    "olex_true_balance",
    "olex_view_key_address",
  ]) {
    check(`${secret} absent from tools/list`, !names.includes(secret));
    const blocked = await post(port, {
      tool: secret,
      arguments: { view_key: "AViewKey1anything" },
    });
    check(`${secret} -> 404`, blocked.status === 404, `got ${blocked.status}`);
  }

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

  // A missing required argument used to surface as a 502 "Bridge failure"
  // wrapping a raw -32602. It is a caller mistake, so it must read as one.
  console.log("\nomitted required arguments");
  const noAmount = await post(port, {
    tool: "olex_convert_credits",
    arguments: { from: "credits" },
  });
  check("missing amount -> 400", noAmount.status === 400, `got ${noAmount.status}`);
  check(
    "names the missing field",
    /amount/i.test(noAmount.body?.error ?? ""),
    noAmount.body?.error,
  );
  check(
    "no raw -32602 in the message",
    !/-32602/.test(noAmount.body?.error ?? ""),
    noAmount.body?.error,
  );
  check(
    "not reported as a bridge failure",
    !/Bridge failure/i.test(noAmount.body?.error ?? ""),
    noAmount.body?.error,
  );

  const noTxId = await post(port, { tool: "olex_get_transaction", arguments: {} });
  check("missing transaction_id -> 400", noTxId.status === 400, `got ${noTxId.status}`);
  check(
    "names transaction_id",
    /transaction_id/i.test(noTxId.body?.error ?? ""),
    noTxId.body?.error,
  );

  console.log("\nolex_analyze_privacy over the bridge");
  const analyze = await post(port, {
    tool: "olex_analyze_privacy",
    arguments: { program_id: "credits.aleo" },
  });
  check("200 OK", analyze.status === 200, `got ${analyze.status}`);
  check("not an error", analyze.body?.isError === false, text(analyze));
  check(
    "reports both private and public inputs",
    /Private inputs: [1-9]/.test(text(analyze)) &&
      /Public inputs: [1-9]/.test(text(analyze)),
  );
  check(
    "flags public mapping writes",
    /Public mapping writes: [1-9]/.test(text(analyze)),
  );

  console.log("\nolex_check_visibility over the bridge");
  const vis = await post(port, {
    tool: "olex_check_visibility",
    arguments: { type: "credits.aleo/transfer_public.future" },
  });
  check(
    "dotted future type reads as public (finalize)",
    /public \(finalize\)/.test(text(vis)),
    text(vis),
  );

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
