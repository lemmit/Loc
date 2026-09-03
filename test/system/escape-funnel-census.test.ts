// ---------------------------------------------------------------------------
// The escape-funnel census (Wave 2 packet 2.2, F2-ELX-ESCAPE-FUNNEL class).
//
// `elixirString`/`elixirRegexBody` (src/util/naming.ts) are the Elixir
// escape funnel — but per the Wave 1 elixir hand-off
// (docs/new-plan/waves/handoffs/wave-1-elixir.md), they have NO ENFORCEMENT:
// nine live injection sites were found only by a human reading every call
// site twice. A lint rule closes that gap for good: this test scans
// `src/generator/**` for every `JSON.stringify(` call and classifies it by
// DESTINATION, following the Wave 1 hand-off's own taxonomy —
//
//   1. JS/TS-FAMILY position (typescript/, react/, vue/, svelte/, angular/,
//      _frontend/, _obs/, _payload/, _channels/, _packs/, any `js-*.ts` leaf,
//      zod-refine.ts, and the two feliz/flutter files that emit real JS/JSON
//      config despite their directory) — `JSON.stringify` genuinely IS this
//      backend's `escapeStringLiteral` (ExprTarget) / the JS string-literal
//      rule these shared JS-only leaves render. Auto-pass.
//   2. A backend whose double-quoted string literal does NOT interpolate
//      (C#/Java/Python: dotnet/, java/, python/) — `JSON.stringify`'s
//      escaping is already correct target syntax there (see
//      `_expr/target.ts`'s `escapeStringLiteral` doc). One recorded reason
//      per directory.
//   3. Everything else — elixir/, feliz/, flutter/, and the `_walker`/`_expr`
//      files shared across every target — is the DANGER bucket: a splice
//      here can land in Elixir's interpolating `"…"` / `~r/…/`, Dart's
//      `$`-interpolating string, or a SQL/Ecto fragment. Every call site
//      here must match a documented SAFE PATTERN (a compiler-controlled
//      identifier — grammar's `ID` terminal can never carry `#{`/`$`/`"` —
//      a naming-normalizer or known-safe transform call over one, a
//      NUMBER-literal under `Decimal.new`, …) or carry an individual,
//      file+arg-KEYED waiver with a reviewed reason. An unmatched, unwaived
//      site FAILS the census by file:line.
//
// WAIVERS RATCHET: each must be CONSUMED by at least one real call site — a
// waiver nothing matches is stale and fails the test by name (CLAUDE.md
// "Mutation-prove a new gate before trusting it" — waivers ratchet).
//
// MUTATION-PROVED (Wave 2 packet 2.2 hand-off quotes the exact assertion
// name): introducing a bare `JSON.stringify(value)` splice of a genuinely
// risky identifier (e.g. `message`) into src/generator/elixir/** with no
// matching safe pattern or waiver fails "every danger-bucket JSON.stringify
// site is safe-by-pattern or waived, and every waiver is used" at the
// introduced file:line. Deleting a waiver whose site is still live fails
// the "stale waiver(s)" assertion the same way.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const GEN_ROOT = join(REPO_ROOT, "src", "generator");

/** One `JSON.stringify(` call site: its file (repo-relative, forward
 *  slashes), 1-based line, and the balanced-paren argument text (single-line
 *  capture — every call in this codebase is written on one line; a
 *  multi-line call would extract a truncated argument and very likely fail
 *  its pattern, which is the safe direction to be wrong in — see the
 *  `flutter/index.ts` multi-line site, checked separately below). */
interface CallSite {
  file: string;
  line: number;
  arg: string;
}

function collectTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collectTsFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
}

/** Extract the balanced-paren argument of one `JSON.stringify(` call
 *  starting at `startIdx` (the index right after the opening paren) within
 *  `line`. */
function extractArg(line: string, startIdx: number): string {
  let depth = 1;
  let j = startIdx;
  while (j < line.length && depth > 0) {
    if (line[j] === "(") depth++;
    else if (line[j] === ")") depth--;
    j++;
  }
  return (depth === 0 ? line.slice(startIdx, j - 1) : line.slice(startIdx)).trim();
}

function collectCallSites(): CallSite[] {
  const files: string[] = [];
  collectTsFiles(GEN_ROOT, files);
  const sites: CallSite[] = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file).replaceAll("\\", "/");
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      let idx = line.indexOf("JSON.stringify(");
      while (idx !== -1) {
        sites.push({
          file: rel,
          line: i + 1,
          arg: extractArg(line, idx + "JSON.stringify(".length),
        });
        idx = line.indexOf("JSON.stringify(", idx + 1);
      }
    }
  }
  return sites;
}

// ---------------------------------------------------------------------------
// Bucket 1 — JS/TS-family: `JSON.stringify` genuinely IS the escape rule.
// ---------------------------------------------------------------------------

const JS_FAMILY_DIR_PREFIXES = [
  "src/generator/typescript/",
  "src/generator/react/",
  "src/generator/vue/",
  "src/generator/svelte/",
  "src/generator/angular/",
  "src/generator/_frontend/",
  "src/generator/_obs/",
  "src/generator/_payload/",
  "src/generator/_channels/",
  "src/generator/_packs/",
];

/** Files that live under a non-JS backend/frontend directory but genuinely
 *  emit a JS/JSON position (package.json / tailwind config / web manifest
 *  bodies) — the DESTINATION is JSON, not the host language. */
const JS_POSITION_FILE_EXCEPTIONS = new Set([
  "src/generator/feliz/index.ts", // package.json + tailwind.config.js bodies
]);

function isJsFamily(file: string): boolean {
  if (JS_FAMILY_DIR_PREFIXES.some((p) => file.startsWith(p))) return true;
  const base = file.slice(file.lastIndexOf("/") + 1);
  // `js-*.ts` leaves are JS-only by naming convention: consumed exclusively
  // via `...jsExprLeaves` / the `js-target-helpers.ts` imports in the four
  // JSX-family walker targets (react/vue/svelte/angular), never by Feliz or
  // Flutter (which have their own FS_LEAVES / DART_LEAVES tables instead).
  if (base.startsWith("js-")) return true;
  if (file === "src/generator/zod-refine.ts") return true;
  if (JS_POSITION_FILE_EXCEPTIONS.has(file)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Bucket 2 — non-interpolating backend target: C#/Java/Python. Neither
// language's plain double-quoted string literal supports code interpolation
// (that needs an explicit `$"…"` / an `f"…"` prefix, never used here for a
// splice), so JSON's escaping (`"`, `\`, control chars) is already correct,
// complete target syntax — the same rule stated on the seam in
// `_expr/target.ts`'s `escapeStringLiteral` doc.
// ---------------------------------------------------------------------------

const SAFE_TARGET_DIRS: ReadonlyArray<{ prefix: string; reason: string }> = [
  {
    prefix: "src/generator/dotnet/",
    reason:
      "C# double-quoted string literals don't interpolate; JSON.stringify's escaping is correct C# syntax.",
  },
  {
    prefix: "src/generator/java/",
    reason:
      "Java double-quoted string literals don't interpolate; JSON.stringify's escaping is correct Java syntax.",
  },
  {
    prefix: "src/generator/python/",
    reason:
      "Python double-quoted string literals don't interpolate (that needs an f\"…\" prefix, never used for a splice); JSON.stringify's escaping is correct Python syntax.",
  },
];

function safeTargetDirFor(file: string): { prefix: string; reason: string } | undefined {
  return SAFE_TARGET_DIRS.find((d) => file.startsWith(d.prefix));
}

// ---------------------------------------------------------------------------
// Bucket 3 — the DANGER bucket: Elixir (`#{` interpolation, `~r/…/` sigil
// termination), Feliz F# / Flutter Dart (Dart interpolates bare `$`), and the
// `_walker`/`_expr` files shared across every target including those two.
// ---------------------------------------------------------------------------

/** Calls into a function this packet's review has confirmed NEVER returns
 *  raw `.ddd`-authored free text — a naming-normalizer re-casing an
 *  ID-terminal name (`src/util/naming.ts`), or a small set of
 *  message/title BUILDERS that hash or map their input to a stable,
 *  bounded output before it reaches `JSON.stringify`:
 *    - `messageCode(text)` → `msg.<hash>` (src/util/message-code.ts) — a
 *      content hash, never the text itself.
 *    - `problemTitle(status)` / `disallowedMessage(agg, op)` — fixed
 *      strings built from a closed httpStatus / compiler-name vocabulary
 *      (Wave 1 hand-off's own "compiler-built strings" group).
 *    - `storageKey(store)` — a store's own compiler-derived key.
 *    - `fillHoles(english, values)` — `english` is TOOLCHAIN-AUTHORED fixed
 *      chrome text (`i18n-chrome.ts`'s `CHROME_MESSAGES` catalog, never
 *      `.ddd`-authored), and only QUOTED-literal (compiler-derived) values
 *      substitute into its `{hole}`s (see the function's own doc).
 *  A CALL to one of these is trusted regardless of what expression sits
 *  INSIDE its own arguments — the function's return value is what actually
 *  reaches `JSON.stringify`. */
const SAFE_TRANSFORM_CALL =
  /^(snake|camel|pascal|plural|upperFirst|lowerFirst|humanize|escapeElixirIdent|messageCode|problemTitle|disallowedMessage|storageKey|fillHoles)\(/;

/** Identifier names known (by this packet's review) to sometimes carry a raw
 *  `.ddd`-authored FREE STRING — any argument referencing one of these as a
 *  whole word must be individually reviewed and waived, never auto-passed by
 *  the generic identifier pattern below. */
const RISKY_TOKENS = new Set([
  "message",
  "english",
  "detail",
  "body",
  "reason",
  "title",
  "label",
  "placeholder",
  "description",
  "summary",
  "content",
  "prompt",
  "comment",
]);

function containsRiskyToken(arg: string): boolean {
  const tokens = arg.match(/[A-Za-z_$][\w$]*/g) ?? [];
  return tokens.some((t) => RISKY_TOKENS.has(t));
}

/** A compiler-controlled expression: identifiers, member/optional-chain
 *  access, array indices, calls, ternaries, nullish-coalescing, template
 *  literals — built ENTIRELY from grammar `ID`-terminal names (aggregate /
 *  field / event / workflow / param / capability names, route templates,
 *  dataset ids, env var names, wire tags, …), which can never carry `#{`,
 *  `$`, or a stray `"` (`docs/language.md`'s `ID` terminal is
 *  `[_a-zA-Z][\w_]*`). SAFE unless it references one of `RISKY_TOKENS`. */
function isSafeCompilerExpr(arg: string): boolean {
  if (arg.length === 0) return false;
  if (SAFE_TRANSFORM_CALL.test(arg)) return true;
  return !containsRiskyToken(arg);
}

/** A NUMBER-terminal literal amount feeding `Decimal.new(...)` — digits,
 *  `.`, `-` only per the grammar's `NUMBER` terminal, so it can never carry
 *  `#{`/`$`. Detected by the enclosing source line wrapping this exact
 *  `JSON.stringify(...)` in `Decimal.new(...)`. */
function isDecimalNewArg(site: CallSite, fullLine: string): boolean {
  return fullLine.includes(`Decimal.new(\${JSON.stringify(${site.arg})`);
}

/** `_expr/subtree-like.ts` builds the five-language hierarchical-tenancy
 *  LIKE prefilter (M-T3.17) — every `JSON.stringify` there wraps either a
 *  fixed internal constant or one escapable char (never `.ddd`-authored
 *  text). One file, one reviewed shape. */
const SUBTREE_LIKE_SAFE_ARGS = new Set([
  "SUBTREE_LIKE_SUFFIX",
  "from",
  "to",
  "ch",
  "DATA_KEY_LIKE_ESCAPE + ch",
  "`${DATA_KEY_LIKE_ESCAPE}$&`",
]);

function isSubtreeLikeSafe(site: CallSite): boolean {
  return (
    site.file === "src/generator/_expr/subtree-like.ts" && SUBTREE_LIKE_SAFE_ARGS.has(site.arg)
  );
}

/** `_walker/i18n-emit.ts` / `primitives/layout.ts` / `primitives/table.ts`
 *  already route the AUTHOR string through the funnel FIRST —
 *  `ctx.target.renderStringLiteral?.(text) ?? JSON.stringify(text)` — so
 *  `JSON.stringify` is reached only as the JS-FAMILY fallback arm (the four
 *  JSX-family targets have no `renderStringLiteral` override; Feliz/Flutter
 *  DO implement it, so the left side always wins for them — see
 *  `_walker/target.ts`'s doc on the seam). */
function isRenderStringLiteralFallback(fullLine: string): boolean {
  return fullLine.includes("renderStringLiteral?.(") && fullLine.includes("?? JSON.stringify(");
}

/** Individual, file+arg-KEYED waivers for danger-bucket sites that don't fit
 *  a general pattern above — each reviewed by hand for this packet (Wave 2
 *  packet 2.2). Keyed by `${file}#${arg}` so a waiver survives incidental
 *  line-number churn but goes stale (and fails the ratchet check below) the
 *  moment its exact argument expression is no longer spliced raw.
 *
 *  This list is SHORT on purpose: the bulk of the 200+ danger-bucket sites
 *  this packet reviewed by hand (elixir field/event/route/dataset/schema
 *  names, F#/Dart identifier splices, the `_walker`/`_expr` shared-file
 *  sites) are covered by the general `isSafeCompilerExpr` pattern above —
 *  every one of them turned out to be a compiler-controlled `ID`-terminal
 *  name, a trusted transform call, or an internal constant, confirmed by
 *  reading each call site (Wave 1 hand-off's own taxonomy: ID-terminal
 *  names; compiler-built strings; NUMBER-terminal digits under
 *  `Decimal.new`; compiler-rendered SQL/Ecto fragments; one internal-only
 *  string never emitted). Only the sites below reference one of the small
 *  `RISKY_TOKENS` set, or defeat the single-line scanner outright. */
const DANGER_WAIVERS: ReadonlyArray<{ file: string; arg: string; reason: string }> = [
  {
    file: "src/generator/_walker/i18n-emit.ts",
    arg: "message",
    reason:
      "translateExpr's fallback: reached only when ctx.target.renderTranslate is undefined (the four JS-family targets — Feliz/Flutter override it and never reach this line, per _walker/target.ts's renderTranslate doc). `message` is the i18n-off ENGLISH SOURCE text, which IS the .ddd-authored default for a JS-family t() call — JSON.stringify is the correct JS string-literal rule there.",
  },
  {
    file: "src/generator/_walker/form-fields-vm.ts",
    arg: "`<id> — ${reason}`",
    reason:
      "`reason` is a fixed, developer-authored diagnostic string built from a compiler identifier (inner.targetName) — never `.ddd`-authored text.",
  },
  {
    file: "src/generator/elixir/vanilla/find-controller.ts",
    arg: "absent.title",
    reason:
      "An RFC7807 `title` resolved through the fixed status→title map (problemTitle/errorTitle), never free author text.",
  },
  {
    file: "src/generator/elixir/vanilla/operation-returns-emit.ts",
    arg: "v.title",
    reason:
      "An RFC7807 `title` resolved through the fixed status→title map (problemTitle/errorTitle), never free author text.",
  },
  // --- Two call sites split across lines (a multi-line `JSON.stringify(`
  //     argument) — the single-line scanner above extracts an EMPTY string
  //     for these, not the real argument. Both were reviewed directly. ---
  {
    file: "src/generator/elixir/vanilla/denial.ts",
    arg: "",
    reason:
      "Multi-line call: JSON.stringify(denialTitle(rung, overrides)) — denialTitle resolves through a fixed status→title map (Wave 1 hand-off's problemTitle/disallowedMessage group), not free text. See denialResponse().",
  },
  {
    file: "src/generator/flutter/index.ts",
    arg: "",
    reason:
      "Multi-line call: renderWebManifest's PWA manifest.json object literal — a genuine JSON position, verified by the dedicated test below (this file's second `it`).",
  },
];

interface Classified {
  bucket: "js-family" | "safe-target" | "safe-pattern" | "waived" | "UNCLASSIFIED";
}

function classify(site: CallSite, fullLine: string): Classified {
  if (isJsFamily(site.file)) return { bucket: "js-family" };
  if (safeTargetDirFor(site.file)) return { bucket: "safe-target" };
  if (isDecimalNewArg(site, fullLine)) return { bucket: "safe-pattern" };
  if (isSubtreeLikeSafe(site)) return { bucket: "safe-pattern" };
  if (isRenderStringLiteralFallback(fullLine)) return { bucket: "safe-pattern" };
  if (isSafeCompilerExpr(site.arg)) return { bucket: "safe-pattern" };
  const waiver = DANGER_WAIVERS.find((w) => w.file === site.file && w.arg === site.arg);
  if (waiver) return { bucket: "waived" };
  return { bucket: "UNCLASSIFIED" };
}

describe("escape-funnel census (F2-ELX-ESCAPE-FUNNEL class)", () => {
  it("every generator JSON.stringify( site is a documented JS/safe-target position, a safe compiler-derived pattern, or an individually waived splice", () => {
    const sites = collectCallSites();
    expect(
      sites.length,
      "the census found zero JSON.stringify( sites — the scanner is broken",
    ).toBeGreaterThan(100);

    const byFile = new Map<string, string[]>();
    for (const site of sites) {
      if (!byFile.has(site.file)) {
        byFile.set(site.file, readFileSync(join(REPO_ROOT, site.file), "utf8").split("\n"));
      }
    }

    const failures: string[] = [];
    const usedWaivers = new Set<string>();
    for (const site of sites) {
      const fullLine = byFile.get(site.file)![site.line - 1] ?? "";
      const result = classify(site, fullLine);
      if (result.bucket === "waived") usedWaivers.add(`${site.file}#${site.arg}`);
      if (result.bucket === "UNCLASSIFIED") {
        failures.push(
          `${site.file}:${site.line}  JSON.stringify(${site.arg})  — not a JS-family/safe-target position, ` +
            `doesn't match a documented safe pattern, and has no waiver. Route it through the backend's escape ` +
            `funnel (elixirString/fsString/dartString — or ExprTarget.escapeStringLiteral) or add a DANGER_WAIVERS ` +
            `entry with a reviewed reason.`,
        );
      }
    }
    expect(
      failures,
      `${failures.length} unclassified danger-bucket splice(s):\n${failures.join("\n")}`,
    ).toEqual([]);

    const staleWaivers = DANGER_WAIVERS.filter((w) => !usedWaivers.has(`${w.file}#${w.arg}`));
    expect(
      staleWaivers.map((w) => `${w.file}#${w.arg}`),
      "stale waiver(s) matching no current call site — delete them (CLAUDE.md: waivers ratchet)",
    ).toEqual([]);
  });

  it("the flutter web-manifest JSON.stringify( site is genuinely a JSON position (multi-line, checked separately — the scanner above can't extract its argument)", () => {
    const src = readFileSync(join(REPO_ROOT, "src/generator/flutter/index.ts"), "utf8");
    expect(src).toContain("function renderWebManifest(");
    const idx = src.indexOf("function renderWebManifest(");
    const body = src.slice(idx, idx + 400);
    expect(body).toContain("JSON.stringify(");
    expect(body).toContain("short_name: title");
  });
});
