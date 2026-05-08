// ---------------------------------------------------------------------------
// Pack loader for the template-pack rendering layer.
//
// A pack is a directory containing a `pack.json` manifest plus the
// .hbs templates the manifest's `emits` map names.  Built-in packs
// live under `<repo>/themes/<name>/`; custom packs are user-supplied
// directories referenced by absolute or .ddd-relative path.
//
// Loading is eager: every template named in the manifest is read
// from disk and Handlebars-compiled at load time.  A missing template
// is a generation-time error (no fallback chain — see plan), naming
// the missing key explicitly so pack authors can fix it.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
  /** Absolute path to the pack root directory. */
  rootDir: string;
  /** Logical template name → compiled template. */
  templates: Map<string, CompiledTemplate>;
  /** Render a logical template against the given context.  Throws
   *  with a clear message if the name isn't in the manifest. */
  render(name: string, context: unknown): string;
}

/** Resolve the directory of the `themes/` root for built-in packs.
 *  Built-ins live under `<repo>/themes/<name>/`; this finds the repo
 *  root by walking up from this file's location. */
function builtinThemesDir(): string {
  // import.meta.url points at the compiled .js or the source .ts
  // depending on how the consumer is run.  Walk up from there until
  // we find a `themes/` sibling.  In repo layout the file lives at
  // `out/generator/react/templating/loader.js` (after build) or
  // `src/generator/react/templating/loader.ts` (source).  Both have
  // `themes/` four directories up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "themes");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    dir = path.dirname(dir);
  }
  throw new Error(
    `loader: could not locate built-in themes/ directory walking up from ${here}`,
  );
}

let helpersRegistered = false;

/** Register IR-semantic helpers globally — naming utilities + a
 *  `lookup`-by-default-key helper.  Called lazily on first pack load.
 *  Helpers are NOT pack-overridable: they're invariants of the IR
 *  contract, not theme decisions (a pack can't redefine "humanize"
 *  to mean something different and still consume the same VMs). */
function registerHelpersOnce(): void {
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
}

/** Resolve a pack identifier ("mantine" / "shadcn" / "./design/")
 *  to an absolute pack directory.  `referenceDir` is the directory
 *  the .ddd source lives in — used to anchor relative custom-pack
 *  paths.  Built-in names resolve under `<repo>/themes/<name>`. */
export function resolvePackDir(ui: string, referenceDir?: string): string {
  if (ui === "mantine" || ui === "shadcn") {
    return path.join(builtinThemesDir(), ui);
  }
  // Treat anything else as a path.  Absolute paths used as-is;
  // relative paths anchored against the .ddd file's dir when
  // available, otherwise the current working directory.
  if (path.isAbsolute(ui)) return ui;
  return path.resolve(referenceDir ?? process.cwd(), ui);
}

/** Load a pack from disk.  Reads pack.json, resolves every template
 *  named in `emits`, compiles each with Handlebars, and returns a
 *  ready-to-use LoadedPack. */
export function loadPack(packDir: string): LoadedPack {
  registerHelpersOnce();
  const manifestPath = path.join(packDir, "pack.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `loader: pack manifest not found at ${manifestPath}.  A pack must contain a pack.json file.`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as PackManifest;
  if (!manifest.emits || typeof manifest.emits !== "object") {
    throw new Error(
      `loader: pack at ${packDir} has no \`emits\` map in pack.json.  Add { emits: { "page-list": "page-list.hbs", ... } }.`,
    );
  }
  const templates = new Map<string, CompiledTemplate>();
  for (const [logicalName, fileName] of Object.entries(manifest.emits)) {
    const filePath = path.join(packDir, fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `loader: pack ${manifest.name}: template "${logicalName}" → "${fileName}" not found at ${filePath}.`,
      );
    }
    const source = fs.readFileSync(filePath, "utf-8");
    // strict: true => template throws on missing fields rather than
    // silently rendering them as empty.  Forces preparer + template
    // to stay in sync; missing fields surface immediately during
    // tests instead of leaking blanks into generated output.
    const fn = Handlebars.compile(source, {
      strict: true,
      noEscape: false,
    });
    templates.set(logicalName, { fn, filePath });
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
    rootDir: packDir,
    templates,
    render,
  };
}
