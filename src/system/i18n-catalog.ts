import { collectUiMessages } from "../generator/_walker/i18n-extract.js";
import type { EnrichedSystemIR } from "../ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// `<system>/.loom/messages.en.json` artifact (M-T1.11, i18n.md Phase 1).
//
// The source-language (English) message catalog: every user-visible string
// extracted from the system's UIs, keyed by its stable content-hash key
// (D-I18N-KEY).  One flat `{ key: message }` object, keys sorted, one per line
// — the translator-friendly shape from i18n.md open-question #3, and the diff
// surface `ddd i18n sync` merges each locale against.
//
// Derived at emit time from the enriched IR (mirrors `wire-spec.ts`); nothing
// is stamped on the model.  Emitted for every system, even an empty one — a
// stable `{}` is a valid, mergeable catalog and keeps the artifact's presence
// unconditional (no "sometimes there, sometimes not" for downstream tooling).
// ---------------------------------------------------------------------------

/** Build the flat, key-sorted `{ key: message }` catalog for a system. */
export function buildMessageCatalog(sys: EnrichedSystemIR): Record<string, string> {
  const byKey = new Map<string, string>();
  for (const ui of sys.uis) {
    for (const { key, message } of collectUiMessages(ui)) {
      // Same key ⇒ same content hash ⇒ same message; last-writer-wins is a
      // no-op that also collapses the same string used at many call sites.
      byKey.set(key, message);
    }
  }
  const out: Record<string, string> = {};
  for (const key of [...byKey.keys()].sort()) out[key] = byKey.get(key)!;
  return out;
}

/** Render the `.loom/messages.en.json` artifact for a system. */
export function renderMessageCatalog(sys: EnrichedSystemIR): string {
  return JSON.stringify(buildMessageCatalog(sys), null, 2) + "\n";
}
