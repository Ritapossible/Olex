/**
 * Value parsing, validation and human-facing formatting.
 *
 * Aleo returns typed literals as strings ("538849u64", "12field"). Stripping
 * those suffixes correctly matters: a silent parse failure here would show a
 * user the wrong balance, which is the worst class of bug this project can have.
 */

/** 1 Aleo credit = 1,000,000 microcredits. */
export const MICROCREDITS_PER_CREDIT = 1_000_000n;

const ADDRESS_RE = /^aleo1[023456789acdefghjklmnpqrstuvwxyz]{58}$/;
const TX_ID_RE = /^at1[023456789acdefghjklmnpqrstuvwxyz]{58}$/;
const PROGRAM_ID_RE = /^[a-z][a-z0-9_]*\.aleo$/;

export function isAleoAddress(value: string): boolean {
  return ADDRESS_RE.test(value.trim());
}

export function isTransactionId(value: string): boolean {
  return TX_ID_RE.test(value.trim());
}

export function isProgramId(value: string): boolean {
  return PROGRAM_ID_RE.test(value.trim());
}

/**
 * Strip an Aleo type suffix from a literal: "538849u64" -> 538849n.
 * Returns null for null/"null" (an absent mapping entry) so callers can
 * distinguish "no entry" from "zero".
 */
export function parseTypedInt(raw: unknown): bigint | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().replace(/^"|"$/g, "");
  if (text === "" || text === "null") return null;

  const match = text.match(/^(\d+)(?:u8|u16|u32|u64|u128|i8|i16|i32|i64|i128|field|group|scalar)?$/);
  if (!match?.[1]) return null;
  return BigInt(match[1]);
}

/** Format microcredits as a human-readable credit string: 538849n -> "0.538849". */
export function microcreditsToCredits(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / MICROCREDITS_PER_CREDIT;
  const frac = abs % MICROCREDITS_PER_CREDIT;
  const fracText = frac.toString().padStart(6, "0").replace(/0+$/, "");
  const body = fracText ? `${whole}.${fracText}` : whole.toString();
  return negative ? `-${body}` : body;
}

/** Convert a decimal credit string to microcredits without floating point. */
export function creditsToMicrocredits(credits: string): bigint {
  const text = credits.trim();
  if (!/^-?\d+(\.\d{1,6})?$/.test(text)) {
    throw new Error(
      `"${credits}" is not a valid credit amount (max 6 decimal places).`,
    );
  }
  const negative = text.startsWith("-");
  const [whole = "0", frac = ""] = text.replace(/^-/, "").split(".");
  const micro =
    BigInt(whole) * MICROCREDITS_PER_CREDIT + BigInt(frac.padEnd(6, "0"));
  return negative ? -micro : micro;
}

/** Thousands separators for readability in tool output. */
export function groupDigits(value: bigint | number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Unix seconds -> ISO string, tolerating missing/garbage input. */
export function formatTimestamp(seconds: unknown): string {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  return new Date(n * 1000).toISOString().replace(".000Z", "Z");
}
