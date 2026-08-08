/**
 * Privacy tools — the analysis surface.
 *
 * Everything in this file is safe to expose publicly: it reads deployed source
 * over the same public API the rest of the server uses and needs no key
 * material. The view-key tools that do need secrets live in `vault.ts` and are
 * deliberately kept out of the hosted web bridge.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiGet, resolveNetwork, type NetworkName } from "../lib/network.js";
import { isProgramId, isTransactionId } from "../lib/format.js";
import { analyzeProgram, modeOf, type Mode } from "../lib/analyze.js";
import { fail, ok, type ToolResult } from "./result.js";

const networkArg = z
  .enum(["testnet", "mainnet"])
  .optional()
  .describe("Which Aleo network to query. Defaults to testnet.");

/** Fetch deployed source, unwrapping the JSON-quoted string the API returns. */
async function fetchSource(
  net: ReturnType<typeof resolveNetwork>,
  id: string,
): Promise<string> {
  const raw = await apiGet<string>(net, `/program/${id}`);
  const text = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
  return text.replace(/^"|"$/g, "").replace(/\\n/g, "\n");
}

const MODE_LABEL: Record<Mode, string> = {
  private: "private",
  public: "PUBLIC",
  record: "private (record)",
  constant: "constant",
  future: "public (finalize)",
  unspecified: "unspecified",
};

export function registerPrivacyTools(server: McpServer): void {
  server.registerTool(
    "olex_analyze_privacy",
    {
      title: "Analyze a program's privacy surface",
      description:
        "Statically analyze a deployed Aleo program and report where its " +
        "private/public boundary actually falls: which function inputs and outputs " +
        "are private, which are public, and which functions leak values into public " +
        "mapping state despite taking private inputs. Needs no keys. Use this to " +
        "answer 'what does this program reveal?' before trusting it with data.",
      inputSchema: {
        program_id: z
          .string()
          .describe("Program ID ending in '.aleo', e.g. 'credits.aleo'."),
        function_name: z
          .string()
          .optional()
          .describe("Only report this one function. Omit for the whole program."),
        network: networkArg,
      },
    },
    async ({ program_id, function_name, network }): Promise<ToolResult> => {
      const net = resolveNetwork(network as NetworkName | undefined);
      const id = program_id.trim();

      if (!isProgramId(id)) {
        return fail(
          null,
          `"${id}" is not a valid program ID. Program IDs are lowercase and end ` +
            "in '.aleo' — e.g. 'credits.aleo'.",
        );
      }

      try {
        const analysis = analyzeProgram(await fetchSource(net, id));

        const wanted = function_name?.trim().toLowerCase();
        const shown = wanted
          ? analysis.functions.filter((f) => f.name.toLowerCase() === wanted)
          : analysis.functions;

        if (wanted && !shown.length) {
          const available = analysis.functions.map((f) => f.name).join(", ");
          return fail(
            null,
            `\`${id}\` has no function named '${function_name}'. ` +
              (available ? `It defines: ${available}.` : "It defines no functions."),
          );
        }

        const lines: string[] = [
          `**Privacy analysis — ${id}** on ${net.name}`,
          "",
        ];

        if (!wanted) {
          const { totals } = analysis;
          lines.push(
            `- Functions: ${analysis.functions.length}`,
            `- Private inputs: ${totals.privateInputs + totals.recordInputs} ` +
              `(${totals.recordInputs} record) · Public inputs: ${totals.publicInputs}`,
            `- Records defined: ${analysis.records.length ? analysis.records.map((r) => `\`${r}\``).join(", ") : "none"}`,
            `- Public mappings: ${analysis.mappings.length ? analysis.mappings.map((m) => `\`${m}\``).join(", ") : "none"}`,
            `- Public mapping writes: ${totals.mappingWrites}`,
          );
          if (analysis.imports.length) {
            lines.push(
              `- Imports: ${analysis.imports.map((i) => `\`${i}\``).join(", ")} ` +
                "_(analyze these separately — their leaks are yours too)_",
            );
          }
          lines.push("");
        }

        if (analysis.findings.length && !wanted) {
          lines.push("**What this reveals**", "");
          for (const f of analysis.findings.slice(0, 12)) {
            const tag = f.severity === "warn" ? "⚠" : f.severity === "note" ? "•" : "·";
            lines.push(`${tag} \`${f.fn}\` — ${f.message}`);
          }
          if (analysis.findings.length > 12) {
            lines.push(`_… and ${analysis.findings.length - 12} more._`);
          }
          lines.push("");
        }

        lines.push(wanted ? "**Function**" : "**Per-function detail**", "");
        for (const fn of shown.slice(0, 30)) {
          const sig = fn.inputs.length
            ? fn.inputs.map((i) => MODE_LABEL[i.mode]).join(", ")
            : "no inputs";
          lines.push(`\`${fn.name}\` — ${sig}`);

          for (const i of fn.inputs) {
            lines.push(`    in  ${i.register}: \`${i.type}\` → ${MODE_LABEL[i.mode]}`);
          }
          for (const o of fn.outputs) {
            lines.push(`    out ${o.register}: \`${o.type}\` → ${MODE_LABEL[o.mode]}`);
          }
          if (fn.mappingWrites.length) {
            const names = [...new Set(fn.mappingWrites)].map((m) => `\`${m}\``).join(", ");
            lines.push(`    ⚠ writes public mapping state: ${names}`);
          }
          if (fn.readsMappings) lines.push("    · reads public mapping state");
          lines.push("");
        }
        if (shown.length > 30) lines.push(`_… and ${shown.length - 30} more functions._`);

        lines.push(
          "_Static analysis of declared visibility. It cannot see how a caller " +
            "uses this program — passing a value publicly to a private parameter " +
            "still exposes it in the transaction._",
        );

        return ok(lines.join("\n"));
      } catch (err) {
        return fail(
          err,
          `Could not analyze '${id}'. Check the program exists on ${net.name}.`,
        );
      }
    },
  );

  server.registerTool(
    "olex_explain_transaction_privacy",
    {
      title: "Explain what a transaction reveals",
      description:
        "Inspect a real transaction and report, input by input and output by " +
        "output, what it made public and what stayed encrypted. Shows which values " +
        "are visible ciphertext, which are plaintext on-chain, and which outputs are " +
        "encrypted records that only their owner can read. Needs no keys.",
      inputSchema: {
        transaction_id: z
          .string()
          .describe("Transaction ID starting with 'at1'."),
        network: networkArg,
      },
    },
    async ({ transaction_id, network }): Promise<ToolResult> => {
      const net = resolveNetwork(network as NetworkName | undefined);
      const id = transaction_id.trim();

      if (!isTransactionId(id)) {
        return fail(
          null,
          `"${id.slice(0, 20)}..." is not a valid transaction ID. IDs start with 'at1'.`,
        );
      }

      try {
        const tx = await apiGet<Record<string, any>>(net, `/transaction/${id}`);
        const transitions: any[] = Array.isArray(tx?.execution?.transitions)
          ? tx.execution.transitions
          : tx?.fee?.transition
            ? [tx.fee.transition]
            : [];

        let publicCount = 0;
        let privateCount = 0;
        let recordCount = 0;

        const lines: string[] = [
          `**Privacy of transaction** \`${id}\``,
          "",
          `- Network: ${net.name}`,
          `- Type: ${tx?.type ?? "unknown"}`,
          `- Transitions: ${transitions.length}`,
          "",
        ];

        for (const [i, t] of transitions.entries()) {
          const inputs: any[] = Array.isArray(t?.inputs) ? t.inputs : [];
          const outputs: any[] = Array.isArray(t?.outputs) ? t.outputs : [];

          lines.push(
            `**${i + 1}. \`${t?.program ?? "?"}\` → \`${t?.function ?? "?"}\`**`,
          );

          for (const inp of inputs) {
            const type = String(inp?.type ?? "unknown");
            const value = inp?.value == null ? "" : String(inp.value);
            if (type === "public") {
              publicCount++;
              lines.push(`    in  PUBLIC — \`${truncate(value)}\` _(visible to everyone)_`);
            } else if (type === "private") {
              privateCount++;
              lines.push(`    in  private — ciphertext \`${truncate(value)}\``);
            } else if (type.startsWith("record")) {
              privateCount++;
              lines.push(`    in  private — record serial number \`${truncate(value)}\``);
            } else {
              lines.push(`    in  ${type} — \`${truncate(value)}\``);
            }
          }

          for (const out of outputs) {
            const type = String(out?.type ?? "unknown");
            const value = out?.value == null ? "" : String(out.value);
            if (type === "record") {
              recordCount++;
              lines.push(
                `    out encrypted record \`${truncate(value)}\` ` +
                  "_(only the owner's view key can read it)_",
              );
            } else if (type === "future") {
              lines.push(
                "    out future — runs on-chain in public finalize " +
                  "_(anything it writes becomes public)_",
              );
            } else if (type === "public") {
              publicCount++;
              lines.push(`    out PUBLIC — \`${truncate(value)}\``);
            } else {
              lines.push(`    out ${type} — \`${truncate(value)}\``);
            }
          }
          lines.push("");
        }

        lines.push(
          "**Summary**",
          "",
          `- Public values exposed: ${publicCount}`,
          `- Private values (ciphertext or record): ${privateCount}`,
          `- Encrypted records produced: ${recordCount}`,
          "",
          recordCount
            ? "Use `olex_decrypt_record` with the owner's view key to read those records."
            : "This transaction produced no encrypted records.",
          "",
          `Explorer: ${net.explorer}/transaction/${id}`,
        );

        return ok(lines.join("\n"));
      } catch (err) {
        return fail(
          err,
          `Transaction '${id}' was not found on ${net.name}. It may be unconfirmed, ` +
            "or on the other network.",
        );
      }
    },
  );

  server.registerTool(
    "olex_check_visibility",
    {
      title: "Check a type's visibility mode",
      description:
        "Explain the visibility of an Aleo type annotation such as 'u64.private', " +
        "'address.public' or 'credits.aleo/transfer_public.future'. Useful when " +
        "reading program source and deciding whether a value is exposed on-chain.",
      inputSchema: {
        type: z
          .string()
          .describe("A type annotation, e.g. 'u64.private' or 'address.public'."),
      },
    },
    async ({ type }): Promise<ToolResult> => {
      const text = type.trim();
      if (!text) return fail(null, "Give a type annotation, e.g. 'u64.private'.");

      const mode = modeOf(text);
      const explain: Record<Mode, string> = {
        private:
          "Encrypted in the transaction. Only the parties to the execution can read it; " +
          "the value never appears on-chain in the clear.",
        public:
          "Plaintext on-chain. Anyone reading the transaction sees this value — " +
          "including amounts and addresses.",
        record:
          "An encrypted record, readable only with the owner's view key. Spending it " +
          "publishes a serial number, which reveals that *some* record was spent but not which.",
        constant:
          "Fixed at compile time and public. Baked into the program, so it is visible to all.",
        future:
          "A deferred on-chain computation. The finalize body runs publicly, so every " +
          "value it touches — and every mapping it writes — becomes public.",
        unspecified:
          "No visibility mode declared. Aleo requires one on function parameters, so this " +
          "is likely a record field, a struct member, or an incomplete annotation.",
      };

      return ok(
        [
          `**\`${text}\`** — ${MODE_LABEL[mode]}`,
          "",
          explain[mode],
        ].join("\n"),
      );
    },
  );
}

/** Ciphertexts run to hundreds of characters; keep output readable. */
function truncate(value: string, max = 44): string {
  const text = value.replace(/^"|"$/g, "");
  return text.length > max ? `${text.slice(0, max)}…` : text || "(empty)";
}
