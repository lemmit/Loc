// ---------------------------------------------------------------------------
// Pack-DECLARED chrome (M-T1.11, i18n.md "pack-chrome catalogs").
//
// The design packs bake user-visible English into their `.hbs` templates — an
// array field's "Remove"/"Add <item>", an op dialog's "This operation has no
// parameters.", a bool cell's "Yes"/"No", a picker's "Select…".  The
// content-hash extraction pass (`_walker/i18n-extract.ts`) cannot see any of
// it: that pass walks the IR, and these strings exist only in a template.
//
// The `chrome.<name>` catalog (`_walker/i18n-chrome.ts`) covers the OTHER half
// of this problem — chrome an EMITTER builds and hands to a template as a
// ready-made token.  That works when the walker knows the string exists.  It
// does not scale to strings a pack invents on its own: a pack author would have
// to add a curated key in the toolchain, a token in the emitter's view model,
// and a threading argument at every call site — for a word only their pack
// renders.  Two of the fifteen packs spell the empty picker option "— select —"
// rather than "Select…"; one spells a breadcrumb landmark; the shadcn dialogs
// carry a visually-hidden "Close".  None of those belong in a shared table.
//
// So a pack DECLARES its own strings, in `pack.json`:
//
//     "chrome": {
//       "removeItem": "Remove",
//       "addItem":    "Add {item}"
//     }
//
// and its templates spell them through four Handlebars helpers this module
// binds into every `pack.render(...)` (see `loader.ts`):
//
//     {{{chrome "removeItem"}}}                  markup TEXT position
//     {{{chrome "addItem" item=elementLabel}}}   … with ICU hole values
//     {{{chromeAttr "aria-label" "paginationAria"}}}  a whole ATTRIBUTE
//     {{{chromeValue "operationSucceeded" operation=humanOp}}}  a target VALUE
//     {{{chromeImport "../i18n"}}}               the runtime import, whole-FILE
//                                                templates only
//
// WHY A MANIFEST BLOCK RATHER THAN SCRAPING THE `.hbs`.  Scraping cannot tell a
// user-visible word from a component name, an `@doc` string or a CSS class, and
// a pack author would have no way to opt a string out.  Worse, the extracted
// text would have no ROLE — and a role is what makes two occurrences of "Close"
// in one pack distinguishable to a translator.  A declaration is also the only
// form that can be VALIDATED (see `assertDeclaredChromeIsSane`) and gated: a
// template naming an undeclared role fails the render, loudly, at the pack that
// owns it.
//
// KEYS — `pack.<family>.<role>.<hash>`, consistent with D-I18N-KEY.
//   - `pack.` namespace: cannot collide with `page.*` / `component.*` / `menu.*`
//     (authored strings) or `chrome.*` (the curated emitter-side table).
//   - `<family>` not `<family>@<version>`: mantine v7 and v9 spell "Remove"
//     identically, and a translator should translate it ONCE.  When two
//     versions diverge the content hash separates them automatically — which is
//     the whole point of hashing the message rather than versioning the key.
//   - `<hash>` of the message: a pack REPHRASING its chrome re-keys, so `ddd
//     i18n sync` sees a delete-old + add-new instead of silently keeping a
//     translation of the previous wording.
//
// i18n-OFF IS BYTE-IDENTICAL BY CONSTRUCTION, not by reconstruction: the
// binding starts OFF, and OFF each helper returns exactly the bytes the
// template used to spell inline (`chromeImport` returns nothing at all).  A
// frontend opts in only for a UI that is already i18n-enabled by its authored
// strings — the same gate `APP_SHELL_CHROME` / `FORM_CHROME` use, so pack
// chrome never flips the translation runtime on for a string-less app.
// ---------------------------------------------------------------------------

import Handlebars from "handlebars";
import type { PackFormat } from "../../util/builtin-formats.js";
import { contentHash } from "../../util/content-hash.js";

/** The literal prefix of every pack-chrome binding the JS frontends emit.
 *
 *  A fragment template (a form field, an op dialog) renders INTO a page file
 *  whose import block is owned by the walker, so the walker greps its rendered
 *  output for this marker and wires `t` itself — the same honest question the
 *  hoisted-`DataGrid`-child renderers ask with `CHROME_T_CALL`, and for the
 *  same reason: whether the chrome appears at all is the active pack's call.
 *
 *  Precise on purpose — a looser `"t("` test matches `format(`, `getContext(`
 *  and friends. */
export const PACK_CHROME_T_CALL = 't("pack.';

/** The `pgettext` twin of {@link PACK_CHROME_T_CALL} for the HEEx packs.  Not
 *  used for import wiring (a HEEx template resolves `pgettext/2` through
 *  `html_helpers`, which every `~H` template already imports) — exported so
 *  tests can assert on the emitted call without re-spelling it. */
export const PACK_CHROME_PGETTEXT_CALL = 'pgettext("pack.';

/** The catalog key for one pack-declared chrome string: `pack.<family>.<role>.<hash>`. */
export function packChromeKey(family: string, role: string, message: string): string {
  return `pack.${family}.${role}.${contentHash(message)}`;
}

/** The full `{ key: message }` catalog a pack declares.  Every declared role,
 *  not the used-only subset: a template's use of a role is decided by the
 *  Handlebars conditionals around it (a `{{#if rowFields}}` branch), which is
 *  not statically knowable here.  That is the trade `FORM_CHROME` already
 *  documents — an unused key costs a translator one phrase, a missing one is a
 *  binding no locale can ever reach — and it is bounded by construction,
 *  because a pack only declares chrome it renders. */
export function packChromeCatalog(manifest: {
  name: string;
  chrome?: Record<string, string>;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [role, message] of Object.entries(manifest.chrome ?? {})) {
    out[packChromeKey(manifest.name, role, message)] = message;
  }
  return out;
}

/** Characters a declared chrome message may not contain.
 *
 *  Every one of them is significant to a grammar the message is spliced into
 *  UNQUOTED on the i18n-OFF path: `<`/`>` open a tag (and close an EEx `%>`),
 *  `"` closes the attribute form's delimiter, `\` and a backtick and `${`
 *  reopen a JS string.  Rejected at load time rather than escaped, because the
 *  OFF path's whole guarantee is that the bytes are the ones the pack author
 *  wrote — an escape would silently change them. */
const FORBIDDEN_IN_MESSAGE = /[<>"\\`]|\$\{/;

/** An ICU hole: `{name}`.  Holes are the ONLY braces a message may carry. */
const HOLE = /\{(\w+)\}/g;

/** Reject a chrome declaration that cannot be rendered safely.  Runs at pack
 *  load so a bad declaration names its own pack, rather than surfacing as
 *  mangled markup in a generated project. */
export function assertDeclaredChromeIsSane(manifest: {
  name: string;
  chrome?: Record<string, string>;
}): void {
  for (const [role, message] of Object.entries(manifest.chrome ?? {})) {
    if (typeof message !== "string" || message === "") {
      throw new Error(
        `pack-chrome: pack ${manifest.name} declares chrome role "${role}" with a non-string or empty message.`,
      );
    }
    if (FORBIDDEN_IN_MESSAGE.test(message)) {
      throw new Error(
        `pack-chrome: pack ${manifest.name} chrome role "${role}" contains a character that is significant to the markup it is spliced into (< > " \\ \` \${): ${JSON.stringify(message)}.`,
      );
    }
    if (message.replace(HOLE, "").includes("{") || message.replace(HOLE, "").includes("}")) {
      throw new Error(
        `pack-chrome: pack ${manifest.name} chrome role "${role}" has an unbalanced or non-ICU brace: ${JSON.stringify(message)}.  Braces are only allowed as ICU holes ({name}).`,
      );
    }
  }
}

/** How one frontend spells a translated chrome binding.  Three positions, and
 *  they genuinely differ per format — a Vue attribute grows a `:` prefix, an
 *  Angular one grows brackets, HEEx text rides an EEx tag. */
interface ChromeSpelling {
  /** The runtime CALL — `t(key, msg, values)` / `pgettext(key, msg)`. */
  call(key: string, message: string, holes: ReadonlyArray<[string, string]>): string;
  /** A target-language string literal (the i18n-OFF value position). */
  literal(text: string): string;
  /** Wrap a call for markup TEXT position. */
  text(expr: string): string;
  /** A whole bound attribute: `name={expr}` / `:name='expr'` / `[name]='expr'`. */
  attr(name: string, expr: string): string;
  /** The runtime import line for a whole-FILE template, or "" when the format
   *  resolves the call ambiently (HEEx's `html_helpers`). */
  importLine(specifier: string): string;
}

/** `t(key, default, { hole: "value" })` — the shared JS/TS spelling every
 *  frontend's generated `i18n` shim exposes.  Identical to the call
 *  `i18n-emit.ts` builds for authored strings, deliberately: a chrome call and
 *  a page-string call must be indistinguishable to the runtime. */
function jsCall(key: string, message: string, holes: ReadonlyArray<[string, string]>): string {
  const args = [JSON.stringify(key), JSON.stringify(message)];
  if (holes.length > 0) {
    args.push(`{ ${holes.map(([n, v]) => `${n}: ${JSON.stringify(v)}`).join(", ")} }`);
  }
  return `t(${args.join(", ")})`;
}

/** Elixir double-quoted literal.  A declared message cannot contain `"`, `\`,
 *  `<` or `>` (rejected at load), so only `#` — which would open an Elixir
 *  interpolation — and the HEEx-significant braces need escaping here.  `\xHH`
 *  produces the identical runtime string, so the emitted msgid still matches
 *  the `.po` entry byte for byte. */
function elixirLiteral(text: string): string {
  return `"${text.replace(/#/g, "\\#").replace(/\{/g, "\\x7B").replace(/\}/g, "\\x7D")}"`;
}

const JSX_SPELLING: ChromeSpelling = {
  call: jsCall,
  literal: (text) => JSON.stringify(text),
  text: (expr) => `{${expr}}`,
  attr: (name, expr) => `${name}={${expr}}`,
  importLine: (specifier) => `import { t } from ${JSON.stringify(specifier)};\n`,
};

const SPELLINGS: Record<PackFormat, ChromeSpelling> = {
  tsx: JSX_SPELLING,
  // Svelte 5 markup uses the same `{expr}` interpolation and the same
  // `attr={expr}` binding as JSX.
  svelte: JSX_SPELLING,
  vue: {
    call: jsCall,
    literal: (text) => JSON.stringify(text),
    text: (expr) => `{{ ${expr} }}`,
    // Single-quoted: the expression carries double-quoted JS string literals
    // (the key and the default), which a `"` delimiter would terminate.  The
    // same choice `vueTarget.renderAttrBinding` makes for such expressions.
    attr: (name, expr) => `:${name}='${expr}'`,
    importLine: (specifier) => `import { t } from ${JSON.stringify(specifier)};\n`,
  },
  angular: {
    call: jsCall,
    literal: (text) => JSON.stringify(text),
    text: (expr) => `{{ ${expr} }}`,
    // A plain HTML attribute needs `[attr.…]`; a component input takes the bare
    // bracket form.  Hyphenated names (`aria-label`, `data-*`) are always the
    // former — a bare `[aria-label]` targets a non-existent element property
    // and fails `ng build`.
    attr: (name, expr) => `[${name.includes("-") ? `attr.${name}` : name}]='${expr}'`,
    importLine: (specifier) => `import { t } from ${JSON.stringify(specifier)};\n`,
  },
  heex: {
    // gettext keys by the source STRING, Loom by a content hash — `pgettext/2`
    // carries both (the Loom key is the msgctxt).  Holes are rejected for HEEx
    // packs (see `chromeHelpers`), so the call never needs `loom_icu`.
    call: (key, message) => `pgettext(${elixirLiteral(key)}, ${elixirLiteral(message)})`,
    literal: elixirLiteral,
    text: (expr) => `<%= ${expr} %>`,
    attr: (name, expr) => `${name}={${expr}}`,
    // `pgettext/2` resolves ambiently in every `~H` template through
    // `html_helpers`' `use Gettext, backend: …` — there is nothing to import.
    importLine: () => "",
  },
};

/** Substitute a message's ICU holes with their literal values — the i18n-OFF
 *  rendering, which must reproduce the bytes the template used to spell. */
function fillHoles(message: string, holes: ReadonlyArray<[string, string]>): string {
  const byName = new Map(holes);
  return message.replace(HOLE, (whole, name: string) => byName.get(name) ?? whole);
}

/** The hole values passed as Handlebars hash args, as ordered pairs.  Values
 *  are STRINGS by construction: a pack supplies them from template data
 *  (`elementLabel`, `humanOp`) — compile-time text, not a runtime expression,
 *  which is what lets the i18n-OFF path splice them in verbatim. */
function holesOf(options: Handlebars.HelperOptions): Array<[string, string]> {
  return Object.entries(options.hash ?? {}).map(([name, value]) => [name, String(value)]);
}

/** Every `.hbs` helper this module binds, for one pack in one i18n state.
 *  `i18n: false` (the default a pack loads in) yields the raw bytes the
 *  template previously spelled inline. */
export function chromeHelpers(
  manifest: { name: string; chrome?: Record<string, string>; format?: PackFormat },
  i18n: boolean,
): Record<string, Handlebars.HelperDelegate> {
  const family = manifest.name;
  const format = manifest.format ?? "tsx";
  const spelling = SPELLINGS[format];

  const declared = (role: unknown): string => {
    const message = manifest.chrome?.[String(role)];
    if (message === undefined) {
      throw new Error(
        `pack-chrome: pack ${family} has no chrome string "${String(role)}".  Declare it in pack.json's \`chrome\` map: { "chrome": { "${String(role)}": "<English>" } }.`,
      );
    }
    return message;
  };

  const bind = (role: string, message: string, holes: Array<[string, string]>): string => {
    if (format === "heex" && holes.length > 0) {
      // Not a limitation worth hiding: gettext cannot substitute ICU holes on
      // its own (D-I18N-HEEX-ICU routes authored interpolation through
      // `loom_icu`), and no HEEx pack needs a holed chrome string.  Fail at the
      // pack rather than emit a `{item}` a user would read literally.
      throw new Error(
        `pack-chrome: pack ${family} chrome role "${role}" passes ICU hole values, which the heex format does not render.  Split the sentence or drop the hole.`,
      );
    }
    return spelling.call(packChromeKey(family, role, message), message, holes);
  };

  return {
    /** Markup TEXT position. */
    chrome(role: unknown, options: Handlebars.HelperOptions) {
      const message = declared(role);
      const holes = holesOf(options);
      const out = i18n
        ? spelling.text(bind(String(role), message, holes))
        : fillHoles(message, holes);
      return new Handlebars.SafeString(out);
    },
    /** A whole ATTRIBUTE, name included — the name itself changes shape under a
     *  binding on Vue (`:x`) and Angular (`[attr.x]`), so the template cannot
     *  spell it and take only the value. */
    chromeAttr(name: unknown, role: unknown, options: Handlebars.HelperOptions) {
      const message = declared(role);
      const holes = holesOf(options);
      const out = i18n
        ? spelling.attr(String(name), bind(String(role), message, holes))
        : `${String(name)}="${fillHoles(message, holes)}"`;
      return new Handlebars.SafeString(out);
    },
    /** A target-native VALUE — a JS expression slot (a toast argument, a `??`
     *  fallback), where the i18n-OFF form is a quoted string literal. */
    chromeValue(role: unknown, options: Handlebars.HelperOptions) {
      const message = declared(role);
      const holes = holesOf(options);
      const out = i18n
        ? bind(String(role), message, holes)
        : spelling.literal(fillHoles(message, holes));
      return new Handlebars.SafeString(out);
    },
    /** The translation-runtime import, for a template that emits a WHOLE FILE
     *  (`format-helpers`, a shadcn `components/ui/*`).  A fragment template
     *  must NOT use this — its output lands in a page file whose import block
     *  the walker owns; that path is wired by grepping for
     *  {@link PACK_CHROME_T_CALL}.
     *
     *  The specifier is the PACK's to give: only the pack knows where its file
     *  lands relative to the generated `i18n` module, and that differs per
     *  frontend (`../i18n` from `src/lib/format.ts` on React/Vue, `./i18n`
     *  where the runtime is a sibling under `src/lib/`). */
    chromeImport(specifier: unknown) {
      return new Handlebars.SafeString(i18n ? spelling.importLine(String(specifier)) : "");
    },
  };
}
