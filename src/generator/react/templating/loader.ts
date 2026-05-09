// ---------------------------------------------------------------------------
// Pack loader for the template-pack rendering layer.
//
// A pack is a manifest (`pack.json`) plus the .hbs templates the
// manifest's `emits` map names.  This file holds the browser-safe
// core: types, global helper registration, and `compilePack` which
// turns a manifest + source map into a ready-to-render `LoadedPack`.
//
// Filesystem-bound concerns (locating built-in packs under
// `<repo>/themes/<name>/`, reading template files) live in the
// sibling `loader-fs.ts` so this module stays free of `node:fs` /
// `node:path` and bundles cleanly in the playground (which feeds
// templates in via Vite's `import.meta.glob`).
//
// Loading is eager: every template named in the manifest is compiled
// up front.  A missing template is a generation-time error (no
// fallback chain — see plan), naming the missing key explicitly so
// pack authors can fix it.
// ---------------------------------------------------------------------------

import Handlebars from "handlebars";
import {
  camel,
  humanize,
  pascal,
  plural,
  snake,
} from "../../../util/naming.js";

/** Manifest schema for `<pack>/pack.json`. */
export interface PackManifest {
  /** Pack name — informational, e.g. "mantine", "shadcn". */
  name: string;
  /** Pack version string — informational, e.g. "0.1.0". */
  version: string;
  /** Logical template name → filename relative to the pack directory.
   *  Example: { "page-list": "page-list.hbs", "cell-id-link":
   *  "cell-id-link.hbs", ... }.  Names that the generator looks up
   *  but the manifest does not list yield a generation error. */
  emits: Record<string, string>;
}

/** Compiled, ready-to-render template plus the source path it came
 *  from — kept for error messages. */
interface CompiledTemplate {
  fn: Handlebars.TemplateDelegate;
  filePath: string;
}

/** A pack loaded into memory: manifest + every template compiled and
 *  indexed by its logical name. */
export interface LoadedPack {
  manifest: PackManifest;
  /** Path or identifier the pack was loaded from (informational). */
  rootDir: string;
  /** Logical template name → compiled template. */
  templates: Map<string, CompiledTemplate>;
  /** Render a logical template against the given context.  Throws
   *  with a clear message if the name isn't in the manifest. */
  render(name: string, context: unknown): string;
}

let helpersRegistered = false;

/** Register IR-semantic helpers globally — naming utilities + a
 *  `lookup`-by-default-key helper.  Called lazily on first pack load.
 *  Helpers are NOT pack-overridable: they're invariants of the IR
 *  contract, not theme decisions (a pack can't redefine "humanize"
 *  to mean something different and still consume the same VMs). */
export function registerHelpersOnce(): void {
  if (helpersRegistered) return;
  helpersRegistered = true;
  Handlebars.registerHelper("humanize", (s: unknown) => humanize(String(s)));
  Handlebars.registerHelper("camel", (s: unknown) => camel(String(s)));
  Handlebars.registerHelper("pascal", (s: unknown) => pascal(String(s)));
  Handlebars.registerHelper("plural", (s: unknown) => plural(String(s)));
  Handlebars.registerHelper("snake", (s: unknown) => snake(String(s)));
  // Strict equality helper — Handlebars's built-in {{#if}} can't
  // compare values, so we expose a tiny shim for the common case.
  Handlebars.registerHelper("eq", function (this: unknown, a: unknown, b: unknown) {
    return a === b;
  });
  // JSX-brace helper: wraps a JS expression in `{}` for embedding
  // into JSX.  Templates that would otherwise need `{ {{{expr}}} }`
  // (with parser-pleasing inner spaces) write `{{expr expr}}` and
  // get tight output.  SafeString skips HTML escape so JS operators
  // (`<`, `>`, `&&`, etc.) round-trip verbatim.
  Handlebars.registerHelper("expr", (s: unknown) => new Handlebars.SafeString(`{${String(s)}}`));
  // JSON-stringify helper: emits a properly-quoted string literal
  // for embedding in generated TS source.  Used for theme tokens
  // (`fontFamily: {{json fontFamily}}` → `fontFamily: "Inter, …"`)
  // where the inner string contains characters (`"`, `\`) that
  // would otherwise need manual escaping.
  Handlebars.registerHelper("json", (v: unknown) => new Handlebars.SafeString(JSON.stringify(v)));
  // Array-join helper: turns ["a","b","c"] + sep ", " into "a, b, c".
  // Used for inline-import lists (`{{join tablerIcons ", "}}`).
  Handlebars.registerHelper("join", function (this: unknown, arr: unknown, sep: unknown) {
    if (!Array.isArray(arr)) return "";
    const s = typeof sep === "string" ? sep : ", ";
    return new Handlebars.SafeString(arr.join(s));
  });
  // Tabler → lucide icon-name remap.  iconForOp() in pages-builder
  // returns tabler names (IconPlus, IconCheck, …) by historical
  // accident — shadcn pack uses lucide-react which exports the
  // same conceptual icons under shorter names (Plus, Check, …).
  // Templates that target lucide use `{{lucide icon}}` to project
  // the tabler name onto its lucide twin.  Anything not in the
  // map falls through unchanged so unknown verbs still produce
  // valid JSX (lucide will throw at import-resolve time, which is
  // the right error to surface).
  const tablerToLucide: Record<string, string> = {
    IconPlus: "Plus",
    IconTrash: "Trash2",
    IconCheck: "Check",
    IconX: "X",
    IconTruckDelivery: "Truck",
    IconCreditCard: "CreditCard",
    IconPlayerPlay: "Play",
    IconPlayerStop: "Square",
    IconPencil: "Pencil",
    IconLink: "Link",
    IconAlertCircle: "AlertCircle",
    IconAlertTriangle: "AlertTriangle",
    IconBolt: "Zap",
    IconLayoutList: "LayoutList",
  };
  Handlebars.registerHelper("lucide", (s: unknown) => {
    const k = String(s);
    return tablerToLucide[k] ?? k;
  });
}

/** Compile a pack from its manifest plus a `name → source` map of
 *  template contents.  Pure: no I/O.  `rootDir` is informational
 *  (used in error messages and the returned `LoadedPack.rootDir`).
 *  `pathFor(fileName)` produces the value stamped into each
 *  compiled template's `filePath` — caller picks whether that's a
 *  real disk path (Node loader) or a synthetic `<pack>/<file>`
 *  identifier (browser loader). */
export function compilePack(
  rootDir: string,
  manifest: PackManifest,
  sources: Record<string, string>,
  pathFor: (fileName: string) => string = (f) => `${rootDir}/${f}`,
): LoadedPack {
  registerHelpersOnce();
  if (!manifest.emits || typeof manifest.emits !== "object") {
    throw new Error(
      `loader: pack at ${rootDir} has no \`emits\` map in pack.json.  Add { emits: { "page-list": "page-list.hbs", ... } }.`,
    );
  }
  const templates = new Map<string, CompiledTemplate>();
  for (const [logicalName, fileName] of Object.entries(manifest.emits)) {
    const source = sources[logicalName];
    if (source == null) {
      throw new Error(
        `loader: pack ${manifest.name}: template "${logicalName}" → "${fileName}" not found at ${pathFor(fileName)}.`,
      );
    }
    // strict: true => template throws on missing fields rather than
    // silently rendering them as empty.  Forces preparer + template
    // to stay in sync; missing fields surface immediately during
    // tests instead of leaking blanks into generated output.
    const fn = Handlebars.compile(source, {
      strict: true,
      noEscape: false,
    });
    templates.set(logicalName, { fn, filePath: pathFor(fileName) });
  }
  const render = (name: string, context: unknown): string => {
    const t = templates.get(name);
    if (!t) {
      throw new Error(
        `loader: pack ${manifest.name}: no template registered for "${name}".  Add it to pack.json's emits map and create the .hbs file.`,
      );
    }
    return t.fn(context);
  };
  return {
    manifest,
    rootDir,
    templates,
    render,
  };
}
