/**
 * View keys and record decryption — the only module that touches key material.
 *
 * Aleo records are encrypted to their owner. Reading one requires that account's
 * view key, which is secret: it grants permanent read access to every record the
 * account has ever received. Three rules follow, and they are enforced here
 * rather than left to each call site.
 *
 * 1. A view key is read from OLEX_VIEW_KEY by preference. A key passed as a tool
 *    argument travels through the model's context and lands in the provider's
 *    logs; an env var does not. The argument stays supported as a fallback so a
 *    first-time demo works with no setup, but the env var always wins.
 * 2. No view key is ever returned in output, whole or partial, on success or on
 *    failure. Callers get `redactViewKey` for anything derived from user input.
 * 3. The WASM bindings throw bare strings like "unreachable" for malformed keys.
 *    Those must never reach a user, so every SDK entry point here is wrapped and
 *    re-thrown as an Error with text a developer can act on.
 *
 * `src/lib/network.ts` states that no key material passes through it. That
 * separation holds: this module performs no I/O and imports nothing from there.
 */

import type {
  Account,
  RecordCiphertext,
  RecordPlaintext,
  ViewKey,
} from "@provablehq/sdk";

/**
 * The SDK is loaded on demand, not at import time.
 *
 * It is WASM-backed and costs real time and memory to instantiate. Loading it
 * lazily means a session that never touches a view key never pays for it, and —
 * more importantly — no WASM initialisation runs during stdio startup, where a
 * single stray byte on stdout would corrupt the JSON-RPC stream. `import type`
 * above is erased at compile time, so this file pulls in nothing at runtime
 * until `loadCrypto()` is awaited.
 */
type Sdk = typeof import("@provablehq/sdk");
let sdk: Sdk | null = null;

export async function loadCrypto(): Promise<void> {
  if (!sdk) sdk = await import("@provablehq/sdk");
}

/** Every sync entry point below goes through this, so the failure is legible. */
function crypto(): Sdk {
  if (!sdk) {
    throw new Error(
      "Cryptography module was not loaded. This is a bug in Olex: call " +
        "loadCrypto() before using view-key functions.",
    );
  }
  return sdk;
}

/** Where a view key came from, so output can say so without echoing it. */
export type KeySource = "env" | "argument";

export interface ResolvedKey {
  viewKey: ViewKey;
  source: KeySource;
}

const ENV_VAR = "OLEX_VIEW_KEY";
const VIEW_KEY_RE = /^AViewKey1[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{44,60}$/;

/**
 * Strip anything that looks like a view key or private key out of text.
 *
 * Applied to error detail before it is shown. A malformed key often appears
 * verbatim in a library's message, and that message would otherwise be echoed
 * straight back into the transcript.
 */
export function redactViewKey(text: string): string {
  return text
    .replace(/AViewKey1[A-Za-z0-9]+/g, "AViewKey1<redacted>")
    .replace(/APrivateKey1[A-Za-z0-9]+/g, "APrivateKey1<redacted>");
}

/**
 * Parse a view key string, converting WASM failures into readable errors.
 *
 * The bindings throw the string "unreachable" for a malformed key, which tells a
 * user nothing. The shape is checked first so the common typo gets a precise
 * message, and the SDK call is still wrapped in case it rejects a
 * correctly-shaped but invalid key.
 */
export function parseViewKey(raw: string): ViewKey {
  const text = raw.trim();

  if (!text) {
    throw new Error(
      `No view key supplied. Set ${ENV_VAR} in the environment, or pass view_key.`,
    );
  }

  if (!text.startsWith("AViewKey1")) {
    throw new Error(
      "That does not look like an Aleo view key. View keys start with " +
        "'AViewKey1'. A private key (APrivateKey1...) or an address (aleo1...) " +
        "will not work here.",
    );
  }

  if (!VIEW_KEY_RE.test(text)) {
    throw new Error(
      "That view key is not a valid length or contains characters outside the " +
        "bech32 alphabet. Check it was copied whole, with no line break.",
    );
  }

  try {
    return crypto().ViewKey.from_string(text);
  } catch {
    // Intentionally discards the underlying message: it is either "unreachable"
    // or may quote the key itself.
    throw new Error(
      "That view key could not be parsed. It is well-formed but not a valid " +
        "Aleo view key.",
    );
  }
}

/**
 * Resolve a view key from the environment, falling back to an argument.
 *
 * Env-first is deliberate: if OLEX_VIEW_KEY is set, an argument is ignored
 * entirely rather than being allowed to override a key the user configured
 * locally.
 */
export function resolveViewKey(argument?: string): ResolvedKey {
  const fromEnv = process.env[ENV_VAR]?.trim();
  if (fromEnv) {
    return { viewKey: parseViewKey(fromEnv), source: "env" };
  }
  return { viewKey: parseViewKey(argument ?? ""), source: "argument" };
}

/** The address a view key belongs to, for reporting and public-balance lookup. */
export function addressFromViewKey(viewKey: ViewKey): string {
  try {
    return viewKey.to_address().to_string();
  } catch {
    throw new Error("Could not derive an address from that view key.");
  }
}

/** A throwaway account for tests and examples. Never used for real keys. */
export function seededAccount(seed: number): Account {
  return new (crypto().Account)({ seed: new Uint8Array(32).fill(seed) });
}

export type DecryptOutcome =
  | { status: "decrypted"; record: RecordPlaintext }
  | { status: "not-owned" }
  | { status: "invalid"; reason: string };

/**
 * Decrypt a record if the view key owns it.
 *
 * Returns an outcome instead of throwing, because "someone else's record" is a
 * normal result when scanning a block — most records will not be yours. Ownership
 * is checked with `isOwner` first, which avoids attempting decryption on every
 * ciphertext in a scan.
 */
export function decryptIfOwned(
  ciphertext: string,
  viewKey: ViewKey,
): DecryptOutcome {
  let parsed: RecordCiphertext;
  try {
    parsed = crypto().RecordCiphertext.fromString(ciphertext.trim());
  } catch {
    return {
      status: "invalid",
      reason:
        "not a valid record ciphertext. Encrypted records start with 'record1'.",
    };
  }

  try {
    if (!parsed.isOwner(viewKey)) return { status: "not-owned" };
    return { status: "decrypted", record: parsed.decrypt(viewKey) };
  } catch (err) {
    // isOwner said yes but decryption failed: report it rather than claim the
    // record is someone else's.
    return {
      status: "invalid",
      reason: redactViewKey(
        err instanceof Error ? err.message : "decryption failed",
      ),
    };
  }
}

/** Microcredit value of a decrypted record, or null if it holds no credits. */
export function recordMicrocredits(record: RecordPlaintext): bigint | null {
  try {
    const value = record.microcredits();
    return typeof value === "bigint" ? value : BigInt(value ?? 0);
  } catch {
    return null;
  }
}

/**
 * Human-readable field list for a decrypted record.
 *
 * `toJsObject` returns the plaintext members; values are stringified because
 * they arrive as a mix of bigints and typed literals.
 */
export function recordFields(record: RecordPlaintext): Array<[string, string]> {
  try {
    const obj = record.toJsObject() as Record<string, unknown>;
    return Object.entries(obj).map(([k, v]) => [k, String(v)]);
  } catch {
    return [];
  }
}
