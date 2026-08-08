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

const TIMEOUT_MS = Number(process.env.OLEX_TIMEOUT_MS ?? 15_000);

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? `timed out after ${TIMEOUT_MS}ms`
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
