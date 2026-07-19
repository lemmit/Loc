// ---------------------------------------------------------------------------
// Pack loader for the template-pack rendering layer.
//
// A pack is a manifest (`pack.json`) plus the .hbs templates the
// manifest's `emits` map names.  This file holds the browser-safe
// core: types, global helper registration, and `compilePack` which
// turns a manifest + source map into a ready-to-render `LoadedPack`.
//
// Filesystem-bound concerns (locating built-in packs under
// `<repo>/designs/<name>/`, reading template files) live in the
// sibling `loader-fs.ts` so this module stays free of `node:fs` /
// `node:path` and bundles cleanly in the playground (which feeds
// templates in via Vite's `import.meta.glob`).
//
// Loading is eager: every template named in the manifest is compiled
// up front.  A missing template is a generation-time error — no
// fallback chain — naming the missing key explicitly so pack authors
// can fix it.
// ---------------------------------------------------------------------------

import Handlebars from "handlebars";
import type { PackFormat } from "../../util/builtin-formats.js";
import { humanize, lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import { flattenRequired, REQUIRED_PRIMITIVES } from "./required-primitives.js";

/** Output format the pack's templates produce.  `tsx` is the v0
 *  React/Mantine/shadcn case (Handlebars over .hbs files yielding
 *  TSX); `heex` is the Phoenix LiveView case (Handlebars over
 *  .heex.hbs files yielding HEEx); `svelte` is the Svelte 5 /
 *  SvelteKit case (Handlebars over .hbs files yielding Svelte
 *  markup).  Drives two things:
 *    1. Which repo-root shared-source directories the loader pulls
 *       in (TSX packs get `vite/`+`api/`+`docker/`; svelte packs get
 *       `sveltekit/` only — `docker/` stays TSX-side because the
 *       dockerfiles' logical names would collide (see loader-fs.ts);
 *       vue packs get `vue/`+`api/`+`docker/`; HEEx packs get a
 *       future `phoenix/` and skip the TSX dirs).
 *    2. Documentation — pack authors and downstream tooling can
 *       discriminate without parsing template contents.
 *  Handlebars itself is content-agnostic, so the compilation path
 *  doesn't branch on `format`.  Defaults to `"tsx"` for backward
 *  compatibility with existing manifests that omit the field.
 *  The union itself lives in `src/util/builtin-formats.ts` (shared
 *  with the language-layer validator); re-exported here so generator
 *  consumers keep their import path. */
export type { PackFormat };

/** Manifest schema for `<pack>/pack.json`. */
export interface PackManifest {
  /** Pack family name — informational, e.g. "mantine", "shadcn",
   *  "coreComponents".  Used in error messages; resolution is by
   *  directory layout, not by this field. */
  name: string;
  /** Pack version — **load-bearing.**
   *  Built-in packs ship at `designs/<family>/<vNN>/`; this field
   *  must equal the parent directory's `vNN` segment (e.g. `"v7"`
   *  for `designs/mantine/v7/pack.json`).  Loaders cross-check at
   *  load time and throw on mismatch — that catches copy-paste
   *  accidents (e.g. forking `designs/mantine/v7/` into
   *  `designs/mantine/v9/` without updating the manifest).  Custom
   *  packs not under the built-in tree may set any string; the
   *  cross-check only fires for paths under `designs/<family>/<vN>/`. */
  version: string;
  /** Stack identifier — names the cross-cutting framework baseline
   *  (React / react-router / zod / Vite / TS versions) the pack
   *  ships against.  `"v1"` = React 18 family, `"v3"` = React 19 +
   *  Router 7 + zod 4 family.  The loader resolves to `<repo>/stacks/<id>/`
   *  and registers every `.hbs` it finds there as a Handlebars
   *  partial, so pack templates can pull in cross-cutting
   *  fragments via `{{> stack-package-deps}}` and friends.  Omit
   *  the field for packs outside the TSX-stack world (e.g.
   *  coreComponents runs on Elixir / Phoenix and ignores this axis). */
  stack?: string;
  /** Output format — `"tsx"` (default) or `"heex"`.  See `PackFormat`. */
  format?: PackFormat;
  /** Logical template name → filename relative to the pack directory.
   *  Example: { "page-list": "page-list.hbs", "cell-id-link":
   *  "cell-id-link.hbs", ... }.  Names that the generator looks up
   *  but the manifest does not list yield a generation error. */
  emits: Record<string, string>;
  /** Optional pack-specific project-shell files: logical template
   *  name → output path inside the generated project.  Lets a pack
   *  declare extra shell files (Tailwind config, globals.css, lib
   *  utilities, etc.) without the generator hardcoding the mapping.
   *  Each key must also appear in `emits`.  Renders with empty
   *  context, like the rest of the project shell.  Built-in
   *  Mantine pack ships none; shadcn ships
   *  `tailwind-config`/`postcss-config`/`globals-css`/`lib-utils`. */
  shellFiles?: Record<string, string>;
  /** Optional glob-style shell-file mapping: template-name pattern
   *  → output-path template, where each `*` in the pattern captures
   *  one segment that `{1}`/`{2}`/... in the output template
   *  reference.  Lets packs ship a variable-length library of
   *  components without listing each by hand.  shadcn uses this
   *  for `components-ui-*` → `src/components/ui/{1}.tsx`; Mantine
   *  ships none. */
  shellGlobs?: Record<string, string>;
  /** Optional lookup-table helpers.  Each entry registers a
   *  Handlebars helper named after the key whose body is
   *  `(input) => table[input] ?? input` — unknown keys fall
   *  through verbatim so missing entries surface at TS-compile
   *  time rather than being silently dropped.  shadcn ships
   *  `lucide` (tabler-icon-name → lucide-icon-name remap); a
   *  heroicons-flavoured pack would ship its own `heroicons`
   *  helper here. */
  helpers?: Record<string, Record<string, string>>;
  /** Optional per-template import declarations.  When the body-
   *  walker dispatches a stdlib primitive (`primitive-stack`,
   *  `primitive-heading`, …) through the pack, it pulls the
   *  template's required imports from this map and merges them
   *  into the page's import block.  Without this declaration,
   *  packs would have to repeat themselves in TS code AND in
   *  templates; with it, every import lives next to the JSX
   *  that needs it.
   *
   *  Example (mantine):
   *    "imports": {
   *      "primitive-stack":   [{ "from": "@mantine/core", "named": ["Stack"] }],
   *      "primitive-heading": [{ "from": "@mantine/core", "named": ["Title"] }]
   *    }
   *
   *  Imports are deduped per page across primitives that share a
   *  source module.  Default imports aren't supported in v0
   *  because no built-in primitive needs them. */
  imports?: Record<string, ImportSpec[]>;
  /** Opt-in: this pack's `form-op-module` + `primitive-modal` templates
   *  thread the loaded record into the operation-form component, so a
   *  `this.<field>` parameter default (`reschedule(to: datetime = this.eta)`)
   *  can seed `defaultValues` as `record.<field>`.  Only packs that actually
   *  accept + pass the `record` prop set this — absent, a `this.*` op-param
   *  default falls back to the type-zero seed (the JSX-family op-form is a
   *  record-less module component by default). */
  seedsOpFormRecord?: boolean;
  /** Opt-in: this pack's `form-of-decls` template renders the server-sourced
   *  create-default overlay (fetch `usePrepare<Agg>`, then `reset` it over the
   *  type-zero seed with `keepDirtyValues`).  The hooks are RHF/React-shaped,
   *  so only the React packs set this — absent, a `now()` / `currentUser.*`
   *  field default degrades to the type-zero seed with no `usePrepare` import
   *  (the non-React frontends have no overlay yet). */
  seedsServerDefaults?: boolean;
}

/** A single named-import declaration: `import { ...named } from "<from>"`. */
export interface ImportSpec {
  from: string;
  named: string[];
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
  Handlebars.registerHelper("camel", (s: unknown) => lowerFirst(String(s)));
  Handlebars.registerHelper("pascal", (s: unknown) => upperFirst(String(s)));
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
  // String concatenation — enables dynamic partial dispatch via
  // `{{> (concat "cell-" kind)}}` in page-list/view-table/part-table
  // templates.  Last arg is Handlebars' options object — drop it.
  Handlebars.registerHelper("concat", function (this: unknown, ...args: unknown[]) {
    return args.slice(0, -1).map(String).join("");
  });
  // Range helper — `{{#each (range n)}}…{{/each}}` repeats a block n
  // times at compile time, yielding [0, 1, …, n-1].  Lets a template
  // unroll a count into static markup (e.g. Angular's multi-skeleton,
  // which has no runtime `v-for` analogue — the count is known when
  // the page is generated).  Non-numeric / negative inputs yield [].
  Handlebars.registerHelper("range", (n: unknown) => {
    const count = typeof n === "number" ? n : Number(n);
    if (!Number.isFinite(count) || count <= 0) return [];
    return Array.from({ length: Math.floor(count) }, (_, i) => i);
  });
}

/** Register pack-declared lookup-table helpers.  Each entry in the
 *  manifest's `helpers` map is exposed as a Handlebars helper that
 *  takes a key and returns `table[key] ?? key` — the unknown-key
 *  fall-through preserves the verb so missing entries surface as
 *  import-resolve errors at TS-compile time rather than being
 *  silently dropped.
 *
 *  Helpers register globally on Handlebars (no per-pack scoping).
 *  In practice each generation loads exactly one pack, so the
 *  global registration is fine; if two packs declared the same
 *  helper name with different tables, the most recently loaded
 *  pack wins.  shadcn's `lucide` helper (tabler→lucide name
 *  remap) is the only built-in user today. */
function registerPackHelpers(manifest: PackManifest): void {
  for (const [name, table] of Object.entries(manifest.helpers ?? {})) {
    Handlebars.registerHelper(name, (key: unknown) => {
      const k = String(key);
      return table[k] ?? k;
    });
  }
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
  pathFor: (fileName: string) => string,
  /** Cross-pack templates that compose primitives via partials and
   *  apply to every loaded pack — sourced from `<repo>/{vite,api,docker}/*.hbs`
   *  in the Node loader, an `import.meta.glob` of the same in the
   *  browser loader.  Registered as Handlebars partials BEFORE pack
   *  templates so a pack can override a shared template by emitting
   *  one with the same logical name.  Empty when no shared
   *  directory exists; backward-compatible with packs that haven't
   *  opted in.
   *
   *  Pack authors writing only primitives benefit: the shared
   *  high-level templates (page-list, page-detail, op-button, …)
   *  invoke `{{> primitive-button}}`/`{{> primitive-card}}` etc.
   *  and pick up whatever the loaded pack provides. */
  sharedSources: Record<string, string> = {},
  /** Compile-time options.  Test fixtures that probe a single
   *  manifest feature (helpers, shellFiles, …) opt out of the
   *  required-primitives gate so they don't have to ship the full
   *  40+ primitive set just to assert one manifest field parses. */
  options: { validateRequired?: boolean } = {},
): LoadedPack {
  registerHelpersOnce();
  registerPackHelpers(manifest);
  if (!manifest.emits || typeof manifest.emits !== "object") {
    throw new Error(
      `loader: pack at ${rootDir} has no \`emits\` map in pack.json.  Add { emits: { "page-list": "page-list.hbs", ... } }.`,
    );
  }
  // Register shared partials FIRST so a pack template with the same
  // logical name overrides them on the next pass below.  Shared
  // templates compose pack primitives via `{{> primitive-X}}` — the
  // partial dispatch picks up whichever pack is currently loaded,
  // so the same shared file produces Mantine output under one pack
  // and shadcn output under another.
  for (const [name, source] of Object.entries(sharedSources)) {
    Handlebars.registerPartial(name, source);
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
    // Register every template as a Handlebars partial under its
    // logical name.  This lets higher-level templates compose
    // primitives via `{{> primitive-button label=... }}` instead
    // of duplicating the design-system-specific JSX in every
    // place a button (or input, card, …) is needed.  Pack authors
    // become the single source of truth for "how does my design
    // system render X" — every other template invokes the
    // primitive partial.
    //
    // Caveat: imports declared in `pack.json` for a primitive
    // currently flow up only when the walker calls
    // `renderPrimitive` directly (see `body-walker.ts`); a future
    // step may extend the loader to track partial-use for
    // automatic import propagation.  For now, full-file templates
    // (page-list.hbs, page-detail.hbs, …) keep their explicit
    // import header and we use partials only where the parent
    // already imports the relevant components.
    Handlebars.registerPartial(logicalName, source);
  }
  // Shared templates the pack hasn't overridden also become
  // renderable via `pack.render(name, ctx)` — orchestration code
  // can pick a shared template (page-list, op-button, …) by name
  // without checking which pack ships the override and which
  // inherits the shared default.  Pack-specific templates above
  // already won the templates.set race when names collide.
  for (const [name, source] of Object.entries(sharedSources)) {
    if (templates.has(name)) continue;
    const fn = Handlebars.compile(source, {
      strict: true,
      noEscape: false,
    });
    templates.set(name, { fn, filePath: `<shared>/${name}.hbs` });
  }

  // Required-primitives gate.  Every built-in pack must satisfy the
  // tier list for its declared format — `compilePack` throws here if
  // a primitive declared required (in `required-primitives.ts`)
  // wasn't satisfied by either `manifest.emits` or `sharedSources`.
  //
  // Why not at first `pack.render(...)`: lazy resolution means a pack
  // missing `primitive-modal` would pass `loadPack` cleanly and only
  // blow up the first time a user's `.ddd` contained a modal call.
  // The error surface would be a confusing render-time failure deep
  // in the walker rather than a load-time message naming the missing
  // template.  Eager validation costs nothing — we already have the
  // `templates` map populated.
  const format = manifest.format ?? "tsx";
  const required = REQUIRED_PRIMITIVES[format];
  const validateRequired = options.validateRequired ?? true;
  const missing = validateRequired
    ? flattenRequired(required).filter((name) => !templates.has(name))
    : [];
  if (missing.length > 0) {
    throw new Error(
      `loader: pack ${manifest.name} (format: ${format}): missing required template(s): ${missing.join(", ")}.  ` +
        `Declare each in pack.json's \`emits\` map (or place a shared default under vite/, api/, docker/) and create the .hbs file.  ` +
        `See src/generator/_packs/required-primitives.ts for the per-format required set + policy.`,
    );
  }

  const render = (name: string, context: unknown): string => {
    const t = templates.get(name);
    if (!t) {
      throw new Error(
        `loader: pack ${manifest.name}: no template registered for "${name}".  Add it to pack.json's emits map (or place a shared default under one of vite/, api/, docker/) and create the .hbs file.`,
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
