// Generator for `docs/stdlib.md` — the standard-library reference, built
// from the registries so the doc is a projection of the single source of
// truth (never hand-maintained, never drifting):
//   - Layer 0 scalar intrinsics  → src/util/intrinsics.ts
//   - collection operations      → src/util/collection-ops.ts
//   - Layer 1 ambient prelude    → src/language/stdlib-source.ts
//
// `scripts/gen-stdlib-docs.mjs` writes the output; a drift test
// (`test/system/stdlib-doc-sync.test.ts`) re-renders and compares against
// the committed file so a registry change without a doc regen fails CI —
// the same guard `langium-generated.yml` gives the parser output.  Lives at
// the system layer (the top of language → ir → generator → system): it may
// read the util catalogues and the language-layer prelude source, never the
// reverse.

import { STD_SOURCES } from "../language/stdlib-source.js";
import { COLLECTION_OP_SIGNATURES } from "../util/collection-ops.js";
import { INTRINSIC_SIGNATURES, type IntrinsicReceiver } from "../util/intrinsics.js";

/** Do-not-edit banner — points a reader who opens the file at the regen
 *  command instead of hand-editing. */
const BANNER =
  "<!-- GENERATED FILE — do not edit by hand.  Regenerate with `npm run docs:stdlib`\n" +
  "     (source of truth: src/util/intrinsics.ts, src/util/collection-ops.ts,\n" +
  "     src/language/stdlib-source.ts). -->";

/** Receiver groups rendered in order; each becomes an intrinsic sub-table
 *  when the catalogue has rows for it. */
const RECEIVER_ORDER: ReadonlyArray<{ receiver: IntrinsicReceiver; heading: string }> = [
  { receiver: "string", heading: "string" },
  { receiver: "int", heading: "int" },
  { receiver: "long", heading: "long" },
  { receiver: "decimal", heading: "decimal" },
  { receiver: "money", heading: "money" },
  { receiver: "datetime", heading: "datetime" },
];

/** One-line human blurb per prelude module (keyed by the STD_SOURCES key). */
const PRELUDE_BLURBS: Readonly<Record<string, string>> = {
  strings: "String predicates and shaping.",
  math: "Numeric clamping, ratios, and rounding.",
  temporal: "Datetime comparisons against `now()`.",
};

function intrinsicTable(receiver: IntrinsicReceiver): string {
  const rows = INTRINSIC_SIGNATURES.filter((s) => s.receiver === receiver);
  if (rows.length === 0) return "";
  const lines = [
    `#### \`${receiver}\``,
    "",
    "| op | signature | queryable |",
    "| --- | --- | --- |",
    ...rows.map((s) => `| \`${s.name}\` | \`${s.signature}\` | ${s.queryable ? "yes" : "no"} |`),
    "",
  ];
  return lines.join("\n");
}

/** Render the full `docs/stdlib.md` body.  Pure: same registries in →
 *  byte-identical markdown out (the drift test relies on this). */
export function renderStdlibMarkdown(): string {
  const out: string[] = [];

  out.push("# Standard library");
  out.push("");
  out.push(BANNER);
  out.push("");
  out.push(
    "Loom ships a small standard library in two layers.  **Layer 0** is the set of",
    "built-in *intrinsics* — irreducible operations on scalar and collection",
    "receivers that the compiler renders natively on every backend (and, where",
    "marked queryable, pushes down to SQL).  **Layer 1** is the *ambient prelude* —",
    "ordinary expression-form top-level functions written in Loom on top of Layer 0,",
    "callable with nothing imported and inlined at each call site.",
    "",
    "This page is generated from the registries; see `docs/language.md` for the",
    "surrounding expression-language reference and `docs/old/plans/stdlib.md` for the",
    "roadmap.",
    "",
  );

  // ---- Layer 0: scalar intrinsics --------------------------------------
  out.push("## Layer 0 — scalar intrinsics");
  out.push("");
  out.push(
    "Built-in operations on a scalar receiver.  A `queryable` op may appear in a",
    "`find … where` predicate (and criterion / capability filters); a",
    "non-queryable one in that position is rejected — `loom.find-where-not-queryable`",
    "on a repository find, `loom.criterion-not-selectable` on a criterion or",
    "capability `filter` — rather than silently degrading.",
    "",
    "`startsWith` is the one BOOL-returning queryable op, so it stands alone as a",
    "whole predicate (`filter this.dataKey.startsWith(p)`) instead of feeding a",
    "comparison.  It lowers to an ANCHORED position test on every backend",
    "(`strpos(col, $p) = 1`, JPQL `locate(:p, col) = 1`, EF Core's one-argument",
    "`StartsWith`) rather than `col LIKE $p || '%'`: the argument is a value, so a",
    "`%` or `_` inside it matches literally.",
    "",
    "These are Loom's OWN spellings, translated per target — `s.toUpper()` is",
    "`toUpperCase()` in JavaScript, `.ToUpper()` in C#, `String.upcase/1` in",
    "Elixir.  Two carry semantics the host language spells the same but defines",
    "differently, so read the contract, not the name: **`replace` replaces every",
    "occurrence** (not just the first), and **`substring(start, len)` takes a",
    "LENGTH** (not an end index).",
    "",
    "Available in aggregate/operation bodies on all five backends, and in page /",
    "component expressions on the four JS frontends (React / Vue / Svelte /",
    "Angular), which share the TypeScript backend's snippet table.  Feliz and",
    "Flutter page bodies do not translate them yet.",
    "",
  );
  for (const { receiver } of RECEIVER_ORDER) {
    const table = intrinsicTable(receiver);
    if (table) out.push(table);
  }

  // ---- collection operations -------------------------------------------
  out.push("## Collection operations");
  out.push("");
  out.push(
    "Operations on a collection receiver `T[]`.  These render in-memory on every",
    "backend that executes domain logic; they are non-queryable (a reference-",
    "collection `contains` is the one exception — it pushes down to an `EXISTS`",
    "subquery).  `λ` is a lambda whose parameter is bound to the element type.",
    "",
    "**Nine of these render in a page body too.**  The ops that RESHAPE a",
    "collection — `count`, `where`, `any`, `all`, `map`, `sortBy`, `take`,",
    "`skip`, `join` — have a real renderer on every frontend (React / Vue /",
    "Svelte / Angular / Feliz / Flutter, and the Phoenix LiveView walker), so",
    "`rows.where(o => o.open).count` is an ordinary page expression.",
    "",
    "The other eight are refused in a page / component / store expression",
    "(`loom.frontend-collection-op-unsupported`), because the frontends disagree",
    "on how the RESULT is represented: `sum` / `min` / `max` / `avg` fold",
    "arithmetic, and `money` is a `Decimal` object on the JS frontends and",
    "Phoenix but a native scalar on Feliz and Flutter; `first` / `firstOrNull`",
    "differ on emptiness and on the optional type; `distinct` / `contains` need",
    "value equality, which Flutter's generated models do not define.  For those,",
    "compute the value in a repository `find`, an aggregate `derived`, or a",
    "`projection` read model and bind the result in the page.  See",
    "[`page-metamodel.md` §8.1](page-metamodel.md).",
    "",
    "| op | signature |",
    "| --- | --- |",
    ...COLLECTION_OP_SIGNATURES.map((s) => `| \`${s.name}\` | \`${s.signature}\` |`),
    "",
  );

  // ---- Layer 1: the ambient prelude ------------------------------------
  out.push("## Layer 1 — the ambient prelude");
  out.push("");
  out.push(
    "Auto-injected top-level functions, callable in any `.ddd` with nothing",
    "imported.  Each is expression-form, so a call inlines and an uncalled",
    "function emits nothing; a user-declared top-level function of the same name",
    "shadows the prelude.",
    "",
  );
  for (const [name, source] of Object.entries(STD_SOURCES)) {
    out.push(`### \`${name}\``);
    out.push("");
    const blurb = PRELUDE_BLURBS[name];
    if (blurb) {
      out.push(blurb);
      out.push("");
    }
    out.push("```ddd");
    out.push(source.trim());
    out.push("```");
    out.push("");
  }

  // Single trailing newline.
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}
