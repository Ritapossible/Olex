/**
 * Chain query tools — the read-only surface of Olex.
 *
 * These need no keys, no Leo CLI, and no funded account, which makes them the
 * dependable core of a live demo. Everything here was written against verified
 * responses from the public Provable API.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  apiGet,
  getLatestHeight,
  resolveNetwork,
  type NetworkName,
} from "../lib/network.js";
import {
  formatTimestamp,
  groupDigits,
  isAleoAddress,
  isProgramId,
  isTransactionId,
  microcreditsToCredits,
  parseTypedInt,
} from "../lib/format.js";
import { fail, ok, type ToolResult } from "./result.js";

const networkArg = z
  .enum(["testnet", "mainnet"])
  .optional()
  .describe("Which Aleo network to query. Defaults to testnet.");

interface BlockHeader {
  metadata?: {
    height?: number;
    timestamp?: number;
    round?: number;
    coinbase_target?: number;
    proof_target?: number;
  };
}

interface Block {
  block_hash?: string;
  previous_hash?: string;
  header?: BlockHeader;
  transactions?: unknown[];
  solutions?: unknown;
}

export function registerChainTools(server: McpServer): void {
  server.registerTool(
    "olex_network_status",
    {
      title: "Aleo network status",
      description:
        "Get the current status of an Aleo network: latest block height, block hash, " +
        "round, timestamp and proof target. Use this to confirm connectivity or to " +
        "check how recent the chain data is.",
      inputSchema: { network: networkArg },
    },
    async ({ network }): Promise<ToolResult> => {
      const net = resolveNetwork(network as NetworkName | undefined);
      try {
        const block = await apiGet<Block>(net, "/block/latest");
        const meta = block.header?.metadata ?? {};
        const height = meta.height;

        return ok(
          [
            `**Aleo ${net.name} — online**`,
            "",
            `- Latest block: **${height ? groupDigits(height) : "unknown"}**`,
            `- Block hash: \`${block.block_hash ?? "unknown"}\``,
            `- Round: ${meta.round ? groupDigits(meta.round) : "unknown"}`,
            `- Block time: ${formatTimestamp(meta.timestamp)}`,
            `- Proof target: ${meta.proof_target ? groupDigits(meta.proof_target) : "unknown"}`,
            `- Transactions in block: ${block.transactions?.length ?? 0}`,
            "",
            `Explorer: ${net.explorer}`,
          ].join("\n"),
        );
      } catch (err) {
        return fail(err, `Could not reach the Aleo ${net.name} API.`);
      }
    },
  );

  server.registerTool(
    "olex_get_balance",
    {
      title: "Get public balance",
      description:
        "Look up the PUBLIC credits balance of an Aleo address by reading the " +
        "credits.aleo account mapping. Note: this only sees public balances. " +
        "Private balances live in encrypted records and are invisible to anyone " +
        "without the view key — that is the point of Aleo.",
      inputSchema: {
        address: z
          .string()
          .describe("Aleo address starting with 'aleo1' (63 characters)."),
        network: networkArg,
      },
    },
    async ({ address, network }): Promise<ToolResult> => {
      const net = resolveNetwork(network as NetworkName | undefined);
      const addr = address.trim();

      if (!isAleoAddress(addr)) {
        return fail(
          null,
          `"${addr.slice(0, 20)}..." is not a valid Aleo address. ` +
            "Addresses start with 'aleo1' and are 63 characters long.",
        );
      }

      try {
        const raw = await apiGet(
          net,
          `/program/credits.aleo/mapping/account/${addr}`,
        );
        const micro = parseTypedInt(raw);

        if (micro === null) {
          return ok(
            [
              `**${addr}**`,
              "",
              "Public balance: **0 credits** — no entry in the `credits.aleo/account` mapping.",
              "",
              "This address has never held public credits on " +
                `${net.name}. It may still hold **private** balances in records, ` +
                "which cannot be read without the account's view key.",
            ].join("\n"),
          );
        }

        return ok(
          [
            `**${addr}**`,
            "",
            `Public balance: **${microcreditsToCredits(micro)} credits**`,
            `(${groupDigits(micro)} microcredits) on ${net.name}`,
            "",
            "_Private record balances are not included — they are encrypted on-chain._",
            "",
            `Explorer: ${net.explorer}/address/${addr}`,
          ].join("\n"),
        );
      } catch (err) {
        return fail(err, `Could not read the balance for ${addr}.`);
      }
    },
  );

  server.registerTool(
    "olex_get_program",
    {
      title: "Fetch deployed program source",
      description:
        "Fetch the deployed Aleo instruction source of a program by its ID " +
        "(for example 'credits.aleo'). Returns the on-chain bytecode-level source, " +
        "which the assistant can then read, explain or audit.",
      inputSchema: {
        program_id: z
          .string()
          .describe("Program ID ending in '.aleo', e.g. 'credits.aleo'."),
        network: networkArg,
      },
    },
    async ({ program_id, network }): Promise<ToolResult> => {
      const net = resolveNetwork(network as NetworkName | undefined);
      const id = program_id.trim();

      if (!isProgramId(id)) {
        return fail(
          null,
          `"${id}" is not a valid program ID. Program IDs are lowercase, ` +
            "may contain underscores and digits, and end in '.aleo' — e.g. 'credits.aleo'.",
        );
      }

      try {
        const source = await apiGet<string>(net, `/program/${id}`);
        const text = typeof source === "string" ? source : JSON.stringify(source, null, 2);
        const clean = text.replace(/^"|"$/g, "").replace(/\\n/g, "\n");

        let mappings: string[] = [];
        try {
          mappings = await apiGet<string[]>(net, `/program/${id}/mappings`);
        } catch {
          // Mappings are a nice-to-have; a program with none returns an error.
        }

        return ok(
          [
            `**${id}** on ${net.name}`,
            mappings.length ? `\nMappings: ${mappings.map((m) => `\`${m}\``).join(", ")}` : "",
            "",
            "```aleo",
            clean.length > 12_000 ? `${clean.slice(0, 12_000)}\n\n... (truncated)` : clean,
            "```",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } catch (err) {
        return fail(
          err,
          `Program '${id}' was not found on ${net.name}. Check the ID and network.`,
        );
      }
    },
  );

  server.registerTool(
    "olex_get_mapping_value",
    {
      title: "Read a program mapping value",
      description:
        "Read a single key from a deployed program's on-chain mapping. Mappings are " +
        "Aleo's public key-value storage. Use olex_get_program first if you need to " +
        "discover which mappings a program exposes.",
      inputSchema: {
        program_id: z.string().describe("Program ID, e.g. 'credits.aleo'."),
        mapping_name: z.string().describe("Mapping name, e.g. 'account'."),
        key: z.string().describe("The mapping key, e.g. an Aleo address."),
        network: networkArg,
      },
    },
    async ({ program_id, mapping_name, key, network }): Promise<ToolResult> => {
      const net = resolveNetwork(network as NetworkName | undefined);
      const id = program_id.trim();

      if (!isProgramId(id)) {
        return fail(null, `"${id}" is not a valid program ID.`);
      }

      try {
        const raw = await apiGet(
          net,
          `/program/${id}/mapping/${encodeURIComponent(mapping_name.trim())}/${encodeURIComponent(key.trim())}`,
        );
        const value =
          raw === null || String(raw) === "null"
            ? "_(no value set for this key)_"
            : `\`${String(raw).replace(/^"|"$/g, "")}\``;

        return ok(
          `**${id}** / \`${mapping_name}\` / \`${key}\`\n\nValue: ${value}\n\nNetwork: ${net.name}`,
        );
      } catch (err) {
        return fail(
          err,
          `Could not read ${id}/${mapping_name}. The mapping or key may not exist.`,
        );
      }
    },
  );

  server.registerTool(
    "olex_get_block",
    {
      title: "Fetch a block",
      description:
        "Fetch an Aleo block by height, or the latest block. Returns hash, round, " +
        "timestamp and the transaction IDs it contains.",
      inputSchema: {
        height: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Block height. Omit for the latest block."),
        network: networkArg,
      },
    },
    async ({ height, network }): Promise<ToolResult> => {
      const net = resolveNetwork(network as NetworkName | undefined);

      try {
        if (height !== undefined) {
          const tip = await getLatestHeight(net);
          if (height > tip) {
            return fail(
              null,
              `Block ${groupDigits(height)} does not exist yet — the current ` +
                `${net.name} tip is ${groupDigits(tip)}.`,
            );
          }
        }

        const path = height === undefined ? "/block/latest" : `/block/${height}`;
        const block = await apiGet<Block>(net, path);
        const meta = block.header?.metadata ?? {};
        const txs = Array.isArray(block.transactions) ? block.transactions : [];

        return ok(
          [
            `**Block ${meta.height ? groupDigits(meta.height) : "?"}** on ${net.name}`,
            "",
            `- Hash: \`${block.block_hash ?? "unknown"}\``,
            `- Previous: \`${block.previous_hash ?? "unknown"}\``,
            `- Round: ${meta.round ? groupDigits(meta.round) : "unknown"}`,
            `- Timestamp: ${formatTimestamp(meta.timestamp)}`,
            `- Transactions: ${txs.length}`,
          ].join("\n"),
        );
      } catch (err) {
        return fail(err, "Could not fetch that block.");
      }
    },
  );

  server.registerTool(
    "olex_get_transaction",
    {
      title: "Fetch a transaction",
      description:
        "Fetch an Aleo transaction by its ID (starts with 'at1'). Shows the " +
        "transaction type and the transitions it executed — note that transition " +
        "inputs and outputs may be private ciphertext.",
      inputSchema: {
        transaction_id: z.string().describe("Transaction ID starting with 'at1'."),
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
        const transitions: any[] =
          tx?.execution?.transitions ?? tx?.fee?.transition ? [] : [];
        const list: any[] = Array.isArray(tx?.execution?.transitions)
          ? tx.execution.transitions
          : transitions;

        const lines = list.map((t: any, i: number) => {
          const inputs = Array.isArray(t?.inputs) ? t.inputs : [];
          const privateCount = inputs.filter(
            (inp: any) => inp?.type === "private" || inp?.type === "record",
          ).length;
          return (
            `  ${i + 1}. \`${t?.program ?? "?"}\` → \`${t?.function ?? "?"}\`` +
            (inputs.length
              ? ` (${inputs.length} inputs, ${privateCount} private)`
              : "")
          );
        });

        return ok(
          [
            `**Transaction** \`${id}\``,
            "",
            `- Network: ${net.name}`,
            `- Type: ${tx?.type ?? "unknown"}`,
            `- Transitions: ${list.length}`,
            ...(lines.length ? ["", "Transitions:", ...lines] : []),
            "",
            `Explorer: ${net.explorer}/transaction/${id}`,
          ].join("\n"),
        );
      } catch (err) {
        return fail(
          err,
          `Transaction '${id}' was not found on ${net.name}. It may be unconfirmed, ` +
            "or on the other network.",
        );
      }
    },
  );
}
