/**
 * Static privacy analysis of deployed Aleo instruction source.
 *
 * Aleo's privacy is not a property of a program as a whole - it is decided per
 * parameter, by the visibility mode on each type. A program can be advertised as
 * private and still publish every amount it touches through a mapping write.
 * This module reads the deployed source and reports where the private/public
 * boundary actually falls, so an assistant can answer "what does this leak?"
 *
 * Deliberately pure: no network, no key material, no SDK. Everything here is a
 * string in and findings out, which keeps it testable and safe to expose on the
 * public web bridge.
 */

/** Visibility mode of a single input or output. */
export type Mode =
  | "private"
  | "public"
  | "record"
  | "constant"
  | "future"
  | "unspecified";

export interface Param {
  register: string;
  type: string;
  mode: Mode;
}

export interface FunctionInfo {
  name: string;
  kind: "function" | "transition" | "closure";
  inputs: Param[];
  outputs: Param[];
  /** Mapping names this function's async/finalize body writes to. */
  mappingWrites: string[];
  /** True when the body reads a mapping (get/get.or_use/contains). */
  readsMappings: boolean;
}

export interface Finding {
  severity: "info" | "note" | "warn";
  fn: string;
  message: string;
}

export interface Analysis {
  imports: string[];
  records: string[];
  mappings: string[];
  structs: string[];
  functions: FunctionInfo[];
  findings: Finding[];
  totals: {
    privateInputs: number;
    publicInputs: number;
    recordInputs: number;
    recordOutputs: number;
    mappingWrites: number;
  };
}

/**
 * A block header: `function foo:`, `record token:`, `finalize bar:`.
 *
 * `transition` appears in older source, `closure` in helpers, and `finalize`
 * as a separate top-level block in pre-async programs.
 */
const BLOCK_RE =
  /^\s*(function|transition|closure|record|mapping|struct|finalize|interface)\s+([A-Za-z0-9_]+)\s*:/;

const PARAM_RE = /^\s*(input|output)\s+(r\d+|[A-Za-z0-9_.]+)\s+as\s+(.+?)\s*;\s*$/;
const IMPORT_RE = /^\s*import\s+([A-Za-z0-9_]+\.aleo)\s*;/;

/** `set r0 into account[r1]` - the write that makes state public. */
const SET_RE = /^\s*set\s+\S+\s+into\s+([A-Za-z0-9_]+)\s*\[/;
const REMOVE_RE = /^\s*remove\s+([A-Za-z0-9_]+)\s*\[/;
const READ_RE = /^\s*(get|get\.or_use|contains)\s+([A-Za-z0-9_]+)\s*\[/;

/**
 * Read the visibility mode off a type annotation.
 *
 * The mode is the LAST dot-segment, not the second: a future type is written
 * `credits.aleo/transfer_public.future`, so splitting on the first dot would
 * report the mode as "aleo/transfer_public". Types with no mode at all
 * (`u64`, or a struct name) are reported as unspecified rather than guessed -
 * saying "public" there would be an assertion the source does not make.
 */
export function modeOf(type: string): Mode {
  const last = type.trim().split(".").pop()?.toLowerCase() ?? "";
  switch (last) {
    case "private":
    case "public":
    case "record":
    case "constant":
    case "future":
      return last;
    default:
      return "unspecified";
  }
}

/** Parse deployed Aleo instruction source into a privacy report. */
export function analyzeProgram(source: string): Analysis {
  const lines = source.split(/\r?\n/);

  const imports: string[] = [];
  const records: string[] = [];
  const mappings: string[] = [];
  const structs: string[] = [];
  const functions: FunctionInfo[] = [];

  // Finalize blocks are separate top-level blocks in older programs, so their
  // mapping writes have to be attributed back to the function of the same name
  // after the whole file is read.
  const finalizeWrites = new Map<string, string[]>();
  const finalizeReads = new Set<string>();

  let current: FunctionInfo | null = null;
  let finalizeName: string | null = null;

  for (const line of lines) {
    const imp = line.match(IMPORT_RE);
    if (imp?.[1]) {
      imports.push(imp[1]);
      continue;
    }

    const block = line.match(BLOCK_RE);
    if (block) {
      const kind = block[1];
      const name = block[2] ?? "";
      current = null;
      finalizeName = null;

      if (kind === "record") records.push(name);
      else if (kind === "mapping") mappings.push(name);
      else if (kind === "struct" || kind === "interface") structs.push(name);
      else if (kind === "finalize") {
        finalizeName = name;
        if (!finalizeWrites.has(name)) finalizeWrites.set(name, []);
      } else {
        current = {
          name,
          kind: kind === "closure" ? "closure" : kind === "transition" ? "transition" : "function",
          inputs: [],
          outputs: [],
          mappingWrites: [],
          readsMappings: false,
        };
        functions.push(current);
      }
      continue;
    }

    const set = line.match(SET_RE) ?? line.match(REMOVE_RE);
    if (set?.[1]) {
      if (finalizeName) finalizeWrites.get(finalizeName)?.push(set[1]);
      else if (current) current.mappingWrites.push(set[1]);
      continue;
    }

    if (READ_RE.test(line)) {
      if (finalizeName) finalizeReads.add(finalizeName);
      else if (current) current.readsMappings = true;
      continue;
    }

    // Params only mean something inside a function; a record's field lines use
    // `owner as address.private;` without the input/output keyword, so they do
    // not match PARAM_RE and are skipped here by design.
    if (!current) continue;
    const param = line.match(PARAM_RE);
    if (param) {
      const type = (param[3] ?? "").trim();
      const entry: Param = {
        register: param[2] ?? "",
        type,
        mode: modeOf(type),
      };
      if (param[1] === "input") current.inputs.push(entry);
      else current.outputs.push(entry);
    }
  }

  // Fold separate finalize blocks into their functions.
  for (const fn of functions) {
    const writes = finalizeWrites.get(fn.name);
    if (writes?.length) fn.mappingWrites.push(...writes);
    if (finalizeReads.has(fn.name)) fn.readsMappings = true;
  }

  return {
    imports,
    records,
    mappings,
    structs,
    functions,
    findings: buildFindings(functions),
    totals: tally(functions),
  };
}

function tally(functions: FunctionInfo[]): Analysis["totals"] {
  const totals = {
    privateInputs: 0,
    publicInputs: 0,
    recordInputs: 0,
    recordOutputs: 0,
    mappingWrites: 0,
  };
  for (const fn of functions) {
    for (const i of fn.inputs) {
      if (i.mode === "private") totals.privateInputs++;
      else if (i.mode === "public") totals.publicInputs++;
      else if (i.mode === "record") totals.recordInputs++;
    }
    for (const o of fn.outputs) if (o.mode === "record") totals.recordOutputs++;
    totals.mappingWrites += fn.mappingWrites.length;
  }
  return totals;
}

/**
 * Turn the parsed shape into statements a developer can act on.
 *
 * Ordered warn-first, because the interesting case is a function that looks
 * private at the signature but writes a mapping - the amount is then on-chain
 * in the clear regardless of how the input was passed.
 */
function buildFindings(functions: FunctionInfo[]): Finding[] {
  const findings: Finding[] = [];

  for (const fn of functions) {
    if (fn.kind === "closure") continue;

    const priv = fn.inputs.filter((i) => i.mode === "private" || i.mode === "record");
    const pub = fn.inputs.filter((i) => i.mode === "public");

    if (fn.mappingWrites.length && priv.length) {
      const names = [...new Set(fn.mappingWrites)].map((m) => `\`${m}\``).join(", ");
      findings.push({
        severity: "warn",
        fn: fn.name,
        message:
          `takes ${priv.length} private input(s) but writes to ${names}. ` +
          "Mapping state is public, so any value that reaches it is visible on-chain " +
          "even though it arrived privately.",
      });
    } else if (fn.mappingWrites.length) {
      const names = [...new Set(fn.mappingWrites)].map((m) => `\`${m}\``).join(", ");
      findings.push({
        severity: "note",
        fn: fn.name,
        message: `writes public mapping state (${names}).`,
      });
    }

    if (fn.inputs.length && !priv.length) {
      findings.push({
        severity: "note",
        fn: fn.name,
        message: `all ${fn.inputs.length} input(s) are public - this call hides nothing.`,
      });
    }

    if (priv.length && !fn.mappingWrites.length && !pub.length) {
      findings.push({
        severity: "info",
        fn: fn.name,
        message: `fully private inputs (${priv.length}) with no public state writes.`,
      });
    }

    const unspecified = fn.inputs.filter((i) => i.mode === "unspecified");
    if (unspecified.length) {
      findings.push({
        severity: "info",
        fn: fn.name,
        message:
          `${unspecified.length} input(s) carry no visibility mode ` +
          `(${unspecified.map((u) => `\`${u.type}\``).join(", ")}).`,
      });
    }
  }

  const rank = { warn: 0, note: 1, info: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
