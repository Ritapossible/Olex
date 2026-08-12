/**
 * The install page: one snippet per client.
 *
 * Every entry is the whole answer for one client: where the config lives, the
 * exact block, and the one thing that trips people up. Three shapes exist in
 * the wild and they are not interchangeable - most clients read `mcpServers`,
 * VS Code reads `servers`, Zed reads `context_servers`, and Codex reads TOML.
 * Getting that wrong fails silently with an empty tool list.
 */

import { $, initChrome } from "./core.js";

const SERVER_PATH = "/abs/path/olex/dist/index.js";

const MCP_SERVERS_JSON = `{
  "mcpServers": {
    "olex": {
      "command": "node",
      "args": ["${SERVER_PATH}"],
      "env": { "OLEX_NETWORK": "testnet" }
    }
  }
}`;

const CLIENTS = [
  {
    id: "claude-code",
    name: "Claude Code",
    where: "One command, no file to edit.",
    code: `claude mcp add olex -- node ${SERVER_PATH}`,
    note: "Add --scope user to get it in every project. claude mcp list confirms it connected.",
  },
  {
    id: "cursor",
    name: "Cursor",
    where: "~/.cursor/mcp.json for every project, or .cursor/mcp.json for one.",
    code: MCP_SERVERS_JSON,
    note: "Settings -> Tools & MCP lists the server and its tools once it starts.",
  },
  {
    id: "vscode",
    name: "VS Code",
    where: ".vscode/mcp.json in the workspace, or MCP: Open User Configuration.",
    code: `{
  "servers": {
    "olex": {
      "type": "stdio",
      "command": "node",
      "args": ["${SERVER_PATH}"],
      "env": { "OLEX_NETWORK": "testnet" }
    }
  }
}`,
    note: "The key is servers, not mcpServers. VS Code will not read Cursor's shape.",
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    where: "macOS: ~/Library/Application Support/Claude/claude_desktop_config.json · Windows: %APPDATA%\\Claude\\claude_desktop_config.json",
    code: MCP_SERVERS_JSON,
    note: "Restart the app after editing. This is still stdio on your machine, so the view-key tools work here.",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    where: "~/.codeium/windsurf/mcp_config.json",
    code: MCP_SERVERS_JSON,
    note: "Quit and reopen Windsurf. Closing the window alone does not reread the file.",
  },
  {
    id: "codex",
    name: "Codex CLI",
    where: "~/.codex/config.toml - TOML, and the key is snake_case.",
    code: `[mcp_servers.olex]
command = "node"
args = ["${SERVER_PATH}"]
env = { OLEX_NETWORK = "testnet" }`,
    note: `Or let the CLI write it: codex mcp add olex -- node ${SERVER_PATH}`,
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    where: "~/.gemini/settings.json",
    code: MCP_SERVERS_JSON,
    note: "Run /mcp inside the CLI to see the server and its tool count.",
  },
  {
    id: "zed",
    name: "Zed",
    where: "settings.json, via the zed: open settings action.",
    code: `{
  "context_servers": {
    "olex": {
      "command": "node",
      "args": ["${SERVER_PATH}"],
      "env": { "OLEX_NETWORK": "testnet" }
    }
  }
}`,
    note: "Zed keys MCP servers under context_servers, and speaks stdio only.",
  },
  {
    id: "cline",
    name: "Cline",
    where: "MCP Servers -> Configure MCP Servers, which opens cline_mcp_settings.json.",
    code: MCP_SERVERS_JSON,
    note: "Roo Code uses mcp_settings.json with the same block.",
  },
  {
    id: "other",
    name: "Any MCP client",
    where: "Anything that launches an MCP server over stdio.",
    code: MCP_SERVERS_JSON,
    note: "There is no port and no host to configure - the client spawns the process.",
  },
];

function selectClient(id) {
  const client = CLIENTS.find((c) => c.id === id) ?? CLIENTS[0];
  for (const btn of document.querySelectorAll(".client-tab")) {
    const on = btn.dataset.client === client.id;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", String(on));
  }
  $("client-where").textContent = client.where;
  $("client-code").textContent = client.code;
  $("client-note").textContent = client.note;
}

function renderClients() {
  const tabs = $("client-tabs");
  if (!tabs) return;
  for (const client of CLIENTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "client-tab";
    btn.dataset.client = client.id;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", "false");
    btn.setAttribute("aria-controls", "client-panel");
    btn.textContent = client.name;
    btn.addEventListener("click", () => selectClient(client.id));
    tabs.appendChild(btn);
  }
  selectClient(CLIENTS[0].id);
}

/* ── boot ─────────────────────────────────────────────────────────────── */

initChrome();
renderClients();
