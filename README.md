# Olex

**The bridge between AI agents and Aleo's privacy ecosystem.**

Olex is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives
AI assistants - Claude Code, Cursor, VS Code, or any MCP-compatible client - first-class
access to the [Aleo](https://aleo.org) privacy blockchain.

Ask your assistant *"what's the latest Aleo block height?"* or *"what does this program
leak?"* and it calls Olex directly, instead of you switching to a terminal.

---

## Status

| Area | State |
|---|---|
| Read-only chain tools (6) | working, verified against live testnet and mainnet |
| Privacy analysis tools (3) | working, verified against deployed programs |
| View-key tools (3) | working, local-only, opt-in |
| Unit conversion | working, exact bigint math |
| Guided prompts (3) | working |
| Web dashboard + docs | working, live data, switchable testnet/mainnet |
| Hosted HTTP bridge (10 tools) | working, view-key tools excluded by design |
| Leo compile / run / test | blocked, needs Leo CLI + Rust |
| Deploy / execute | blocked, needs Leo CLI + funded account |

Both networks are live. Testnet is the default because pointing an autonomous agent at
mainnet should be a deliberate act - not a scope limit. Every tool takes a per-call
`network` argument, and `OLEX_NETWORK` moves the default.

Everything listed as working is exercised end-to-end by `npm run smoke` (real stdio
JSON-RPC against the live network) and `npm run smoke:http` (the hosted bridge over a
real socket). Nothing in this README is aspirational.

---

## Tools

13 tools over stdio. 10 over the hosted bridge - the three view-key tools are stdio-only,
for reasons in [Two surfaces](#two-surfaces).

### Chain

| Tool | What it does |
|---|---|
| `olex_network_status` | Latest height, hash, round, timestamp, proof target |
| `olex_get_balance` | Public credits balance from the `credits.aleo` account mapping |
| `olex_get_program` | Deployed Aleo instruction source + mapping list |
| `olex_get_mapping_value` | One key from any program's on-chain mapping |
| `olex_get_block` | Any block by height, or the chain tip |
| `olex_get_transaction` | A transaction by ID, with its transitions |

### Privacy analysis

| Tool | What it does |
|---|---|
| `olex_analyze_privacy` | Reads a deployed program and reports, per function parameter, what is public and what stays encrypted |
| `olex_explain_transaction_privacy` | Walks a landed transaction's transitions and says what it actually revealed on-chain |
| `olex_check_visibility` | Resolves a single type annotation (`u64.private`, `address.public`) to its visibility mode |

### View key (stdio only)

| Tool | What it does |
|---|---|
| `olex_decrypt_record` | Decrypts one record ciphertext, if the view key owns it |
| `olex_true_balance` | Public balance plus the private balance the view key can see |
| `olex_view_key_address` | Derives the address a view key belongs to |

### Utility

| Tool | What it does |
|---|---|
| `olex_convert_credits` | Credits and microcredits, exact integer math |

---

## The privacy model

Aleo splits state in two:

- **Public** - mappings, readable by anyone.
- **Private** - encrypted records, readable only with the account's view key.

Two consequences shape every tool here.

**A public balance is a floor, not a total.** An address showing `0 credits` public may
hold any amount privately. Olex cannot see it, and neither can anyone else without the
view key. Every balance tool says so in its own output, so the assistant reports a floor
rather than a misleading zero.

**Visibility is decided per parameter, never per program.** There is no such thing as a
"private program." A single transition routinely takes a private amount and a public
recipient. `olex_analyze_privacy` reports per parameter for exactly this reason - a
program-level verdict would be wrong on almost every real program.

---

## View keys

Three tools can read private state. They are opt-in, they run only on your machine, and
they are absent from the hosted bridge entirely.

A view key (`AViewKey1...`) grants permanent read access to every record the account has
ever received. It cannot move funds. Olex never asks for a private key (`APrivateKey1...`)
and has no tool that would accept one.

Provide the key by environment variable:

```bash
OLEX_VIEW_KEY=AViewKey1... node /absolute/path/to/olex/dist/index.js
```

`OLEX_VIEW_KEY` always takes precedence over a `view_key` tool argument. Prefer it: an
argument is written into the conversation transcript, an environment variable is not. The
key is never echoed back in tool output, whole or partial, on success or on failure.

## Prompts

Three guided prompts ship with the server, so common questions do not have to be
re-derived by the assistant each time.

| Prompt | Asks |
|---|---|
| `audit-program-privacy` | What does this program expose, per parameter? |
| `explain-transaction-privacy` | What did this transaction actually reveal? |
| `true-balance` | Public plus private, using my view key (stdio only) |

---

## Two surfaces

Olex runs on two surfaces, and the difference is a security boundary rather than a
configuration flag.

```
stdio (your machine)                hosted bridge (Vercel)
13 tools, 3 prompts                 10 tools, 2 prompts
src/index.ts                        api/mcp.js
  createServer({viewKeyTools:true})   createServer()
  + registerVaultTools()              (no vault import)
```

The view-key tools are registered in `src/index.ts`, not inside `createServer()`. The
hosted bridge imports `createServer` and nothing else, so it cannot reach them - the
tools are not disabled on the bridge, they are not present in its bundle at all. The
WASM cryptography they depend on stays out of the serverless build for the same reason.

This is enforced by construction rather than by a runtime check, because a runtime check
is one bad edit away from being wrong. `api/mcp.js` then names its ten tools in an
explicit allowlist - a second, independent barrier, so a stray future export cannot
become reachable from the browser by accident.

**The bridge is not an endpoint you register with an MCP client.** It exists so the web
playground exercises the real product rather than a browser-side reimplementation of it:
each POST spins up a genuine MCP client/server pair over an in-memory transport, does the
real handshake, and dispatches a real `tools/call`. The tool code that runs is the same
code an editor gets over stdio. It speaks plain JSON (`{"tool": ..., "arguments": {...}}`,
or `{"method": "tools/list"}`), not the MCP wire protocol, because a serverless
invocation cannot hold the session state a streamable-HTTP transport requires between
the handshake and the call.

So: to use Olex from an assistant, install it over stdio as above. To host the dashboard
and playground yourself, deploy the repo to Vercel - `vercel.json` carries the build,
routing, and CSP configuration, and the bridge needs no secrets, since it holds no key
material by construction.

---

## Install

Node 20 or newer. Nothing else - no Rust, no Leo CLI, no local node. Olex reads
the public Aleo REST API over HTTPS.

```bash
git clone https://github.com/Ritapossible/Olex.git
cd Olex
npm install
npm run build
```

Then register the built server with your client. Two of them can write their own
config:

```bash
claude mcp add olex -- node /absolute/path/to/olex/dist/index.js   # Claude Code
codex mcp add olex -- node /absolute/path/to/olex/dist/index.js    # Codex CLI
```

Everything else is a file you edit. Find your client, then use the matching
shape below:

| Client | Config file | Key |
|---|---|---|
| Claude Code | `claude mcp add`, or `.mcp.json` in the project | `mcpServers` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)<br>`%APPDATA%\Claude\claude_desktop_config.json` (Windows) | `mcpServers` |
| Cursor | `~/.cursor/mcp.json`, or `.cursor/mcp.json` per project | `mcpServers` |
| VS Code | `.vscode/mcp.json`, or *MCP: Open User Configuration* | `servers` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| Codex CLI | `~/.codex/config.toml` | `mcp_servers` (TOML) |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` |
| Zed | `settings.json`, via *zed: open settings* | `context_servers` |
| Cline / Roo Code | `cline_mcp_settings.json` / `mcp_settings.json` | `mcpServers` |

The key is the part that bites. A correct block under the wrong key fails
silently - the client starts, reports nothing, and the server is simply absent
from the tool list.

**Most clients** - Claude Code, Claude Desktop, Cursor, Windsurf, Gemini CLI,
Cline:

```json
{
  "mcpServers": {
    "olex": {
      "command": "node",
      "args": ["/absolute/path/to/olex/dist/index.js"],
      "env": {
        "OLEX_NETWORK": "testnet"
      }
    }
  }
}
```

**VS Code** - top-level `servers`, with an explicit `type`:

```json
{
  "servers": {
    "olex": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/olex/dist/index.js"],
      "env": {
        "OLEX_NETWORK": "testnet"
      }
    }
  }
}
```

**Zed** - context servers, stdio only, which is all Olex needs:

```json
{
  "context_servers": {
    "olex": {
      "command": "node",
      "args": ["/absolute/path/to/olex/dist/index.js"],
      "env": {
        "OLEX_NETWORK": "testnet"
      }
    }
  }
}
```

**Codex CLI** - TOML, snake_case key:

```toml
[mcp_servers.olex]
command = "node"
args = ["/absolute/path/to/olex/dist/index.js"]
env = { OLEX_NETWORK = "testnet" }
```

The path must be absolute: the client launches the server from its own working
directory, not yours. On Windows, escape the separators
(`C:\\path\\to\\olex\\dist\\index.js`) or use forward slashes - Node accepts
both, but a lone backslash in JSON is an escape character and will not survive
parsing. Restart the client after editing; most read MCP config only at startup,
and Windsurf needs a full quit rather than a closed window.

To enable the view-key tools, add `OLEX_VIEW_KEY` to the same `env` block. Every
client here launches Olex over stdio on your own machine, so the key stays local
- but the config file is plain text on disk, so if that is not where you want a
view key, export the variable in the shell you launch the client from instead.

Then ask your assistant:

> What's the latest Aleo block height?
> What does credits.aleo expose publicly?
> What did transaction at1... reveal on-chain?

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OLEX_NETWORK` | `testnet` | Set to `mainnet` to switch default network |
| `OLEX_TIMEOUT_MS` | `15000` testnet / `45000` mainnet | Per-request timeout. Set it to override both defaults |
| `OLEX_VIEW_KEY` | unset | Enables the view-key tools. Never committed, never logged |

Testnet is the default everywhere. Pointing an autonomous agent at mainnet has to be
a deliberate act, not something it can drift into.

---

## Verify it works

```bash
npm run smoke       # drives the real server over stdio against live testnet
npm run smoke:http  # drives the hosted bridge handler over a real socket
npm run inspect     # opens the official MCP Inspector web UI
```

`npm run inspect` prints a `localhost` URL with an auth token - that is the closest
thing to a "live URL" an MCP server has. MCP servers speak JSON-RPC over stdin/stdout;
they are launched by the client, not hosted on a port.

The smoke suites assert against live chain data, so they derive expected values from the
response rather than hardcoding counts. A hardcoded count is a test that passes until the
chain changes and then lies about which side is broken.

---

## Dashboard and docs

A static frontend lives in `web/`, with no build step and no framework. It calls the
public Aleo API directly from the browser (verified `Access-Control-Allow-Origin: *`),
so it needs no backend:

```bash
node scripts/serve-web.mjs   # http://127.0.0.1:8080
```

Use that rather than `python -m http.server`: the pages link to `./docs` without an
extension, which production resolves through Vercel's `cleanUrls`. A plain static
server returns 404 for it, so the Docs link appears broken when the site is fine.

- `/` - live block height, a block-interval sparkline, a recent-blocks feed, and a
  playground that runs the same queries the MCP tools run.
- `/docs` - the full reference: install, configuration, privacy model, every tool,
  prompts, and the two-surface split.

Both pages carry a testnet/mainnet switch. The choice is shared between them and
persists across reloads, so the dashboard's figures and the network named in the docs'
install snippets always agree.

The chart palette was validated for colorblind separation and contrast rather than
picked by eye - the blue/orange/aqua series clear all-pairs CVD dE >= 8 and
normal-vision dE >= 15 against the dark surface. A fourth hue was dropped because
yellow-beside-orange failed those checks. Nothing on either page conveys meaning by hue
alone; state is always carried by a label, an icon, or a shape as well.

---

## Architecture

```
Claude Code / Cursor / VS Code
            |  JSON-RPC over stdio
     +------+------+
     |  Olex MCP   |
     +------+------+
            |  HTTPS
   Aleo public REST API
```

```
src/
  index.ts            stdio entry point, registers view-key tools
  server.ts           shared server factory, no key material
  prompts.ts          guided prompts, gated on surface
  lib/network.ts      network config + fetch, read-only
  lib/format.ts       typed-literal parsing, exact credit math
  lib/analyze.ts      Aleo instruction parsing, pure, no I/O
  lib/privacy.ts      view-key handling and record decryption
  tools/chain.ts      the six chain tools
  tools/privacy.ts    program and transaction privacy analysis
  tools/vault.ts      view-key tools, stdio only
  tools/utils.ts      unit conversion
  tools/result.ts     shared result shape
api/mcp.js            hosted HTTP bridge, no vault import
scripts/smoke.mjs     end-to-end test over real stdio
scripts/smoke-http.mjs  end-to-end test of the hosted bridge
scripts/serve-web.mjs   local static server, matches production URL rules
web/                  static dashboard and docs
```

Errors are returned as tool results with `isError`, never thrown - a thrown error
reads to the user as "the tool is broken" rather than "the address was wrong."

---

## License

MIT

