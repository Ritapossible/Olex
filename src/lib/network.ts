/**
 * Network layer for Olex.
 *
 * Every call in here is read-only and unauthenticated. No key material ever
 * passes through this module - that separation is deliberate and load-bearing:
 * an AI agent can call anything here without any risk of moving funds.
 */

export type NetworkName = "testnet" | "mainnet";

export interface NetworkConfig {
  name: NetworkName;
  /** Base REST endpoint, including the /v1/<network> prefix. */
  api: string;
  /** Human-facing explorer, used to build links in tool output. */
  explorer: string;
}

const NETWORKS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    name: "testnet",
    api: "https://api.explorer.provable.com/v1/testnet",
    explorer: "https://testnet.aleoscan.io",
  },
  mainnet: {
    name: "mainnet",
    api: "https://api.explorer.provable.com/v1/mainnet",
    explorer: "https://aleoscan.io",
  },
};

/**
 * Testnet is the default everywhere. Pointing an autonomous agent at mainnet
 * has to be a deliberate act, not something it can drift into.
 */
export const DEFAULT_NETWORK: NetworkName =
  process.env.OLEX_NETWORK === "mainnet" ? "mainnet" : "testnet";

export function resolveNetwork(name?: NetworkName): NetworkConfig {
  return NETWORKS[name ?? DEFAULT_NETWORK];
}

export class AleoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = "AleoApiError";
  }
}

/**
 * Per-request budget, per network.
 *
 * Mainnet is materially slower than testnet: a cold mainnet request measured
 * 19.3s against the flat 15s budget this used to apply everywhere, which
 * surfaced to the caller as a timeout on a network that was in fact fine.
 * Testnet has never needed more than a couple of seconds, so it keeps the
 * shorter budget - a genuine outage there still reports itself quickly instead
 * of hanging for three quarters of a minute.
 *
 * OLEX_TIMEOUT_MS overrides both when set, so anyone who has already tuned it
 * keeps exactly the behaviour they configured.
 */
const TIMEOUT_OVERRIDE_MS = process.env.OLEX_TIMEOUT_MS
  ? Number(process.env.OLEX_TIMEOUT_MS)
  : null;

const DEFAULT_TIMEOUT_MS: Record<NetworkName, number> = {
  testnet: 15_000,
  mainnet: 45_000,
};

function timeoutFor(net: NetworkConfig): number {
  return TIMEOUT_OVERRIDE_MS && Number.isFinite(TIMEOUT_OVERRIDE_MS)
    ? TIMEOUT_OVERRIDE_MS
    : DEFAULT_TIMEOUT_MS[net.name];
}

/**
 * GET a path relative to the network's API root.
 *
 * Returns parsed JSON when the response is JSON, otherwise the raw text -
 * several Aleo endpoints (program source, mapping values) return bare strings
 * rather than JSON objects, so callers must tolerate both.
 */
export async function apiGet<T = unknown>(
  net: NetworkConfig,
  path: string,
): Promise<T> {
  const url = `${net.api}${path}`;
  const timeoutMs = timeoutFor(net);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? `timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new AleoApiError(`Request to ${net.name} failed: ${reason}`, 0, path);
  } finally {
    clearTimeout(timer);
  }

  const body = await res.text();

  if (!res.ok) {
    throw new AleoApiError(
      `${net.name} API returned ${res.status} for ${path}` +
        (body ? `: ${body.slice(0, 300)}` : ""),
      res.status,
      path,
    );
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    return body as unknown as T;
  }
}

/** Latest block height as a number. */
export async function getLatestHeight(net: NetworkConfig): Promise<number> {
  const raw = await apiGet<number | string>(net, "/latest/height");
  const height = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(height)) {
    throw new AleoApiError(
      `Unexpected height response: ${String(raw).slice(0, 100)}`,
      200,
      "/latest/height",
    );
  }
  return height;
}
