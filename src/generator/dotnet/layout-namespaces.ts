// ---------------------------------------------------------------------------
// Layout-aware C# namespace rewriting for the dotnet backend.
//
// The dotnet emitters are layout-agnostic: they always author byLayer-shaped
// content (`namespace <Ns>.Application.Orders.Commands;`, `using
// <Ns>.Domain.Orders;`, …).  When `directoryLayout: byFeature` relocates an
// aggregate's files under `Features/<Plural>/`, the project still COMPILES
// untouched (C# namespaces are path-independent and the .csproj globs
// `**/*.cs`) — but it isn't idiomatic vertical-slice code: a file under
// `Features/Orders/Commands/` would keep declaring
// `namespace <Ns>.Application.Orders.Commands`.
//
// This pass is the dotnet analogue of the TS backend's
// `typescript/layout-imports.ts` (which rewrites relative import specifiers
// after a relocation): it runs once, after every file is placed, and makes
// each relocated file's namespace MIRROR its feature folder
// (`Features/Orders/Commands/CreateOrder.cs` →
// `namespace <Ns>.Features.Orders.Commands;`), then fixes every reference to
// a renamed namespace across the whole project:
//
//   1. The relocated file's own `namespace …;` declaration.
//   2. `using <oldNs>;` directives everywhere — including SPLITS, where one
//      byLayer namespace scatters across features (`<Ns>.Infrastructure
//      .Repositories` holds every aggregate's repository; each moves to its
//      own `<Ns>.Features.<Plural>`).  A split expands to the new namespaces
//      whose relocated types the file actually mentions, keeps the old
//      namespace only while some non-relocated file still declares it, and
//      drops directives that became the file's own namespace.  Duplicates
//      are collapsed (CS0105 is a warning — fatal under `/warnaserror`).
//   3. Fully-qualified references (`<Ns>.Domain.Orders.IOrderRepository` in
//      Program.cs's DI registrations).  Inside a namespaced file the
//      replacement is `global::`-anchored: relative resolution would bind
//      the first segment against enclosing namespaces (`<Ns>.Api` exists,
//      so a bare `<Ns>.…` inside one resolves wrong).
//   4. Namespace-RELATIVE qualified references — `new
//      Configurations.OrderConfiguration()` inside AppDbContext resolves
//      relative to its `<Ns>.Infrastructure.Persistence` namespace; when the
//      target type moved, the reference is re-anchored with `global::`.
//
// When nothing was relocated (the byLayer default) the pass is a NO-OP, so
// byLayer output stays byte-identical.  Compile-gated by
// `test/e2e/fixtures/dotnet-build/byfeature.ddd` under LOOM_DOTNET_BUILD.
// ---------------------------------------------------------------------------

/** Path prefix the byFeature layout adapter relocates under.  Only files
 *  below it get their namespaces rewritten; everything else only has its
 *  REFERENCES to renamed namespaces fixed. */
const FEATURE_PREFIX = "Features/";

/** File-scoped namespace declaration — every relocatable dotnet emitter
 *  authors this form.  (The only block-scoped namespace in the output is
 *  the EF migrations file, which never relocates.) */
const FILE_SCOPED_NS_RE = /^namespace ([A-Za-z_][\w.]*);$/m;

/** Any namespace declaration (file-scoped or block) — used to inventory
 *  which namespaces are still declared after the rewrite. */
const ANY_NS_DECL_RE = /^namespace ([A-Za-z_][\w.]*)/gm;

/** Top-level type declarations in a generated file.  Generated code only
 *  declares `class` / `record` / `interface` / `enum` (plus `record struct`,
 *  whose name the `struct` arm catches). */
const TYPE_DECL_RE = /\b(?:class|record|interface|enum|struct)\s+([A-Za-z_]\w*)/g;

const USING_LINE_RE = /^using ([A-Za-z_][\w.]*);$/;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface NamespaceMove {
  readonly newNs: string;
  /** Simple names of the types that moved from the old namespace to
   *  `newNs` — drives both qualified-reference rewriting and the
   *  reference test that keeps split `using` expansion tight. */
  readonly types: readonly string[];
}

/**
 * Rewrite C# namespaces after a layout relocation so each relocated file's
 * namespace mirrors its on-disk folder.
 *
 * @param out  The emitted file map (path → content), keyed by FINAL paths
 *             (post-relocation).  Mutated in place.
 * @param root The project's root namespace (the capitalised deployable
 *             name the emitters thread as `ns`).
 */
export function rewriteNamespacesForLayout(out: Map<string, string>, root: string): void {
  // -- Collect the relocated files and their namespace moves. ------------
  // oldNs → the moves out of it (one per distinct new namespace).
  const renames = new Map<string, NamespaceMove[]>();
  const relocated: { path: string; oldNs: string; newNs: string }[] = [];
  for (const [path, content] of out) {
    if (!path.endsWith(".cs") || !path.startsWith(FEATURE_PREFIX)) continue;
    const decl = FILE_SCOPED_NS_RE.exec(content);
    if (!decl) continue; // defensive — every relocatable emitter is file-scoped
    const oldNs = decl[1]!;
    const dir = path.slice(0, path.lastIndexOf("/"));
    const newNs = `${root}.${dir.replaceAll("/", ".")}`;
    if (oldNs === newNs) continue;
    relocated.push({ path, oldNs, newNs });
    const types = [...content.matchAll(TYPE_DECL_RE)].map((m) => m[1]!);
    const moves = renames.get(oldNs) ?? [];
    const existing = moves.find((m) => m.newNs === newNs);
    if (existing) {
      (existing.types as string[]).push(...types);
    } else {
      moves.push({ newNs, types: [...types] });
    }
    renames.set(oldNs, moves);
  }
  if (relocated.length === 0) return; // byLayer — never touch anything

  // -- 1. Rewrite the relocated files' own namespace declarations. -------
  for (const f of relocated) {
    const content = out.get(f.path)!;
    out.set(f.path, content.replace(`namespace ${f.oldNs};`, `namespace ${f.newNs};`));
  }

  // -- Inventory the namespaces still declared post-rewrite (an old
  //    namespace SURVIVES a split when a non-relocated file keeps it,
  //    e.g. `<Ns>.Api` keeps the exception filters after the controllers
  //    move out). ----------------------------------------------------------
  const declared = new Set<string>();
  for (const [path, content] of out) {
    if (!path.endsWith(".cs")) continue;
    for (const m of content.matchAll(ANY_NS_DECL_RE)) declared.add(m[1]!);
  }

  // -- 2–4. Fix every reference across the project. ----------------------
  for (const path of [...out.keys()]) {
    if (!path.endsWith(".cs")) continue;
    const original = out.get(path)!;
    let content = original;
    const fileNs = /^namespace ([A-Za-z_][\w.]*)/m.exec(content)?.[1];

    for (const [oldNs, moves] of renames) {
      for (const move of moves) {
        for (const t of move.types) {
          // Fully-qualified `<oldNs>.<Type>` references.  `global::` inside
          // a namespaced file (relative first-segment lookup is unsafe
          // there); plain in namespace-less files (Program.cs top-level).
          const fqn = fileNs ? `global::${move.newNs}.${t}` : `${move.newNs}.${t}`;
          content = content.replace(new RegExp(`\\b${escapeRe(oldNs)}\\.${t}\\b`, "g"), fqn);
        }
        // Namespace-relative qualified references (AppDbContext's
        // `Configurations.<Agg>Configuration`): visible only from files
        // whose own namespace prefixes the old one.
        if (fileNs && oldNs.startsWith(`${fileNs}.`)) {
          const rel = oldNs.slice(fileNs.length + 1);
          for (const t of move.types) {
            content = content.replace(
              new RegExp(`(?<![\\w.])${escapeRe(rel)}\\.${t}\\b`, "g"),
              `global::${move.newNs}.${t}`,
            );
          }
        }
      }
    }

    content = rewriteUsings(content, renames, declared, fileNs);
    if (content !== original) out.set(path, content);
  }
}

/** Rewrite the `using <oldNs>;` directives of one file per the rename map.
 *  See the header — handles splits via a reference test, keeps surviving
 *  old namespaces, drops own-namespace directives, dedupes (CS0105). */
function rewriteUsings(
  content: string,
  renames: Map<string, NamespaceMove[]>,
  declared: Set<string>,
  fileNs: string | undefined,
): string {
  const lines = content.split("\n");
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const m = USING_LINE_RE.exec(line);
    if (!m) {
      result.push(line);
      continue;
    }
    const target = m[1]!;
    const moves = renames.get(target);
    const targets: string[] = [];
    if (!moves) {
      targets.push(target);
    } else {
      // The old namespace survives only while something still declares it.
      if (declared.has(target)) targets.push(target);
      for (const move of moves) {
        // A directive for the file's OWN namespace is redundant — the
        // common case being a feature file that used to import its
        // aggregate's Domain namespace and now shares a namespace with it.
        if (move.newNs === fileNs) continue;
        // Split expansion stays tight: only namespaces whose relocated
        // types this file actually mentions.
        if (move.types.length === 0) continue;
        const refRe = new RegExp(`\\b(?:${move.types.map(escapeRe).join("|")})\\b`);
        if (refRe.test(content)) targets.push(move.newNs);
      }
    }
    for (const t of targets) {
      if (seen.has(t)) continue;
      seen.add(t);
      result.push(`using ${t};`);
    }
    // All targets gone (own-namespace / unreferenced split) → line dropped.
  }
  return result.join("\n");
}
