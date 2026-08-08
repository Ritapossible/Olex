/**
 * Unit conversion helpers.
 *
 * Exact integer math only - credit amounts must never round-trip through a
 * JS float. 0.1 + 0.2 problems are unacceptable when the output is a balance.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  creditsToMicrocredits,
  groupDigits,
  microcreditsToCredits,
} from "../lib/format.js";
import { fail, ok, type ToolResult } from "./result.js";

export function registerUtilTools(server: McpServer): void {
  server.registerTool(
    "olex_convert_credits",
    {
      title: "Convert credits and microcredits",
      description:
        "Convert between Aleo credits and microcredits (1 credit = 1,000,000 " +
        "microcredits). Uses exact integer arithmetic - safe for balances and fees.",
      inputSchema: {
        amount: z
          .string()
          .describe("The amount to convert, as a string, e.g. '1.5' or '2500000'."),
        from: z
          .enum(["credits", "microcredits"])
          .describe("The unit of the input amount."),
      },
    },
    async ({ amount, from }): Promise<ToolResult> => {
      try {
        if (from === "credits") {
          const micro = creditsToMicrocredits(amount);
          return ok(
            `**${amount} credits** = **${groupDigits(micro)} microcredits**\n\n` +
              "_Aleo transaction fees are denominated in microcredits._",
          );
        }

        const text = amount.trim().replace(/[_,]/g, "");
        if (!/^-?\d+$/.test(text)) {
          return fail(
            null,
            `"${amount}" is not a whole number. Microcredits are indivisible - ` +
              "they cannot have decimal places.",
          );
        }
        const micro = BigInt(text);
        return ok(
          `**${groupDigits(micro)} microcredits** = **${microcreditsToCredits(micro)} credits**`,
        );
      } catch (err) {
        return fail(err, "Could not convert that amount.");
      }
    },
  );
}
