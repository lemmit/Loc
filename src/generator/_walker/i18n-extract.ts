// ---------------------------------------------------------------------------
// i18n message extraction — the user-visible-string catalog pass (M-T1.11,
// docs/old/proposals/i18n.md Phase 1).
//
// Walks a `UiIR`'s pages/components/menu and collects every user-visible
// string literal into `<key, message>` catalog entries.  A downstream renderer
// (`src/system/i18n-catalog.ts`) serialises them into `.loom/messages.en.json`,
// the diffable source-language catalog every locale is merged against.
//
// SCOPE OF THIS SLICE — plain string literals only.  Interpolated UI strings
// (`"Order ${o.id}"`) currently lower to a `binary "+"` chain (there is no ICU
// message node in the IR yet), so they are intentionally skipped here; the
// template→ICU lowering pass is a later slice, at which point this walk gains a
// branch for the message node.  A dynamic slot (a `ref`, a computed expr) is
// likewise not extractable and is skipped.
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
import { namedArgValue, positionalArgs } from "./shared/args.js";

/** One source-language catalog entry: a stable key and its English text. */
export interface MessageEntry {
  key: string;
  message: string;
}

/** Where a user-visible string sits inside a primitive call.  `role` is the
 *  human-readable slot label baked into the catalog key. */
type Slot =
  | { role: string; kind: "positional"; index: number }
  | { role: string; kind: "named"; name: string };

// The user-visible text slots per walker primitive.  Each slot is extracted
// only when it actually holds a plain string literal — so listing a primitive
// here is safe even when the slot is often dynamic (a `ref` slot is skipped).
// Verified against each primitive's emitter (src/generator/_walker/primitives/*).
const USER_VISIBLE_SLOTS: Record<string, readonly Slot[]> = {
  Heading: [{ role: "heading", kind: "positional", index: 0 }],
  Text: [{ role: "text", kind: "positional", index: 0 }],
  Bold: [{ role: "bold", kind: "positional", index: 0 }],
  Italic: [{ role: "italic", kind: "positional", index: 0 }],
  InlineCode: [{ role: "code", kind: "positional", index: 0 }],
  Empty: [{ role: "empty", kind: "positional", index: 0 }],
  Anchor: [{ role: "anchor", kind: "positional", index: 0 }],
  KeyValueRow: [{ role: "keyValue", kind: "positional", index: 0 }],
  Badge: [{ role: "badge", kind: "positional", index: 0 }],
  Button: [
    { role: "button", kind: "positional", index: 0 },
    { role: "buttonAria", kind: "named", name: "label" },
  ],
  Stat: [
    { role: "statLabel", kind: "positional", index: 0 },
    { role: "statValue", kind: "positional", index: 1 },
  ],
  Card: [{ role: "cardTitle", kind: "positional", index: 0 }],
  Alert: [
    { role: "alert", kind: "positional", index: 0 },
    { role: "alertTitle", kind: "named", name: "title" },
  ],
  Toolbar: [{ role: "toolbarAria", kind: "named", name: "label" }],
  Divider: [{ role: "dividerLabel", kind: "named", name: "label" }],
  Modal: [{ role: "modalTitle", kind: "named", name: "title" }],
};

/** The plain-string value of an expression, or undefined when it is not a
 *  bare string literal (a dynamic ref/expr, or an interpolated `+` chain). */
function literalString(e: ExprIR | undefined): string | undefined {
  if (e && e.kind === "literal" && e.lit === "string") return e.value;
  return undefined;
}

/** The catalog key for an inline literal: `<prefix>.<role>.<hash>`. */
function inlineKey(prefix: string, role: string, message: string): string {
  return `${prefix}.${role}.${contentHash(message)}`;
}

/** Collect the user-visible strings from one render-body expression tree,
 *  keyed under `<prefix>` (e.g. `page.OrderList` / `component.OrderCard`). */
function collectBody(body: ExprIR | undefined, prefix: string, out: MessageEntry[]): void {
  walkExprDeep(body, (e) => {
    if (e.kind !== "call") return;
    const slots = USER_VISIBLE_SLOTS[e.name];
    if (!slots) return;
    const positionals = positionalArgs(e);
    for (const slot of slots) {
      const arg =
        slot.kind === "positional" ? positionals[slot.index] : namedArgValue(e, slot.name);
      const message = literalString(arg);
      if (message === undefined) continue;
      out.push({ key: inlineKey(prefix, slot.role, message), message });
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
    if (title !== undefined) out.push({ key: inlineKey(prefix, "title", title), message: title });
    collectBody(page.body, prefix, out);

    // Per-page sidebar chrome — `menu { section: "…", label: "…" }` metadata.
    for (const entry of page.menuMeta?.entries ?? []) {
      if (entry.name !== "section" && entry.name !== "label") continue;
      const message = literalString(entry.value);
      if (message === undefined) continue;
      out.push({ key: inlineKey(prefix, `menu.${entry.name}`, message), message });
    }
  }

  for (const component of ui.components) {
    collectBody(component.body, `component.${component.name}`, out);
  }

  // UI-level `menu { section "…" { link "L" -> "url" } }` chrome.
  for (const section of ui.menu?.sections ?? []) {
    if (section.label) {
      out.push({ key: inlineKey("menu", "section", section.label), message: section.label });
    }
    for (const link of section.links) {
      if (link.kind === "external" && link.label) {
        out.push({ key: inlineKey("menu", "link", link.label), message: link.label });
      } else if (link.kind === "page") {
        const label = link.props.find((p) => p.name === "label");
        const message = literalString(label?.value);
        if (message !== undefined) {
          out.push({ key: inlineKey("menu", "link", message), message });
        }
      }
    }
  }

  return out;
}
