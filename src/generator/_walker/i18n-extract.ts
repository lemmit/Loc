// ---------------------------------------------------------------------------
// i18n message extraction — the user-visible-string catalog pass (M-T1.11,
// docs/old/proposals/i18n.md Phase 1).
//
// Walks a `UiIR`'s pages/components/menu and collects every user-visible
// string literal into `<key, message>` catalog entries.  A downstream renderer
// (`src/system/i18n-catalog.ts`) serialises them into `.loom/messages.en.json`,
// the diffable source-language catalog every locale is merged against.
//
// SCOPE — plain string literals AND interpolated backtick templates.  A
// template (`` `Order {order.id}` ``) lowers to a `binary "+"` chain (no ICU
// node in the IR — a template is indistinguishable from hand concat post-lower);
// `icuFromConcat` re-detects that chain into an ICU message (`"Order {id}"`) so
// it too becomes a translatable catalog entry.  A dynamic slot with no literal
// text (a bare `ref`, `{count}` alone) has nothing to translate and is skipped.
//
// KEYS — D-I18N-KEY (PINNED).  Inline literals are content-hashed:
// `page.<Page>.<role>.<hash>` / `component.<Comp>.<role>.<hash>` /
// `menu.<role>.<hash>`.  `role` (the slot the text sits in) is part of the key
// so two different-role occurrences of the same string in one page don't
// collide; the content hash makes the key reorder-invariant and re-key on a
// rephrase.  Named `text { }` entries (stable keys) are a later slice.
//
// This module lives at the generator layer so both the catalog renderer
// (`src/system/`, downstream) and the future React translation runtime
// (`src/generator/react/`, sibling) share ONE slot table + key derivation —
// the emitted `<FormattedMessage id>` must line up with the catalog key.
// ---------------------------------------------------------------------------

import type { ExprIR, UiIR } from "../../ir/types/loom-ir.js";
import { walkExprDeep } from "../../ir/util/walk.js";
import { contentHash } from "../../util/content-hash.js";
import { USER_VISIBLE_SLOTS } from "../../util/user-visible-slots.js";
import { chromeEntriesFor } from "./i18n-chrome.js";
import { namedArgValue, positionalArgs } from "./shared/args.js";

/** One source-language catalog entry: a stable key and its English text. */
export interface MessageEntry {
  key: string;
  message: string;
}

/** The plain-string value of an expression, or undefined when it is not a
 *  bare string literal (a dynamic ref/expr, or an interpolated `+` chain). */
export function literalString(e: ExprIR | undefined): string | undefined {
  if (e && e.kind === "literal" && e.lit === "string") return e.value;
  return undefined;
}

/** The catalog key for an inline literal: `<prefix>.<role>.<hash>`.
 *  Exported so the React translation runtime (`i18n-emit.ts`) emits a
 *  `<FormattedMessage id>` / `t(key)` whose key is IDENTICAL to the one the
 *  extraction pass writes into `.loom/messages.en.json` — the two MUST agree,
 *  so both call this one function rather than each re-deriving the shape.
 *
 *  For an ICU message the hash input is the POSITIONAL-normalized form
 *  (`"Order {0}"`, {@link IcuMessage.positional}), not the named display form —
 *  so renaming a field (`{id}` → `{number}`) keeps the same key and preserves
 *  the translation (i18n-strings.md Option B). */
export function messageKey(prefix: string, role: string, message: string): string {
  return `${prefix}.${role}.${contentHash(message)}`;
}

/** An interpolated user-visible string, re-derived from its lowered `+`-chain.
 *  The two placeholder spaces are deliberate (i18n-strings.md Option B):
 *  `display` is what translators read + what the app emits as the default;
 *  `positional` is the rename-stable hash input. */
export interface IcuMessage {
  /** Named-placeholder ICU for the catalog + emitted default: `"Order {id}"`. */
  display: string;
  /** Positional-normalized form the key is hashed over: `"Order {0}"`. */
  positional: string;
  /** Interpolation holes in source order — the derived placeholder name and the
   *  (string-wrapped) hole expression the React emitter renders into the values
   *  object.  The catalog builder ignores `expr`. */
  holes: { name: string; expr: ExprIR }[];
}

/** Flatten a left-associative string `+`-chain — the exact shape
 *  `lowerTemplateString` folds a template into — back into its ordered operand
 *  pieces (literal segments interleaved with holes). */
function flattenConcatChain(e: ExprIR): ExprIR[] {
  const out: ExprIR[] = [];
  let cur: ExprIR = e;
  while (cur.kind === "binary" && cur.op === "+") {
    out.unshift(cur.right);
    cur = cur.left;
  }
  out.unshift(cur);
  return out;
}

/** Derive a translator-friendly placeholder name for an interpolation hole:
 *  peel the string-coercion wraps lowering injects (`convert` / `.display`) and
 *  a dotted path to its last segment (`order.id` → `id`).  Bare refs use their
 *  name; anything else (a call, arithmetic) has no natural name → undefined, and
 *  the caller falls back to a positional `argN`. */
/** Peel a hole's wrapping layers down to the raw value expression, returning
 *  both that expression and a translator-friendly placeholder name.  Layers:
 *  the transparent `i18nFormat` i18n wrapper (M-T1.11), the `convert` /
 *  `.display` string-coercion lowering injects for a `string + X` concat, and
 *  `paren`.  The RAW `value` is what the runtime `values` object must carry for
 *  a formatted hole (a number for `, number`, a Date for `, date` — not its
 *  stringified form); `name` is the last path segment (`order.id` → `id`), or
 *  undefined for an unnameable expression (a call / arithmetic). */
function peelHole(expr: ExprIR): { value: ExprIR; name: string | undefined } {
  let e = expr;
  for (;;) {
    if (e.kind === "i18nFormat") e = e.inner;
    else if (e.kind === "convert" && e.target === "string") e = e.value;
    else if (e.kind === "member" && e.member === "display") e = e.receiver;
    else if (e.kind === "paren") e = e.inner;
    else break;
  }
  let name: string | undefined;
  if (e.kind === "member") name = e.member;
  else if (e.kind === "ref") name = e.name;
  else if (e.kind === "method-call") name = e.member;
  return { value: e, name };
}

/** Re-detect an interpolated user-visible string from its lowered `+`-chain.
 *  Returns undefined for anything that isn't `literal-text + hole` interpolation
 *  — a purely numeric `count + 1` (no string segment), a bare `{x}` (no chain),
 *  or a plain literal — so those keep their existing (raw / plain-literal) path.
 *  Shared by the catalog builder and the React runtime so the emitted key +
 *  default line up with the catalog entry. */
export function icuFromConcat(expr: ExprIR | undefined): IcuMessage | undefined {
  if (expr?.kind !== "binary" || expr.op !== "+") return undefined;
  const pieces = flattenConcatChain(expr);
  let display = "";
  let positional = "";
  let hasLiteral = false;
  const holes: { name: string; expr: ExprIR }[] = [];
  const used = new Map<string, number>();
  for (const piece of pieces) {
    const lit = literalString(piece);
    if (lit !== undefined) {
      hasLiteral = true;
      display += lit;
      positional += lit;
      continue;
    }
    const index = holes.length;
    // A `, format` suffix (i18n, M-T1.11) rides the transparent `i18nFormat`
    // wrapper.  Splice its RAW ICU text into BOTH placeholders — the positional
    // form is the rename-stable hash input, so a FORMAT change re-keys (a
    // different rendering IS a different message) while a field rename (name →
    // `{0}`) still does not.  The stored `expr` is the PEELED raw value (a
    // number/Date), so the runtime `values` object hands the locale formatter
    // the real value rather than its stringified form.
    const peeled = peelHole(piece);
    const format = piece.kind === "i18nFormat" ? piece.format : "";
    // A format-less hole keeps its stringified concat operand verbatim (slice-8
    // behaviour); a formatted hole carries the peeled raw value.
    const holeExpr = piece.kind === "i18nFormat" ? peeled.value : piece;
    let name = peeled.name ?? `arg${index}`;
    const seen = used.get(name);
    if (seen === undefined) used.set(name, 1);
    else {
      const n = seen + 1;
      used.set(name, n);
      name = `${name}_${n}`;
    }
    holes.push({ name, expr: holeExpr });
    display += `{${name}${format}}`;
    positional += `{${index}${format}}`;
  }
  // Needs both translatable text and at least one hole to be a message.
  if (!hasLiteral || holes.length === 0) return undefined;
  return { display, positional, holes };
}

/** Collect the user-visible strings from one render-body expression tree,
 *  keyed under `<prefix>` (e.g. `page.OrderList` / `component.OrderCard`). */
function collectBody(body: ExprIR | undefined, prefix: string, out: MessageEntry[]): void {
  walkExprDeep(body, (e) => {
    if (e.kind !== "call") return;
    // Pack-chrome: a primitive that renders design-pack-baked user-visible text
    // (a `Loader()`'s `aria-label="Loading"`, a `DataGrid()`'s pager) contributes
    // its stable `chrome.<name>` catalog entries wherever it appears —
    // used-only, keyed IDENTICALLY to what the `localizedChrome*` helpers emit
    // (M-T1.11).  Resolved against the CALL NODE, because a grid's per-column
    // "Filter" placeholder depends on whether a column is filterable.
    out.push(...chromeEntriesFor(e));
    const slots = USER_VISIBLE_SLOTS[e.name];
    if (!slots) return;
    const positionals = positionalArgs(e);
    for (const slot of slots) {
      const arg =
        slot.kind === "positional" ? positionals[slot.index] : namedArgValue(e, slot.name);
      const message = literalString(arg);
      if (message !== undefined) {
        out.push({ key: messageKey(prefix, slot.role, message), message });
        continue;
      }
      // Interpolated slot → an ICU entry keyed by its positional form, stored as
      // the named display form (the React emitter derives the identical key).
      const icu = icuFromConcat(arg);
      if (icu) {
        out.push({ key: messageKey(prefix, slot.role, icu.positional), message: icu.display });
      }
    }
  });
}

/** Extract every user-visible source-language string from a UI declaration.
 *  Pure and order-deterministic (walks pages, then components, then menu, in
 *  declaration order); the renderer dedupes + sorts. */
export function collectUiMessages(ui: UiIR): MessageEntry[] {
  const out: MessageEntry[] = [];

  for (const page of ui.pages) {
    const prefix = `page.${page.name}`;
    // Page title (`page X { title: "…" }`) — only when it is a plain literal
    // (a title that interpolates state/params is dynamic, not extractable).
    const title = literalString(page.title);
    if (title !== undefined) out.push({ key: messageKey(prefix, "title", title), message: title });
    collectBody(page.body, prefix, out);

    // Per-page sidebar chrome — `menu { section: "…", label: "…" }` metadata.
    for (const entry of page.menuMeta?.entries ?? []) {
      if (entry.name !== "section" && entry.name !== "label") continue;
      const message = literalString(entry.value);
      if (message === undefined) continue;
      out.push({ key: messageKey(prefix, `menu.${entry.name}`, message), message });
    }
  }

  for (const component of ui.components) {
    collectBody(component.body, `component.${component.name}`, out);
  }

  // UI-level `menu { section "…" { link "L" -> "url" } }` chrome.
  for (const section of ui.menu?.sections ?? []) {
    if (section.label) {
      out.push({ key: messageKey("menu", "section", section.label), message: section.label });
    }
    for (const link of section.links) {
      if (link.kind === "external" && link.label) {
        out.push({ key: messageKey("menu", "link", link.label), message: link.label });
      } else if (link.kind === "page") {
        const label = link.props.find((p) => p.name === "label");
        const message = literalString(label?.value);
        if (message !== undefined) {
          out.push({ key: messageKey("menu", "link", message), message });
        }
      }
    }
  }

  return out;
}
