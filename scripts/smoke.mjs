/**
 * Smoke test: drives the built server over real stdio JSON-RPC.
 *
 * This is deliberately not a unit test with mocks. It spawns the actual binary
 * the way a client would, and hits the live Aleo API — the point is to prove
 * the whole path works, not that the pieces work in isolation.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [join(root, "dist", "index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {
      console.error("non-JSON on stdout (would corrupt the protocol):", line);
      process.exitCode = 1;
    }
  }
});

child.stderr.on("data", (c) => process.stderr.write(`  [server] ${c}`));

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

const text = (r) => r?.result?.content?.[0]?.text ?? JSON.stringify(r?.error ?? r);

let failures = 0;
function check(label, condition, detail) {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
}

try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "olex-smoke", version: "0" },
  });
  notify("notifications/initialized");
  check("initialize handshake", init.result?.serverInfo?.name === "olex",
    init.result?.serverInfo?.name);

  const list = await send("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  check("tools/list returns tools", names.length > 0, `${names.length}: ${names.join(", ")}`);

  console.log("\n--- live calls against Aleo testnet ---\n");

  const status = await send("tools/call", {
    name: "olex_network_status", arguments: {},
  });
  const statusText = text(status);
  check("olex_network_status", /Latest block: \*\*[\d,]+\*\*/.test(statusText));
  console.log(`${statusText.split("\n").slice(0, 6).map((l) => `      ${l}`).join("\n")}\n`);

  const bal = await send("tools/call", {
    name: "olex_get_balance",
    arguments: { address: "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px" },
  });
  const balText = text(bal);
  check("olex_get_balance (real address)", /credits/.test(balText));
  console.log(`${balText.split("\n").slice(0, 4).map((l) => `      ${l}`).join("\n")}\n`);

  const badAddr = await send("tools/call", {
    name: "olex_get_balance", arguments: { address: "not-an-address" },
  });
  check("invalid address rejected cleanly", badAddr.result?.isError === true,
    "returns isError, not a crash");

  const conv = await send("tools/call", {
    name: "olex_convert_credits", arguments: { amount: "1.5", from: "credits" },
  });
  check("olex_convert_credits 1.5 -> 1,500,000",
    /1,500,000 microcredits/.test(text(conv)));

  const prog = await send("tools/call", {
    name: "olex_get_program", arguments: { program_id: "credits.aleo" },
  });
  check("olex_get_program credits.aleo", /program credits\.aleo/.test(text(prog)));

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (err) {
  console.error("smoke test error:", err.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
