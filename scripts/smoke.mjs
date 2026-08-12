/**
 * Smoke test: drives the built server over real stdio JSON-RPC.
 *
 * This is deliberately not a unit test with mocks. It spawns the actual binary
 * the way a client would, and hits the live Aleo API - the point is to prove
 * the whole path works, not that the pieces work in isolation.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A real testnet transaction carrying one encrypted record output, from
 * credits.aleo/transfer_private_to_public.
 *
 * Testnet is effectively idle, so scanning "recent blocks" for records finds
 * nothing and would make this suite pass vacuously. A named fixture keeps the
 * decryption path under test regardless of chain activity.
 */
const FIXTURE_TX =
  "at1fv877phzw8hwmaguyhlar7gk364vu6ychecgnafdzv8xgaqlwqrqm9m73w";

/**
 * A throwaway account, derived here rather than committed.
 *
 * No real view key may enter this repo, and RecordPlaintext has no .encrypt(),
 * so a ciphertext cannot be synthesised locally either. What is left - and what
 * actually matters - is proving the *negative*: a real on-chain ciphertext
 * parses, and a key that does not own it is told so rather than shown garbage.
 */
const { Account } = await import("@provablehq/sdk");
const throwaway = new Account({ seed: new Uint8Array(32).fill(7) });
const THROWAWAY_VIEW_KEY = throwaway.viewKey().to_string();
const THROWAWAY_ADDRESS = throwaway.address().to_string();

/** Pulled from FIXTURE_TX at run time so the test never hardcodes a ciphertext. */
let FIXTURE_CIPHERTEXT = "";

// OLEX_VIEW_KEY intentionally takes precedence over the view_key argument, so
// it must be cleared here: otherwise a developer with a real key configured
// would run this suite against their own account instead of the throwaway, and
// the "not your record" assertions would be testing nothing.
const childEnv = { ...process.env };
delete childEnv.OLEX_VIEW_KEY;

const child = spawn(process.execPath, [join(root, "dist", "index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: childEnv,
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
  console.log(`  [${mark}] ${label}${detail ? ` - ${detail}` : ""}`);
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

  /* The mapping tool is the public half of the balance story - `account` is
     where get_balance's number actually comes from - so it is checked against
     the same address, and the two must agree.

     The empty and misspelled cases matter more than the happy path. The API
     answers 200 `null` to both, so before this was pinned a typo in the mapping
     name came back as "no value set for this key": an agent reading that would
     report a funded account as empty and never see a failure. */
  const mapping = await send("tools/call", {
    name: "olex_get_mapping_value",
    arguments: {
      program_id: "credits.aleo",
      mapping_name: "account",
      key: "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
    },
  });
  const mappingText = text(mapping);
  check("olex_get_mapping_value reads credits.aleo/account",
    mapping.result?.isError !== true && /Value: `\d+u64`/.test(mappingText),
    mappingText.match(/Value: .*/)?.[0]);
  check("mapping value agrees with olex_get_balance",
    mappingText.match(/Value: `(\d+)u64`/)?.[1] === balText.match(/\(([\d,]+) microcredits\)/)?.[1]?.replace(/,/g, ""),
    `mapping ${mappingText.match(/Value: `(\d+)u64`/)?.[1]} vs balance ${balText.match(/\(([\d,]+) microcredits\)/)?.[1]}`);

  // A real mapping, a well-formed address that simply has no entry. This must
  // stay a successful empty answer - the misspelling check below must not be
  // over-eager enough to turn it into an error.
  const emptyKey = await send("tools/call", {
    name: "olex_get_mapping_value",
    arguments: {
      program_id: "credits.aleo", mapping_name: "account", key: THROWAWAY_ADDRESS,
    },
  });
  check("key with no entry is an empty value, not an error",
    emptyKey.result?.isError !== true && /no value set/.test(text(emptyKey)),
    text(emptyKey).split("\n")[0]);

  const badMapping = await send("tools/call", {
    name: "olex_get_mapping_value",
    arguments: {
      program_id: "credits.aleo", mapping_name: "no_such_mapping",
      key: "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
    },
  });
  check("misspelled mapping is rejected with the available list",
    badMapping.result?.isError === true && /It defines: .*account/.test(text(badMapping)),
    text(badMapping).split("\n")[0]);

  const badProgram = await send("tools/call", {
    name: "olex_get_mapping_value",
    arguments: { program_id: "not a program", mapping_name: "account", key: "x" },
  });
  check("invalid program ID rejected before any request",
    badProgram.result?.isError === true);

  /* Everything above runs on the default network. The `network` argument is a
     headline feature - every page carries the switch - and mainnet is a
     genuinely different upstream with its own slower budget, so it gets one
     read-only call rather than being assumed to work because testnet does.
     Comparing the two heights proves the argument was actually honoured: an
     ignored `network` would return the same chain twice. */
  console.log("\n--- mainnet, via the network argument ---\n");

  const mainnet = await send("tools/call", {
    name: "olex_network_status", arguments: { network: "mainnet" },
  });
  const mainnetText = text(mainnet);
  check("olex_network_status on mainnet",
    mainnet.result?.isError !== true && /Latest block: \*\*[\d,]+\*\*/.test(mainnetText),
    mainnetText.split("\n")[0]);
  const heightOf = (t) => t.match(/Latest block: \*\*([\d,]+)\*\*/)?.[1];
  check("mainnet is a different chain from testnet",
    heightOf(mainnetText) && heightOf(statusText) &&
    heightOf(mainnetText) !== heightOf(statusText),
    `mainnet ${heightOf(mainnetText)} vs testnet ${heightOf(statusText)}`);
  check("mainnet output is not labelled testnet", !/testnet/i.test(mainnetText));

  console.log("\n--- privacy analysis (no keys) ---\n");

  const analysis = await send("tools/call", {
    name: "olex_analyze_privacy", arguments: { program_id: "credits.aleo" },
  });
  const analysisText = text(analysis);
  // credits.aleo is the strongest available fixture: it genuinely mixes private
  // transfers with public mapping writes, so a parser that silently matched
  // nothing would fail here rather than pass with an empty report.
  check("olex_analyze_privacy parses credits.aleo",
    /Private inputs: [1-9]/.test(analysisText) && /Public inputs: [1-9]/.test(analysisText));
  check("analyzer finds public mapping writes",
    /Public mapping writes: [1-9]/.test(analysisText));
  check("analyzer flags a private-in / public-state leak",
    /⚠/.test(analysisText));
  console.log(`${analysisText.split("\n").slice(0, 8).map((l) => `      ${l}`).join("\n")}\n`);

  const unknownFn = await send("tools/call", {
    name: "olex_analyze_privacy",
    arguments: { program_id: "credits.aleo", function_name: "no_such_function" },
  });
  check("unknown function rejected with the available list",
    unknownFn.result?.isError === true && /It defines:/.test(text(unknownFn)));

  const vis = await send("tools/call", {
    name: "olex_check_visibility", arguments: { type: "u64.private" },
  });
  check("olex_check_visibility u64.private", /Encrypted in the transaction/.test(text(vis)));

  const visFuture = await send("tools/call", {
    name: "olex_check_visibility",
    arguments: { type: "credits.aleo/transfer_public.future" },
  });
  // The mode is the LAST dot-segment; splitting on the first would misread this
  // as "aleo/transfer_public" and report unspecified.
  check("dotted future type reads as public (finalize)",
    /public \(finalize\)/.test(text(visFuture)));

  const txPriv = await send("tools/call", {
    name: "olex_explain_transaction_privacy",
    arguments: { transaction_id: FIXTURE_TX },
  });
  const txPrivText = text(txPriv);
  check("olex_explain_transaction_privacy on fixture tx",
    /Encrypted records produced: [1-9]/.test(txPrivText));
  console.log(`${txPrivText.split("\n").slice(0, 10).map((l) => `      ${l}`).join("\n")}\n`);

  console.log("\n--- view-key tools (throwaway key, stdio only) ---\n");

  // Take the ciphertext straight from chain data rather than hardcoding a
  // 202-character literal that would rot silently.
  const fixture = await fetch(
    `https://api.explorer.provable.com/v1/testnet/transaction/${FIXTURE_TX}`,
  ).then((r) => r.json());

  // Every record output across the WHOLE execution, mirroring what the tool
  // itself walks. Reading only transitions[0] is what produced a wrong expected
  // count here before: this fixture carries records on two separate transitions
  // (credits.aleo/transfer_private_to_public and shield_swap.aleo/swap), so the
  // scan total has to be derived from the transaction, never written in by hand.
  const FIXTURE_RECORDS = (fixture?.execution?.transitions ?? [])
    .flatMap((t) => t?.outputs ?? [])
    .filter((o) => o?.type === "record")
    .map((o) => String(o.value ?? "").replace(/^"|"$/g, ""))
    .filter((v) => v.startsWith("record1"));
  FIXTURE_CIPHERTEXT = FIXTURE_RECORDS[0] ?? "";
  check("fixture transaction still carries a record ciphertext",
    FIXTURE_CIPHERTEXT.startsWith("record1"),
    `${FIXTURE_RECORDS.length} record(s), first is ${FIXTURE_CIPHERTEXT.length} chars`);

  check("view-key tools are registered on stdio",
    names.includes("olex_decrypt_record") &&
    names.includes("olex_true_balance") &&
    names.includes("olex_view_key_address"));

  const addr = await send("tools/call", {
    name: "olex_view_key_address", arguments: { view_key: THROWAWAY_VIEW_KEY },
  });
  const addrText = text(addr);
  check("olex_view_key_address derives the right account",
    addrText.includes(THROWAWAY_ADDRESS), "matches the locally derived address");

  const badKey = await send("tools/call", {
    name: "olex_decrypt_record",
    arguments: { ciphertext: "record1abc", view_key: "AViewKey1notreal" },
  });
  const badKeyText = text(badKey);
  check("malformed view key returns a readable error",
    badKey.result?.isError === true && /bech32|length/i.test(badKeyText));
  // The WASM bindings throw the bare string "unreachable" for a bad key. If that
  // ever reaches a user the tool looks broken rather than the input wrong.
  check("no raw WASM 'unreachable' leaks to the user",
    !/unreachable/i.test(badKeyText), badKeyText.slice(0, 80));

  const notMine = await send("tools/call", {
    name: "olex_decrypt_record",
    arguments: { ciphertext: FIXTURE_CIPHERTEXT, view_key: THROWAWAY_VIEW_KEY },
  });
  const notMineText = text(notMine);
  // A real on-chain ciphertext must parse, and must be correctly reported as
  // belonging to someone else - proving isOwner works rather than that the
  // parser failed open.
  check("real ciphertext parses and is reported as not ours",
    /Not your record/.test(notMineText), notMineText.split("\n")[0]);

  const garbage = await send("tools/call", {
    name: "olex_decrypt_record",
    arguments: { ciphertext: "record1garbage", view_key: THROWAWAY_VIEW_KEY },
  });
  check("malformed ciphertext rejected cleanly",
    garbage.result?.isError === true && /record1/.test(text(garbage)));

  const trueBal = await send("tools/call", {
    name: "olex_true_balance",
    arguments: { transaction_id: FIXTURE_TX, view_key: THROWAWAY_VIEW_KEY },
  });
  const trueBalText = text(trueBal);
  check("olex_true_balance splits public and private",
    /Public: \*\*/.test(trueBalText) && /Total: /.test(trueBalText));
  // The count comes from the fixture above, so this asserts the tool agrees with
  // the chain rather than with a number typed into this file. What is being
  // pinned is the ownership split: none of these records belong to the throwaway
  // key, so every one of them must land in the "others" column - a parser that
  // failed open and claimed them would break this check.
  const expectedScan =
    `${FIXTURE_RECORDS.length} encrypted record(s) found, 0 yours, ` +
    `${FIXTURE_RECORDS.length} belonging to others`;
  check("true balance scans the fixture and finds records owned by someone else",
    trueBalText.includes(expectedScan),
    trueBalText.split("\n").find((l) => l.startsWith("Scanned")) ?? "");
  console.log(`${trueBalText.split("\n").slice(0, 7).map((l) => `      ${l}`).join("\n")}\n`);

  const noScope = await send("tools/call", {
    name: "olex_true_balance", arguments: { view_key: THROWAWAY_VIEW_KEY },
  });
  check("true_balance without a scope asks for one instead of scanning the chain",
    noScope.result?.isError === true);

  const hugeRange = await send("tools/call", {
    name: "olex_true_balance",
    arguments: { from_block: 1000, to_block: 9000, view_key: THROWAWAY_VIEW_KEY },
  });
  check("oversized block range is refused, not silently truncated",
    hugeRange.result?.isError === true && /at most 50/.test(text(hugeRange)));

  console.log("\n--- prompts ---\n");

  const prompts = await send("prompts/list", {});
  const promptNames = (prompts.result?.prompts ?? []).map((p) => p.name).sort();
  check("prompts are registered",
    promptNames.includes("audit-program-privacy") &&
    promptNames.includes("true-balance"),
    promptNames.join(", "));

  const promptGet = await send("prompts/get", {
    name: "audit-program-privacy", arguments: { program_id: "credits.aleo" },
  });
  check("audit prompt renders with the program filled in",
    /credits\.aleo/.test(promptGet.result?.messages?.[0]?.content?.text ?? ""));

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (err) {
  console.error("smoke test error:", err.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
