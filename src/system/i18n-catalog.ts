import { collectWireValidationMessages } from "../generator/_i18n/validation-catalog.js";
import { loadPack, resolvePackDir } from "../generator/_packs/loader-fs.js";
import { packChromeCatalog } from "../generator/_packs/pack-chrome.js";
import { chromeMergedWhenEnabled } from "../generator/_walker/i18n-chrome.js";
import { collectUiMessages } from "../generator/_walker/i18n-extract.js";
import type { EnrichedSystemIR, UiIR } from "../ir/types/loom-ir.js";
import { packFormatForBuiltin } from "../util/builtin-formats.js";

// ---------------------------------------------------------------------------
// `<system>/.loom/messages.en.json` artifact (M-T1.11, i18n.md).
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

/** Every DESIGN PACK a UI is rendered through, as declared-chrome catalogs
 *  (`pack.<family>.<role>.<hash>` → English).
 *
 *  A pack bakes user-visible English into its own `.hbs` templates ("Remove",
 *  "This operation has no parameters."), which no IR walk can see — so the
 *  translator-facing catalog has to read it off the pack itself.  Resolved from
 *  the model (`deployable.design`), like every other derivation here: nothing
 *  is stamped, and `ddd i18n extract` reaches the same strings without running
 *  codegen.
 *
 *  Scoped to BUILT-IN packs, decided by pure data (`packFormatForBuiltin`) so
 *  no unresolvable `design:` can throw here.  An out-of-tree custom pack's
 *  chrome still reaches the generated app's own `locales/en.json` (that path
 *  has the loaded pack in hand); it does not reach `.loom/messages.en.json`. */
function packChromeForUi(sys: EnrichedSystemIR, ui: UiIR): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dep of sys.deployables) {
    const design = dep.design;
    if (!design) continue;
    if (dep.uiName !== ui.name && !(dep.hostedUiNames ?? []).includes(ui.name)) continue;
    if (packFormatForBuiltin(design) === undefined) continue;
    Object.assign(out, packChromeCatalog(loadPack(resolvePackDir(design)).manifest));
  }
  return out;
}

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
  // Always-rendered app-shell chrome (404 text, skip link) plus each UI's
  // design-pack DECLARED chrome — merged only when the system is already
  // i18n-enabled by its authored strings (the shell emitters' gate), so a
  // string-less system stays `{}` and its generated projects stay
  // byte-identical.
  if (byKey.size > 0) {
    for (const [key, message] of Object.entries(chromeMergedWhenEnabled())) byKey.set(key, message);
    for (const ui of sys.uis) {
      for (const [key, message] of Object.entries(packChromeForUi(sys, ui)))
        byKey.set(key, message);
    }
  }
  // BACKEND validation messages (M-T1.11) — an authored `message "…"` on an
  // `invariant` / `check` / `precondition`, keyed by the `msg.<hash>` code the
  // wire validators put on `errors[].code` and every backend's own catalog is
  // keyed by.  Merged in AFTER the chrome gate deliberately: these are server-side
  // strings, so a UI-less system with authored rule messages has a real catalog
  // to translate without pulling in app-shell chrome no frontend renders.
  for (const sub of sys.subdomains) {
    for (const { code, text } of collectWireValidationMessages(sub.contexts)) byKey.set(code, text);
  }
  const out: Record<string, string> = {};
  for (const key of [...byKey.keys()].sort()) out[key] = byKey.get(key)!;
  return out;
}

/** Render the `.loom/messages.en.json` artifact for a system. */
export function renderMessageCatalog(sys: EnrichedSystemIR): string {
  return JSON.stringify(buildMessageCatalog(sys), null, 2) + "\n";
}
