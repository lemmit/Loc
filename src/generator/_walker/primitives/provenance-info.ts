// ProvenanceInfo(of: <record>, field: "<name>") — a "?" disclosure that
// reveals where a `provenanced` field's value came from.
//
// A provenanced field ships its value and its lineage as ONE wire carrier
// (`{ value, lineage }` — see docs/provenance.md and the shared shape in
// `_payload/provenanced-wire.ts`), the lineage half surfaced to the frontend as
// the nullable `provLineageSchema`.  This
// primitive renders a native `<details>`/`<summary>` disclosure (no design-pack
// component, no client state — accessible by default) next to the value: the
// "?" summary expands to the rule id, the computed value, and the input list
// (path = value) that produced it.
//
// The disclosure markup diverges enough per framework (JSX `{cond ? … : null}`
// + `.map` vs Vue `v-if`/`v-for` vs Svelte `{#if}`/`{#each}` vs Angular
// `@if`/`@for` + signal access) that each target renders its own branch —
// rather than one fragile seam-based build.  A frontend whose response schema
// doesn't carry the lineage yet falls through to a visible comment (the value
// still renders, only the "?" is absent).  A future Feliz/HEEx port implements
// the `renderProvenanceInfo` WalkerTarget seam / the parallel HEEx walker.

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { PROVENANCE_LINEAGE_FIELD } from "../../_payload/provenanced-wire.js";
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

  const recordArg = namedArgValue(call, "of") ?? positionalArgs(call)[0];
  const field = stringNamed(call, "field");
  if (!recordArg || !field) {
    return ctx.target.renderComment("ProvenanceInfo: missing record or field");
  }
  // `<record>.<field>.lineage` — the lineage half of the `Provenanced<T>` wire
  // carrier the response schema now carries (M-T6.12); the value half is
  // `<record>.<field>.value`, which the scaffold renders in the cell beside
  // this disclosure.  `emitExpr` resolves the record receiver per target (React
  // `orderById.data`, Vue's query-data access), so the two stay symmetric.
  const lineage = `${emitExpr(recordArg, ctx)}.${field}.${PROVENANCE_LINEAGE_FIELD}`;
  const testid = testidAttr(call, ctx);

  switch (ctx.target.framework) {
    case "react":
      return reactDisclosure(lineage, testid);
    case "vue":
      return vueDisclosure(lineage, testid);
    case "svelte":
      return svelteDisclosure(lineage, testid);
    case "angular":
      return angularDisclosure(lineage, testid);
    default:
      // Schema not wired on this frontend yet — comment out so the scaffolded
      // provenanced field still compiles (the value renders without the "?").
      return ctx.target.renderComment(
        `ProvenanceInfo: provenance disclosure not yet supported on ${ctx.target.framework} (value renders without the "?")`,
      );
  }
}

/** React: a JSX-child `{cond ? (<details>…) : null}` — always nested inside the
 *  value cell, so it never needs the depth-0 brace wrap.  Null-guarded on the
 *  nullish wire field, then rule id + computed value + input list. */
function reactDisclosure(lineage: string, testid: string): string {
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

/** Vue: a `<details v-if>` guarded on the nullish wire field, `{{ }}`
 *  interpolation, and a `v-for` over the input list keyed by `inp.path`. */
function vueDisclosure(lineage: string, testid: string): string {
  return [
    `<details v-if="${lineage} != null" class="loom-provenance"${testid}>`,
    `  <summary aria-label="How this value was computed">?</summary>`,
    `  <dl class="loom-provenance-tree">`,
    `    <div><dt>Rule</dt><dd><code>{{ ${lineage}.snapshotId }}</code></dd></div>`,
    `    <div><dt>Value</dt><dd>{{ String(${lineage}.computedValue) }}</dd></div>`,
    `    <div v-for="inp in ${lineage}.inputs" :key="inp.path"><dt>{{ inp.path }}</dt><dd>{{ String(inp.value) }}</dd></div>`,
    `  </dl>`,
    `</details>`,
  ].join("\n");
}

/** Svelte: an `{#if}` guard on the nullish wire field, `{expr}` interpolation,
 *  and a keyed `{#each … (inp.path)}` over the input list. */
function svelteDisclosure(lineage: string, testid: string): string {
  return [
    `{#if ${lineage} != null}`,
    `  <details class="loom-provenance"${testid}>`,
    `    <summary aria-label="How this value was computed">?</summary>`,
    `    <dl class="loom-provenance-tree">`,
    `      <div><dt>Rule</dt><dd><code>{${lineage}.snapshotId}</code></dd></div>`,
    `      <div><dt>Value</dt><dd>{String(${lineage}.computedValue)}</dd></div>`,
    `      {#each ${lineage}.inputs as inp (inp.path)}`,
    `        <div><dt>{inp.path}</dt><dd>{String(inp.value)}</dd></div>`,
    `      {/each}`,
    `    </dl>`,
    `  </details>`,
    `{/if}`,
  ].join("\n");
}

/** Angular: an `@if (…; as prov)` alias (a signal-call result like
 *  `data()!.<field>_provenance` can't be narrowed in place — the `as` binds the
 *  truthy value), `{{ }}` interpolation, and a tracked `@for`.  `computedValue`
 *  and `inp.value` are `unknown`; Angular templates can't call `String(...)`, so
 *  they ride `$any(...)` (the interpolation stringifies). */
function angularDisclosure(lineage: string, testid: string): string {
  return [
    `@if (${lineage}; as prov) {`,
    `  <details class="loom-provenance"${testid}>`,
    `    <summary aria-label="How this value was computed">?</summary>`,
    `    <dl class="loom-provenance-tree">`,
    `      <div><dt>Rule</dt><dd><code>{{ prov.snapshotId }}</code></dd></div>`,
    `      <div><dt>Value</dt><dd>{{ $any(prov.computedValue) }}</dd></div>`,
    `      @for (inp of prov.inputs; track inp.path) {`,
    `        <div><dt>{{ inp.path }}</dt><dd>{{ $any(inp.value) }}</dd></div>`,
    `      }`,
    `    </dl>`,
    `  </details>`,
    `}`,
  ].join("\n");
}
