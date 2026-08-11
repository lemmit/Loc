// ---------------------------------------------------------------------------
// M-T9.29 — the pairwise-combination corpus: the HARNESS.
//
// One function runs the full compiler pipeline over one composed crossing and
// classifies the outcome into exactly one of three buckets.  The classification
// IS the gate: two of the three buckets are legitimate, and conflating them is
// how a matrix like this turns into noise nobody reads.
//
//   ok        — parsed, validated, generated.  Feeds the compile / schema-load
//               oracles downstream.
//   rejected  — a `loom.*` validator said no.  This is a LEGITIMATE outcome:
//               "a pair that can't combine must be rejected by a validator, not
//               crash codegen" is the contract, and a named diagnostic IS the
//               rejection.  Recorded (with its code) so the register can show
//               which impossible pairs are honestly refused; never a failure.
//   crashed   — the pipeline threw, or emitted a diagnostic with no `loom.*`
//               code at all.  This is the FINDING: valid-looking source that
//               takes the compiler down instead of getting an answer.  #2492
//               (`policy { deny }` × dapper) is exactly this shape.
// ---------------------------------------------------------------------------

import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/parse.js";
import type { PairwiseCase } from "./axes.js";
import { composeSourceFor } from "./compose.js";

export type Verdict = "ok" | "rejected" | "crashed";

export interface PipelineOutcome {
  readonly verdict: Verdict;
  /** `loom.*` codes carried by the rejecting diagnostics, deduped + sorted. */
  readonly codes: readonly string[];
  /** First diagnostic message / thrown error text, for the findings register. */
  readonly detail: string;
  /** Emitted file map — only on `ok`. */
  readonly files?: Map<string, string>;
}

/** The `loom.*` codes carried by the ERROR diagnostics, deduped + sorted.
 *
 *  Read off `Diagnostic.code`, NOT off the formatted `line:col message` text:
 *  the code is a sibling FIELD of the message, so scanning the prose would
 *  find a code only when a message happens to quote one.  Getting this wrong
 *  is not a cosmetic bug — it flips every honest validator rejection into a
 *  fake "crash", which is precisely the vacuous classification this corpus
 *  exists to avoid. */
function loomCodes(diagnostics: readonly { severity?: number; code?: unknown }[]): string[] {
  const found = new Set<string>();
  for (const d of diagnostics) {
    if (d.severity !== 1) continue;
    const code = typeof d.code === "string" ? d.code : undefined;
    if (code?.startsWith("loom.")) found.add(code);
  }
  return [...found].sort();
}

/** Run parse → validate → generate for one crossing on one backend. */
export async function runPipeline(c: PairwiseCase, platform: string): Promise<PipelineOutcome> {
  const source = composeSourceFor(c, platform);
  let parsed: Awaited<ReturnType<typeof parseString>>;
  try {
    parsed = await parseString(source);
  } catch (e) {
    return { verdict: "crashed", codes: [], detail: `parse threw: ${describe(e)}` };
  }
  const { errors, diagnostics, model } = parsed;

  if (errors.length > 0) {
    const codes = loomCodes(diagnostics);
    // A diagnostic with NO `loom.*` code is a raw parser/linker error, which
    // for a composed system means the composer emitted something ungrammatical
    // — a harness bug, not a language finding.  It is surfaced as `crashed`
    // rather than swallowed: an unreadable fixture that silently counts as a
    // legitimate rejection is exactly the vacuous-gate failure mode this whole
    // corpus exists to avoid.
    return {
      verdict: codes.length > 0 ? "rejected" : "crashed",
      codes,
      detail: errors[0] ?? "",
    };
  }

  try {
    const files = generateSystems(model).files;
    return { verdict: "ok", codes: [], detail: "", files };
  } catch (e) {
    return { verdict: "crashed", codes: [], detail: `codegen threw: ${describe(e)}` };
  }
}

function describe(e: unknown): string {
  if (e instanceof Error)
    return `${e.message}\n${(e.stack ?? "").split("\n").slice(1, 6).join("\n")}`;
  return String(e);
}
