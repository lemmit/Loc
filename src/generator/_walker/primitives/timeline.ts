// Timeline(of: <entries>) — the entity's audit trail, rendered as an ordered
// list of what changed, when, and by whom.
//
// Consumes the `AuditEntry[]` a backend serves at `GET /<agg>/{id}/history`
// (docs/audit.md).  One entry per SUCCESSFUL command, oldest first; each
// carries `action` / `at` / `actor` plus a `changes` list of
// `{field, before, after}` derived at READ time from the row's two snapshots.
//
// Native markup — `<ol>`/`<li>`/`<time>`/`<dl>` — like `ProvenanceInfo`, and for
// the same reasons: no design-pack component to keep in sync across 13 packs,
// no client state, and semantics that carry their own accessibility.  A
// timeline IS an ordered list; saying so in HTML is better than styling a
// `<div>` to look like one.
//
// Two things the renderers deliberately do NOT do:
//
//   - They do not render `changes` as "field: null → value" for a create.  An
//     entry whose `changes` is empty (a command that touched only fields the
//     diff boundary excludes) still renders its header, because "someone ran
//     `recalc` at 14:02" is information even when nothing user-visible moved.
//   - They do not print the masked-field placeholder, because there isn't one:
//     a masked field's change is DROPPED server-side, not redacted, so the
//     client never learns it existed.  Nothing to render, by construction.

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { namedArgValue, positionalArgs } from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import { emitExpr, testidAttr } from "../walker-core.js";

export function emitTimeline(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Whole-primitive fork hook (Feliz/Flutter render their own markup), matching
  // `renderFileLink` / `renderProvenanceInfo`.
  const override = ctx.target.renderTimeline?.(call, ctx, depth);
  if (override != null) return override;

  const entriesArg = namedArgValue(call, "of") ?? positionalArgs(call)[0];
  if (!entriesArg) return ctx.target.renderComment("Timeline: missing entries");
  const entries = guardedList(emitExpr(entriesArg, ctx));
  const testid = testidAttr(call, ctx);

  switch (ctx.target.framework) {
    case "react":
      return reactTimeline(entries, testid);
    case "vue":
      return vueTimeline(entries, testid);
    case "svelte":
      return svelteTimeline(entries, testid);
    case "angular":
      return angularTimeline(entries, testid);
    default:
      return ctx.target.renderComment(`Timeline: not yet supported on ${ctx.target.framework}`);
  }
}

/** `(expr ?? [])` — the in-flight guard.  It matters: the history query has
 *  not resolved on first render, so the binding is undefined before the
 *  response lands and an unguarded iteration would throw.
 *
 *  Applied ONCE.  A `QueryView`'s data-lambda binding arrives ALREADY guarded
 *  on the targets whose read handle is nullable (`(orderHistory.data() ?? [])`
 *  on Angular, `(orderHistory.data ?? [])` on the others), and re-guarding it
 *  is not merely noisy — Angular's template typechecker rejects the second
 *  `??` outright (TS2869, "right operand is unreachable"), so a scaffolded
 *  History section would fail `ng build`. */
function guardedList(entries: string): string {
  const trimmed = entries.trim();
  return /^\(.*\?\?\s*\[\]\)$/.test(trimmed) ? trimmed : `(${entries} ?? [])`;
}

/** React — `{(entries ?? []).map(...)}`. */
function reactTimeline(entries: string, testid: string): string {
  return [
    `<ol className="loom-timeline"${testid}>`,
    `  {${entries}.map((__e) => (`,
    `    <li key={__e.auditId} className="loom-timeline-entry">`,
    `      <span className="loom-timeline-action">{__e.action}</span>`,
    `      <time dateTime={__e.at}>{new Date(__e.at).toLocaleString()}</time>`,
    `      {__e.actor != null ? <span className="loom-timeline-actor">{String(__e.actor)}</span> : null}`,
    `      {__e.changes.length > 0 ? (`,
    `        <dl className="loom-timeline-changes">`,
    `          {__e.changes.map((__c) => (`,
    `            <div key={__c.field}>`,
    `              <dt>{__c.field}</dt>`,
    `              <dd>{String(__c.before ?? "—")} → {String(__c.after ?? "—")}</dd>`,
    `            </div>`,
    `          ))}`,
    `        </dl>`,
    `      ) : null}`,
    `    </li>`,
    `  ))}`,
    `</ol>`,
  ].join("\n");
}

/** Vue — `v-for` over the same guarded list. */
function vueTimeline(entries: string, testid: string): string {
  return [
    `<ol class="loom-timeline"${testid}>`,
    `  <li v-for="__e in ${entries}" :key="__e.auditId" class="loom-timeline-entry">`,
    `    <span class="loom-timeline-action">{{ __e.action }}</span>`,
    `    <time :datetime="__e.at">{{ new Date(__e.at).toLocaleString() }}</time>`,
    `    <span v-if="__e.actor != null" class="loom-timeline-actor">{{ String(__e.actor) }}</span>`,
    `    <dl v-if="__e.changes.length > 0" class="loom-timeline-changes">`,
    `      <div v-for="__c in __e.changes" :key="__c.field">`,
    `        <dt>{{ __c.field }}</dt>`,
    `        <dd>{{ String(__c.before ?? "—") }} → {{ String(__c.after ?? "—") }}</dd>`,
    `      </div>`,
    `    </dl>`,
    `  </li>`,
    `</ol>`,
  ].join("\n");
}

/** Svelte — `{#each}` / `{#if}`. */
function svelteTimeline(entries: string, testid: string): string {
  return [
    `<ol class="loom-timeline"${testid}>`,
    `  {#each ${entries} as __e (__e.auditId)}`,
    `    <li class="loom-timeline-entry">`,
    `      <span class="loom-timeline-action">{__e.action}</span>`,
    `      <time datetime={__e.at}>{new Date(__e.at).toLocaleString()}</time>`,
    `      {#if __e.actor != null}<span class="loom-timeline-actor">{String(__e.actor)}</span>{/if}`,
    `      {#if __e.changes.length > 0}`,
    `        <dl class="loom-timeline-changes">`,
    `          {#each __e.changes as __c (__c.field)}`,
    `            <div><dt>{__c.field}</dt><dd>{String(__c.before ?? "—")} → {String(__c.after ?? "—")}</dd></div>`,
    `          {/each}`,
    `        </dl>`,
    `      {/if}`,
    `    </li>`,
    `  {/each}`,
    `</ol>`,
  ].join("\n");
}

/** Angular — `@for` / `@if` control flow.
 *
 *  `actor` / `before` / `after` are `unknown` on the wire (an entry's snapshot
 *  values are arbitrary JSON), and Angular's template typechecker rejects an
 *  `unknown` in an interpolation — it has no `String(...)` to reach for, the
 *  way the JSX targets do.  `$any(...)` is the template-language escape hatch
 *  for exactly this, and the same one the `ProvenanceInfo` disclosure already
 *  uses for its `computedValue`. */
function angularTimeline(entries: string, testid: string): string {
  return [
    `<ol class="loom-timeline"${testid}>`,
    `  @for (__e of ${entries}; track __e.auditId) {`,
    `    <li class="loom-timeline-entry">`,
    `      <span class="loom-timeline-action">{{ __e.action }}</span>`,
    `      <time [attr.datetime]="__e.at">{{ __e.at }}</time>`,
    `      @if (__e.actor != null) { <span class="loom-timeline-actor">{{ $any(__e.actor) }}</span> }`,
    `      @if (__e.changes.length > 0) {`,
    `        <dl class="loom-timeline-changes">`,
    `          @for (__c of __e.changes; track __c.field) {`,
    `            <div><dt>{{ __c.field }}</dt><dd>{{ $any(__c.before) ?? "—" }} → {{ $any(__c.after) ?? "—" }}</dd></div>`,
    `          }`,
    `        </dl>`,
    `      }`,
    `    </li>`,
    `  }`,
    `</ol>`,
  ].join("\n");
}
