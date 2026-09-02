// ---------------------------------------------------------------------------
// Sidebar nav LABEL tokens (M-T1.11 i18n; audit finding A13b).
//
// A `ui`'s explicit `menu { section "Sales" { link Orders { label: "All orders" } } }`
// contributes `menu.section.<hash>` / `menu.link.<hash>` entries to
// `.loom/messages.en.json` — the extraction pass has always written them
// (`_walker/i18n-extract.ts`).  Nothing ever rendered them: `menu-emitter.ts`
// handed the app shells a RAW string and every pack template spelled it
// `{{label}}`, so a translator translated text the app showed in English at
// every locale.  That is the same dead-key defect as an unrendered slot, seen
// from the catalog side.
//
// The fix is at the VIEW-MODEL layer, not in the 15 pack templates' markup: each
// nav entry carries its label ALREADY SPELLED for the target —
//
//   `labelText`          text position   (`{t(…)}` / `{{ t(…) }}` / raw)
//   `labelAttr "<name>"` attribute       (`name={t(…)}` / `:name='t(…)'` / …)
//
// — and the templates splice those verbatim through a triple stache.  With i18n
// off (or on a label with no catalog key, e.g. the DEFAULT aggregate/workflow
// sidebar, whose text the emitter derives rather than the author writing it) the
// token is the Handlebars-escaped raw string, i.e. byte-for-byte what `{{label}}`
// produced.  That equality is the whole reason `escapeExpression` is reused here
// rather than a hand-rolled escape.
// ---------------------------------------------------------------------------

import Handlebars from "handlebars";

/** How one frontend spells a translated label in each markup position.  The
 *  `key`/`message` pair is exactly what the extraction pass recorded, so the
 *  emitted `t()` call and the catalog entry cannot drift. */
export interface NavLabelSpelling {
  /** Text/child position. */
  text(key: string, message: string): string;
  /** A whole `<attr>=<value>` fragment, NO leading space (the template keeps
   *  the surrounding whitespace). */
  attr(attrName: string, key: string, message: string): string;
}

/** `t(key, message)` — the generated runtime's call, shared by every JS
 *  frontend (the same shape `_frontend/shell-chrome.ts` emits for chrome). */
function call(key: string, message: string): string {
  return `t(${JSON.stringify(key)}, ${JSON.stringify(message)})`;
}

/** React + Svelte — JSX-shaped single braces. */
export const JSX_NAV_LABELS: NavLabelSpelling = {
  text: (key, message) => `{${call(key, message)}}`,
  attr: (attrName, key, message) => `${attrName}={${call(key, message)}}`,
};

/** Vue — a mustache in text position, a bound `:attr` (single-quoted, since the
 *  `t()` call carries double quotes) in attribute position. */
export const VUE_NAV_LABELS: NavLabelSpelling = {
  text: (key, message) => `{{ ${call(key, message)} }}`,
  attr: (attrName, key, message) => `:${attrName}='${call(key, message)}'`,
};

/** Angular — the same mustache, resolved against the component instance (the
 *  shell already exposes `protected readonly t = t`), and a property binding. */
export const ANGULAR_NAV_LABELS: NavLabelSpelling = {
  text: (key, message) => `{{ ${call(key, message)} }}`,
  attr: (attrName, key, message) => `[${attrName}]='${call(key, message)}'`,
};

/** The label tokens spliced by the app-shell templates.  Present on every
 *  section and entry, so a strict-mode template never sees a missing field. */
export interface NavLabelTokens {
  /** The label ready for TEXT position. */
  labelText: string;
  /** `{{{labelAttr "label"}}}` — the whole attribute, named by the pack. */
  labelAttr: (attrName: unknown) => string;
}

function tokensFor(
  label: string,
  labelKey: string | undefined,
  spelling: NavLabelSpelling | undefined,
): NavLabelTokens {
  // No spelling (i18n off) or no catalog key (an emitter-derived default label,
  // which no translator ever sees) → the escaped raw string, exactly what the
  // `{{label}}` double-stache rendered.
  if (!spelling || !labelKey) {
    const escaped = Handlebars.escapeExpression(label);
    return { labelText: escaped, labelAttr: (n) => `${String(n)}="${escaped}"` };
  }
  return {
    labelText: spelling.text(labelKey, label),
    labelAttr: (n) => spelling.attr(String(n), labelKey, label),
  };
}

/** Anything carrying a nav label — structural, because each frontend narrows
 *  `NavSectionVM`/`NavEntryVM` to its own template shape before rendering. */
interface Labelled {
  label: string;
  labelKey?: string;
}

/** Decorate every section + entry of a sidebar with its label tokens.  Pure —
 *  returns new objects, leaving the input VMs untouched. */
export function withNavLabelTokens<E extends Labelled, S extends Labelled & { entries: E[] }>(
  sections: readonly S[],
  spelling?: NavLabelSpelling,
): Array<S & NavLabelTokens & { entries: Array<E & NavLabelTokens> }> {
  return sections.map((section) => ({
    ...section,
    ...tokensFor(section.label, section.labelKey, spelling),
    entries: section.entries.map((entry) => ({
      ...entry,
      ...tokensFor(entry.label, entry.labelKey, spelling),
    })),
  }));
}
