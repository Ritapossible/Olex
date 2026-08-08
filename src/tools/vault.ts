/**
 * View-key tools - the only tools that handle secrets.
 *
 * These answer the question a block explorer cannot: what does this account
 * actually own, including the private records that make up most real Aleo
 * balances. That requires the account's view key, so every tool here is
 * excluded from the hosted web bridge (see ALLOWED_TOOLS in api/mcp.js) and is
 * reachable only over local stdio, where the key stays on the user's machine.
 *
 * Key handling - parsing, redaction, env-var precedence - lives in
 * `src/lib/privacy.ts` so it is enforced in one place rather than per tool.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiGet, resolveNetwork, type NetworkName } from "../lib/network.js";
import {
  groupDigits,
  isTransactionId,
  microcreditsToCredits,
  parseTypedInt,
} from "../lib/format.js";
import {
  addressFromViewKey,
  decryptIfOwned,
  loadCrypto,
  recordFields,
  recordMicrocredits,
  redactViewKey,
  resolveViewKey,
  type KeySource,
} from "../lib/privacy.js";
import { fail, ok, type ToolResult } from "./result.js";

const networkArg = z
  .enum(["testnet", "mainnet"])
  .optional()
  .describe("Which Aleo network to query. Defaults to testnet.");

const viewKeyArg = z
  .string()
  .optional()
  .describe(
    "Aleo view key (starts with 'AViewKey1'). PREFER setting the OLEX_VIEW_KEY " +
      "environment variable instead: a key passed here travels through the model " +
      "context and is stored in conversation logs. If OLEX_VIEW_KEY is set it is " +
      "always used and this argument is ignored.",
  );

/** Note the key's provenance without ever printing the key. */
function sourceNote(source: KeySource): string {
  return source === "env"
    ? "_View key read from OLEX_VIEW_KEY; it never entered this conversation._"
    : "_View key was passed as an argument, so it is now in this conversation's " +
        "history. Set OLEX_VIEW_KEY instead to keep it out of model logs._";
}

/** Every failure here is redacted, since messages can quote the input. */
function safeFail(err: unknown, hint: string): ToolResult {
  const message = err instanceof Error ? redactViewKey(err.message) : "";
  return fail(message ? new Error(message) : null, redactViewKey(hint));
}

interface Transition {
  program?: string;
  function?: string;
  outputs?: Array<{ type?: string; value?: unknown }>;
}

/** Pull every `record1...` ciphertext out of a transaction's transitions. */
function recordsFromTransitions(transitions: Transition[]): Array<{
  ciphertext: string;
  program: string;
  fn: string;
}> {
  const found: Array<{ ciphertext: string; program: string; fn: string }> = [];
  for (const t of transitions) {
    for (const out of t.outputs ?? []) {
      if (out?.type !== "record") continue;
      const value = String(out.value ?? "").replace(/^"|"$/g, "");
      if (value.startsWith("record1")) {
        found.push({
          ciphertext: value,
          program: t.program ?? "?",
          fn: t.function ?? "?",
        });
      }
    }
  }
  return found;
}

export function registerVaultTools(server: McpServer): void {
  server.registerTool(
    "olex_decrypt_record",
    {
      title: "Decrypt an encrypted record",
      description:
        "Decrypt an Aleo record ciphertext (starts with 'record1') using a view key, " +
        "revealing its owner and fields - including the microcredit amount for " +
        "credits.aleo records. Only works for records the key owns. This is the one " +
        "thing no block explorer can do. Runs locally over stdio; the key is not sent " +
        "to any network.",
      inputSchema: {
        ciphertext: z
          .string()
          .describe("Record ciphertext starting with 'record1'."),
        view_key: viewKeyArg,
      },
    },
    async ({ ciphertext, view_key }): Promise<ToolResult> => {
      let resolved;
      try {
        await loadCrypto();
        resolved = resolveViewKey(view_key);
      } catch (err) {
        return safeFail(err, "Could not use that view key.");
      }

      const outcome = decryptIfOwned(ciphertext, resolved.viewKey);

      if (outcome.status === "invalid") {
        return safeFail(null, `Could not decrypt: ${outcome.reason}`);
      }

      if (outcome.status === "not-owned") {
        return ok(
          [
            "**Not your record.**",
            "",
            "This ciphertext is not owned by the account behind that view key, so it " +
              "cannot be decrypted with it. That is the expected result for most " +
              "records on-chain - they belong to other people.",
            "",
            `Checked against: \`${addressFromViewKey(resolved.viewKey)}\``,
            "",
            sourceNote(resolved.source),
          ].join("\n"),
        );
      }

      const record = outcome.record;
      const micro = recordMicrocredits(record);
      const fields = recordFields(record);

      const lines = [
        "**Record decrypted.**",
        "",
        `- Owner: \`${addressFromViewKey(resolved.viewKey)}\``,
      ];

      if (micro !== null) {
        lines.push(
          `- Amount: **${microcreditsToCredits(micro)} credits** ` +
            `(${groupDigits(micro)} microcredits)`,
        );
      }

      if (fields.length) {
        lines.push("", "Fields:");
        for (const [key, value] of fields) {
          const shown = value.length > 60 ? `${value.slice(0, 60)}...` : value;
          lines.push(`  - \`${key}\`: ${shown}`);
        }
      }

      lines.push(
        "",
        "_This plaintext is now in the conversation. The record itself remains " +
          "encrypted on-chain._",
        "",
        sourceNote(resolved.source),
      );

      return ok(lines.join("\n"));
    },
  );

  server.registerTool(
    "olex_true_balance",
    {
      title: "True balance - public plus private",
      description:
        "Compute an account's REAL total balance: its public credits.aleo balance plus " +
        "the value of the private records it owns in a given transaction or block range. " +
        "Block explorers show only the public half, so this is the difference between a " +
        "misleading number and the true one. Requires a view key; runs locally over stdio.",
      inputSchema: {
        transaction_id: z
          .string()
          .optional()
          .describe(
            "Scan this transaction's records. Use this for a fast, reliable answer.",
          ),
        from_block: z
          .union([z.number().int().nonnegative(), z.string()])
          .optional()
          .describe("Start of a block range to scan instead of a transaction."),
        to_block: z
          .union([z.number().int().nonnegative(), z.string()])
          .optional()
          .describe("End of the block range. Max 50 blocks per call."),
        view_key: viewKeyArg,
        network: networkArg,
      },
    },
    async ({
      transaction_id,
      from_block,
      to_block,
      view_key,
      network,
    }): Promise<ToolResult> => {
      const net = resolveNetwork(network as NetworkName | undefined);

      let resolved;
      try {
        await loadCrypto();
        resolved = resolveViewKey(view_key);
      } catch (err) {
        return safeFail(err, "Could not use that view key.");
      }

      const address = addressFromViewKey(resolved.viewKey);

      // Public half first: it always works and gives the answer a shape even if
      // no private records turn up.
      let publicMicro = 0n;
      let publicNote = "";
      try {
        const raw = await apiGet(
          net,
          `/program/credits.aleo/mapping/account/${address}`,
        );
        publicMicro = parseTypedInt(raw) ?? 0n;
      } catch {
        publicNote = " _(public balance lookup failed)_";
      }

      const scanned: string[] = [];
      const owned: Array<{ micro: bigint; program: string; fn: string }> = [];
      let checked = 0;
      let notOwned = 0;

      try {
        if (transaction_id?.trim()) {
          const id = transaction_id.trim();
          if (!isTransactionId(id)) {
            return fail(null, `"${id.slice(0, 20)}..." is not a valid transaction ID.`);
          }
          const tx = await apiGet<Record<string, any>>(net, `/transaction/${id}`);
          const transitions: Transition[] = Array.isArray(tx?.execution?.transitions)
            ? tx.execution.transitions
            : tx?.fee?.transition
              ? [tx.fee.transition]
              : [];
          scanned.push(`transaction \`${id}\``);
          for (const found of recordsFromTransitions(transitions)) {
            checked++;
            const outcome = decryptIfOwned(found.ciphertext, resolved.viewKey);
            if (outcome.status === "decrypted") {
              owned.push({
                micro: recordMicrocredits(outcome.record) ?? 0n,
                program: found.program,
                fn: found.fn,
              });
            } else if (outcome.status === "not-owned") {
              notOwned++;
            }
          }
        } else if (from_block !== undefined || to_block !== undefined) {
          const start = Number(String(from_block ?? "").trim());
          const end = Number(String(to_block ?? from_block ?? "").trim());
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0) {
            return fail(
              null,
              "Give whole block numbers for from_block and to_block.",
            );
          }
          if (end < start) {
            return fail(null, "to_block must not be below from_block.");
          }
          if (end - start > 49) {
            return fail(
              null,
              `That range is ${end - start + 1} blocks. Scan at most 50 per call ` +
                "to stay within a reasonable request budget.",
            );
          }

          scanned.push(`blocks ${groupDigits(start)}–${groupDigits(end)}`);
          for (let h = start; h <= end; h++) {
            const block = await apiGet<Record<string, any>>(net, `/block/${h}`);
            const txs: any[] = Array.isArray(block?.transactions)
              ? block.transactions
              : [];
            for (const entry of txs) {
              const inner = entry?.transaction ?? entry;
              const transitions: Transition[] = Array.isArray(
                inner?.execution?.transitions,
              )
                ? inner.execution.transitions
                : inner?.fee?.transition
                  ? [inner.fee.transition]
                  : [];
              for (const found of recordsFromTransitions(transitions)) {
                checked++;
                const outcome = decryptIfOwned(found.ciphertext, resolved.viewKey);
                if (outcome.status === "decrypted") {
                  owned.push({
                    micro: recordMicrocredits(outcome.record) ?? 0n,
                    program: found.program,
                    fn: found.fn,
                  });
                } else if (outcome.status === "not-owned") {
                  notOwned++;
                }
              }
            }
          }
        } else {
          return fail(
            null,
            "Give either a transaction_id or a from_block/to_block range to scan " +
              "for private records.",
          );
        }
      } catch (err) {
        return safeFail(err, "The record scan could not finish.");
      }

      const privateMicro = owned.reduce((sum, r) => sum + r.micro, 0n);
      const total = publicMicro + privateMicro;

      const lines = [
        `**True balance - \`${address}\`**`,
        "",
        `- Public: **${microcreditsToCredits(publicMicro)} credits**${publicNote}`,
        `- Private (records you own): **${microcreditsToCredits(privateMicro)} credits**`,
        `- **Total: ${microcreditsToCredits(total)} credits**`,
        "",
        `Scanned ${scanned.join(", ")} on ${net.name} - ${checked} encrypted record(s) ` +
          `found, ${owned.length} yours, ${notOwned} belonging to others.`,
      ];

      if (owned.length) {
        lines.push("", "Your records:");
        for (const r of owned.slice(0, 20)) {
          lines.push(
            `  - ${microcreditsToCredits(r.micro)} credits from \`${r.program}\` → \`${r.fn}\``,
          );
        }
        if (owned.length > 20) lines.push(`  _... and ${owned.length - 20} more._`);
      }

      lines.push(
        "",
        "_The private total covers only the range scanned, and does not subtract " +
          "records already spent. A block explorer shows the public figure alone._",
        "",
        sourceNote(resolved.source),
      );

      return ok(lines.join("\n"));
    },
  );

  server.registerTool(
    "olex_view_key_address",
    {
      title: "Derive the address for a view key",
      description:
        "Derive the Aleo address a view key belongs to, confirming the key is valid " +
        "and which account it unlocks - without decrypting anything. Use this to check " +
        "a key is configured correctly before scanning.",
      inputSchema: { view_key: viewKeyArg },
    },
    async ({ view_key }): Promise<ToolResult> => {
      try {
        await loadCrypto();
        const resolved = resolveViewKey(view_key);
        return ok(
          [
            "**View key is valid.**",
            "",
            `Account: \`${addressFromViewKey(resolved.viewKey)}\``,
            "",
            "This key can read every record that account has ever received. Treat it " +
              "like a password.",
            "",
            sourceNote(resolved.source),
          ].join("\n"),
        );
      } catch (err) {
        return safeFail(err, "That view key could not be used.");
      }
    },
  );
}
