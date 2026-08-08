/**
 * MCP prompts - named workflows, not just tools.
 *
 * A tool list asks the user to know which tool to reach for. A prompt states an
 * intent ("audit this program's privacy") and lets the model plan the calls. In
 * an MCP client these appear as slash commands, which is the difference between
 * shipping an API and shipping a product.
 *
 * Prompts return instructions for the model, so they must not assume a tool
 * exists on a surface where it does not - hence the viewKeyTools flag.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface PromptOptions {
  viewKeyTools: boolean;
}

/** MCP prompt arguments are strings on the wire, so every field is a string. */
function userMessage(text: string) {
  return {
    messages: [
      { role: "user" as const, content: { type: "text" as const, text } },
    ],
  };
}

export function registerPrompts(
  server: McpServer,
  options: PromptOptions,
): void {
  server.registerPrompt(
    "audit-program-privacy",
    {
      title: "Audit a program's privacy",
      description:
        "Analyze a deployed Aleo program and report, in plain language, what it " +
        "keeps private and what it exposes on-chain.",
      argsSchema: {
        program_id: z.string().describe("Program ID, e.g. 'credits.aleo'."),
        network: z
          .string()
          .optional()
          .describe("'testnet' (default) or 'mainnet'."),
      },
    },
    ({ program_id, network }) =>
      userMessage(
        `Audit the privacy of the Aleo program \`${program_id}\`` +
          `${network ? ` on ${network}` : ""}.\n\n` +
          "Steps:\n" +
          "1. Call `olex_analyze_privacy` for the program.\n" +
          "2. Call `olex_get_program` if you need the source to explain a finding.\n" +
          "3. Report, for a developer deciding whether to trust it with data:\n" +
          "   - What genuinely stays private (encrypted records, private inputs).\n" +
          "   - What is public despite looking private - especially any value " +
          "that reaches mapping state, since mappings are readable by anyone.\n" +
          "   - Which specific functions to avoid if the amount must stay hidden.\n\n" +
          "Be concrete: name functions and parameters. Do not claim a program is " +
          "private overall - privacy on Aleo is decided per parameter.",
      ),
  );

  server.registerPrompt(
    "explain-transaction-privacy",
    {
      title: "What did this transaction reveal?",
      description:
        "Walk through a real transaction and explain, value by value, what it " +
        "made public and what stayed encrypted.",
      argsSchema: {
        transaction_id: z.string().describe("Transaction ID starting with 'at1'."),
        network: z
          .string()
          .optional()
          .describe("'testnet' (default) or 'mainnet'."),
      },
    },
    ({ transaction_id, network }) =>
      userMessage(
        `Explain what transaction \`${transaction_id}\`` +
          `${network ? ` on ${network}` : ""} revealed publicly.\n\n` +
          "Call `olex_explain_transaction_privacy`, then summarise for someone " +
          "who does not read Aleo internals: what an observer learns from this " +
          "transaction, what remains hidden, and whether the amounts were " +
          "exposed. If it produced encrypted records, say who could read them " +
          "and what would be needed to do so.",
      ),
  );

  if (!options.viewKeyTools) return;

  server.registerPrompt(
    "true-balance",
    {
      title: "My true balance (public + private)",
      description:
        "Compute the real total balance of an account, including the private " +
        "records a block explorer cannot see. Uses a local view key.",
      argsSchema: {
        transaction_id: z
          .string()
          .optional()
          .describe("A transaction to scan for your records."),
        from_block: z.string().optional().describe("Start of a block range."),
        to_block: z.string().optional().describe("End of a block range."),
      },
    },
    ({ transaction_id, from_block, to_block }) => {
      const scope = transaction_id
        ? `Scan transaction \`${transaction_id}\`.`
        : from_block
          ? `Scan blocks ${from_block} to ${to_block ?? from_block}.`
          : "Ask the user which transaction or block range to scan - an " +
            "unbounded scan is not supported, and the testnet is mostly idle so " +
            "a recent range will usually be empty.";

      return userMessage(
        "Work out my true Aleo balance, including private funds.\n\n" +
          `${scope}\n\n` +
          "Steps:\n" +
          "1. Call `olex_view_key_address` first to confirm the view key is " +
          "configured and show which account it unlocks.\n" +
          "2. Call `olex_true_balance` for the scope above.\n" +
          "3. Explain the split: how much is public (what an explorer shows) " +
          "versus private (what only the view key reveals), and state plainly " +
          "that the private figure covers only the range scanned.\n\n" +
          "If no view key is configured, tell me to set OLEX_VIEW_KEY rather " +
          "than pasting a key into the chat, and never ask for a private key.",
      );
    },
  );
}
