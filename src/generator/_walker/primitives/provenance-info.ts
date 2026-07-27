// ProvenanceInfo(of: <record>, field: "<name>") — a "?" disclosure that
// reveals where a `provenanced` field's value came from.
//
// A provenanced field carries a co-located lineage sibling on the wire
// (`<field>_provenance` — see docs/provenance.md and repository-wire-builder.ts),
// surfaced to the frontend as the nullable `provLineageSchema` shape.  This
// primitive renders a native `<details>`/`<summary>` disclosure (no design-pack
// component, no client state — accessible by default) next to the value: the
// "?" summary expands to the rule id, the computed value, and the input list
// (path = value) that produced it.
//
// React-first (the user-chosen scope): the TSX render is emitted only for the
// react target; the other JSX frontends and the HEEx/Feliz walkers fall through
// to a visible comment (honest degradation — the value still renders, the
// disclosure just isn't wired yet).  A future port implements the
// `renderProvenanceInfo` WalkerTarget seam (mirrors `renderFileLink`).

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { namedArgValue, positionalArgs, stringNamed } from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import { emitExpr, testidAttr } from "../walker-core.js";

export function emitProvenanceInfo(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Whole-primitive fork hook (Feliz/others), matching `renderFileLink`.
  const override = ctx.target.renderProvenanceInfo?.(call, ctx, depth);
  if (override != null) return override;

  // React-only for now: the disclosure body maps over `lineage.inputs`, which
  // is JS-flavoured JSX the strict-template frameworks (Vue/Svelte/Angular)
  // can't consume verbatim.  Fall through to a visible comment there so a
  // scaffolded provenanced field still compiles (the value renders above; only
  // the "?" is absent).
  if (ctx.target.framework !== "react") {
    return ctx.target.renderComment(
      `ProvenanceInfo: provenance disclosure is React-only for now (value renders without the "?")`,
    );
  }

  const recordArg = namedArgValue(call, "of") ?? positionalArgs(call)[0];
  const field = stringNamed(call, "field");
  if (!recordArg || !field) {
    return ctx.target.renderComment("ProvenanceInfo: missing record or field");
  }
  // `<record>.<field>_provenance` — the co-located lineage sibling the frontend
  // response schema carries as `provLineageSchema.nullish()`.
  const lineage = `${emitExpr(recordArg, ctx)}.${field}_provenance`;
  const testid = testidAttr(call, ctx);
  // A JSX-child expression (`{cond ? (…) : null}`) — always nested inside the
  // value cell, so it never needs the depth-0 brace wrap.  Guarded on a null
  // lineage (the field is nullish on the wire — absent on non-capturing
  // backends), so it renders nothing rather than crashing on `.snapshotId`.
  return [
    `{${lineage} != null ? (`,
    `  <details className="loom-provenance"${testid}>`,
    `    <summary aria-label="How this value was computed">?</summary>`,
    `    <dl className="loom-provenance-tree">`,
    `      <div><dt>Rule</dt><dd><code>{${lineage}.snapshotId}</code></dd></div>`,
    `      <div><dt>Value</dt><dd>{String(${lineage}.computedValue)}</dd></div>`,
    `      {${lineage}.inputs.map((inp) => (`,
    `        <div key={inp.path}><dt>{inp.path}</dt><dd>{String(inp.value)}</dd></div>`,
    `      ))}`,
    `    </dl>`,
    `  </details>`,
    `) : null}`,
  ].join("\n");
}
