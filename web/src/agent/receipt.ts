// ---------------------------------------------------------------------------
// The per-turn RECEIPT (M-T8.19 slice 3; research §4 #4, #12).
//
// NN/g's sycophancy finding is the whole reason this exists: "it's fixed" must
// be VERIFIED, not asserted.  So a turn does not end with the model's summary
// — it ends with four facts the playground computed itself:
//
//   • the unified `.ddd` diff (the real change, ten lines, not fifteen files);
//   • the validator delta ("2 errors → 0") — the compiler's verdict, not the
//     model's;
//   • the generated-file delta (`+3 −0 ~7`), expandable to paths;
//   • the tokens the provider reported, when it reported any.
//
// Everything here is PURE — two source strings, two file lists, a transcript
// and a pair of error counts in; a `TurnReceipt` out.  `test/playground/
// agent-receipt.test.ts` drives it with no React and no model.
// ---------------------------------------------------------------------------

import type { TokenUsage } from "../../../src/tools/index.js";
import type { AgentToolCall } from "./demo.js";

/** A file as the generate step produces it — only the two fields the delta
 *  needs, so the receipt does not depend on the build protocol's shape. */
export interface ReceiptFile {
  path: string;
  content: string;
}

/** What happened to the generated tree across the turn. */
export interface FileDelta {
  added: string[];
  removed: string[];
  changed: string[];
}

/** The validator's verdict on both sides of the write.  `after === before`
 *  when nothing was written — which is itself worth showing. */
export interface ValidatorDelta {
  before: number;
  after: number;
}

export interface TurnReceipt {
  /** Unified diff of the `.ddd`, or "" when the turn wrote nothing. */
  diff: string;
  /** Line counts of that diff. */
  added: number;
  removed: number;
  /** True when the turn actually wrote source. */
  wrote: boolean;
  validator: ValidatorDelta;
  files: FileDelta;
  /** Every tool the turn ran, folded out of the per-message cards so the
   *  receipt can carry them collapsed underneath itself. */
  toolCalls: AgentToolCall[];
  usage?: TokenUsage;
}

// --- unified diff ----------------------------------------------------------

/** Longest-common-subsequence table over two line arrays.  The `.ddd` files a
 *  turn edits are tens to a few hundred lines, so the quadratic table is far
 *  cheaper than pulling a diff library into the entry chunk. */
function lcsLengths(a: readonly string[], b: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

type Op = { kind: " " | "-" | "+"; line: string };

/** The edit script between two line arrays, as ` `/`-`/`+` ops in order. */
export function diffLines(before: readonly string[], after: readonly string[]): Op[] {
  const table = lcsLengths(before, after);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: " ", line: before[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: "-", line: before[i]! });
      i++;
    } else {
      ops.push({ kind: "+", line: after[j]! });
      j++;
    }
  }
  while (i < before.length) ops.push({ kind: "-", line: before[i++]! });
  while (j < after.length) ops.push({ kind: "+", line: after[j++]! });
  return ops;
}

/** A unified diff with `context` unchanged lines around each hunk.  Hunk
 *  headers are the conventional `@@ -a,b +c,d @@` so the text is readable in a
 *  screen reader and pasteable into `git apply` territory. */
export function unifiedDiff(before: string, after: string, context = 3): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = diffLines(a, b);

  // Which ops belong to a hunk: every change, plus `context` lines either side.
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, k) => {
    if (op.kind === " ") return;
    for (let n = Math.max(0, k - context); n <= Math.min(ops.length - 1, k + context); n++) {
      keep[n] = true;
    }
  });

  const out: string[] = [];
  let aLine = 1;
  let bLine = 1;
  let k = 0;
  while (k < ops.length) {
    if (!keep[k]) {
      if (ops[k]!.kind !== "+") aLine++;
      if (ops[k]!.kind !== "-") bLine++;
      k++;
      continue;
    }
    const aStart = aLine;
    const bStart = bLine;
    const body: string[] = [];
    let aCount = 0;
    let bCount = 0;
    while (k < ops.length && keep[k]) {
      const op = ops[k]!;
      body.push(`${op.kind}${op.line}`);
      if (op.kind !== "+") {
        aLine++;
        aCount++;
      }
      if (op.kind !== "-") {
        bLine++;
        bCount++;
      }
      k++;
    }
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`, ...body);
  }
  return out.join("\n");
}

/** `+n −m` line counts of a unified diff (hunk headers excluded). */
export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@") || line === "") continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

// --- generated-file delta --------------------------------------------------

/** Which generated files appeared, vanished, or changed content.  Paths are
 *  sorted so two runs over the same delta read identically. */
export function fileDelta(
  before: readonly ReceiptFile[],
  after: readonly ReceiptFile[],
): FileDelta {
  const a = new Map(before.map((f) => [f.path, f.content]));
  const b = new Map(after.map((f) => [f.path, f.content]));
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [path, content] of b) {
    const prior = a.get(path);
    if (prior === undefined) added.push(path);
    else if (prior !== content) changed.push(path);
  }
  for (const path of a.keys()) if (!b.has(path)) removed.push(path);
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

/** True when nothing in the generated tree moved. */
export function fileDeltaIsEmpty(d: FileDelta): boolean {
  return d.added.length + d.removed.length + d.changed.length === 0;
}

// --- folding ---------------------------------------------------------------

/** Every tool call the turn's bubbles carry, in order — the cards fold under
 *  the receipt rather than sprawling up the transcript. */
export function collectToolCalls(
  bubbles: readonly { toolCalls?: AgentToolCall[] }[],
): AgentToolCall[] {
  return bubbles.flatMap((b) => b.toolCalls ?? []);
}

export interface FoldReceiptArgs {
  /** The turn's display bubbles (for the tool-call roll-up). */
  bubbles: readonly { toolCalls?: AgentToolCall[] }[];
  /** The `.ddd` before the turn wrote, and after. */
  before: string;
  after: string;
  filesBefore: readonly ReceiptFile[];
  filesAfter: readonly ReceiptFile[];
  validator: ValidatorDelta;
  usage?: TokenUsage;
}

/** Assemble the receipt.  `wrote` is derived, never asserted: a turn "wrote"
 *  exactly when the two source versions differ. */
export function foldReceipt(args: FoldReceiptArgs): TurnReceipt {
  const diff = unifiedDiff(args.before, args.after);
  const { added, removed } = diffStat(diff);
  return {
    diff,
    added,
    removed,
    wrote: args.before !== args.after,
    validator: args.validator,
    files: fileDelta(args.filesBefore, args.filesAfter),
    toolCalls: collectToolCalls(args.bubbles),
    usage: args.usage,
  };
}
