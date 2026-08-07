# Olex

**The bridge between AI agents and Aleo's privacy ecosystem.**

Olex is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives
AI assistants — Claude Code, Cursor, VS Code, or any MCP-compatible client — first-class
access to the [Aleo](https://aleo.org) privacy blockchain.

Ask your assistant *"what's the latest Aleo block height?"* or *"show me the credits.aleo
program"* and it calls Olex directly, instead of you switching to a terminal.

---

## Status

| Area | State |
|---|---|
| Read-only chain tools (6) | ✅ working, verified against live testnet |
| Unit conversion | ✅ working, exact bigint math |
| Web dashboard | ✅ working, live testnet data |
| Wallet tools | ⬜ not started |
| Leo compile / run / test | ⬜ blocked — needs Leo CLI + Rust |
| Deploy / execute | ⬜ blocked — needs Leo CLI + funded account |
| Docs search, audit, explain | ⬜ not started |

Everything marked ✅ has been exercised end-to-end by `npm run smoke`, which drives the
built server over real stdio JSON-RPC against the live network. Nothing in this README
is aspirational.

---

## Tools

| Tool | What it does |
|---|---|
| `olex_network_status` | Latest height, hash, round, timestamp, proof target |
| `olex_get_balance` | Public credits balance from the `credits.aleo` account mapping |
| `olex_get_program` | Deployed Aleo instruction source + mapping list |
| `olex_get_mapping_value` | One key from any program's on-chain mapping |
| `olex_get_block` | Any block by height, or the chain tip |
| `olex_get_transaction` | A transaction by ID, with its transitions |
| `olex_convert_credits` | Credits ⇄ microcredits, exact integer math |

### On privacy

Aleo splits state in two:

- **Public** — mappings, readable by anyone. This is what Olex reads.
- **Private** — encrypted records, readable only with the account's view key.

Every balance tool says so explicitly in its output. An address showing `0 credits`
public may hold a private balance; Olex cannot see it, and neither can anyone else
without the view key. That is the point of Aleo, and the tool descriptions teach the
assistant to say so rather than report a misleading zero.

**Olex holds no keys and signs nothing.** Every tool shipped today is read-only and
unauthenticated, so an agent can call any of them without any possibility of moving funds.

---

## Install

```bash
npm install
npm run build
```

Register with Claude Code:

```bash
claude mcp add olex -- node /absolute/path/to/olex/dist/index.js
```

Or add to your MCP client config manually:

```json
{
  "mcpServers": {
    "olex": {
      "command": "node",
      "args": ["/absolute/path/to/olex/dist/index.js"]
    }
  }
}
```

Then ask your assistant:

> What's the latest Aleo block height?
> Show me the source of credits.aleo.
> What's the public balance of aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px?

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OLEX_NETWORK` | `testnet` | Set to `mainnet` to switch default network |
| `OLEX_TIMEOUT_MS` | `15000` | Per-request timeout |

Testnet is the default everywhere. Pointing an autonomous agent at mainnet has to be
a deliberate act, not something it can drift into.

---

## Verify it works

```bash
npm run smoke      # drives the real server over stdio against live testnet
npm run inspect    # opens the official MCP Inspector web UI
```

`npm run inspect` prints a `localhost` URL with an auth token — that is the closest
thing to a "live URL" an MCP server has. MCP servers speak JSON-RPC over stdin/stdout;
they are launched by the client, not hosted on a port.

---

## Dashboard

A static dashboard lives in `web/`. It calls the public Aleo API directly from the
browser (verified `Access-Control-Allow-Origin: *`), so it needs no backend:

```bash
cd web && python -m http.server 8080
```

Open http://127.0.0.1:8080. It shows live block height, a block-interval
sparkline, a recent-blocks feed, and a playground that runs the same queries the MCP
tools run.

The chart palette was validated for colorblind separation and contrast rather than
picked by eye — the blue/orange/aqua series clear all-pairs CVD ΔE ≥ 8 and
normal-vision ΔE ≥ 15 against the dark surface. A fourth hue was dropped because
yellow-beside-orange failed those checks.

---

## Architecture

```
Claude Code / Cursor / VS Code
            │  JSON-RPC over stdio
     ┌──────┴──────┐
     │  Olex MCP   │
     └──────┬──────┘
            │  HTTPS
   Aleo public REST API
```

```
src/
  index.ts          server bootstrap, stdio transport
  lib/network.ts    network config + fetch, read-only, no key material
  lib/format.ts     typed-literal parsing, exact credit math
  tools/chain.ts    the six chain tools
  tools/utils.ts    unit conversion
  tools/result.ts   shared result shape
scripts/smoke.mjs   end-to-end test over real stdio
web/                static dashboard
```

Errors are returned as tool results with `isError`, never thrown — a thrown error
reads to the user as "the tool is broken" rather than "the address was wrong."

---

## License

MIT
