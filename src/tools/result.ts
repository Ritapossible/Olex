/**
 * Shared shape for tool results.
 *
 * Errors are returned as content with isError set, never thrown — a thrown
 * error inside an MCP handler surfaces to the client as a protocol failure,
 * which reads to the user as "the tool is broken" rather than "the address
 * was wrong". Returning a readable message lets the assistant recover.
 */

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function fail(err: unknown, hint: string): ToolResult {
  const detail =
    err instanceof Error ? `\n\n_Detail: ${err.message}_` : "";
  return {
    content: [{ type: "text", text: `${hint}${detail}` }],
    isError: true,
  };
}
