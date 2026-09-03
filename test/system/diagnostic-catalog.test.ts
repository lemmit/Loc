import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  codeOfMessageKey,
  DIAGNOSTIC_MESSAGES,
  type DiagnosticMessageKey,
} from "../../src/diagnostics/messages.js";

// ---------------------------------------------------------------------------
// The validator diagnostic-message catalog is the SINGLE HOME for the wording
// of every `loom.*` diagnostic (M-T1.11).  Codes were always stable; the
// strings used to be inline literals across ~50 files, so the diagnostic
// surface could not be enumerated, reviewed, or translated.
//
// This is the ratchet that keeps it that way.  Three invariants, each of which
// FAILS when a single call site regresses (mutation-proved in the PR):
//
//   1. No inline wording — a diagnostic site that attaches a `loom.*` code
//      must take its message from `diagMessage(...)`.
//   2. Key ⇒ code agreement — the catalog key a site renders must belong to
//      the code that same site attaches (`codeOfMessageKey`).  This is the one
//      a copy-pasted call site actually gets wrong.
//   3. No orphans — every catalog entry is reachable from a call site, so a
//      deleted check takes its wording with it.
//
// A fourth invariant guards the SCANNER, not the catalog:
//
//   4. No dynamic `code:` — a site may not compute its code out of a template
//      literal (`` code: `loom.${d.platform}-…` ``).  Such a site used to be
//      SKIPPED, because the scanner only recorded a string-literal code — so it
//      kept inline wording invisibly.  That is how the four
//      `*-deployable-missing-ui` codes escaped all three invariants above (and
//      the same hole, in its `code: backend.code` shape, is recorded in
//      M-T9.27).  A template code is now constant-folded where that is possible
//      and FAILS loudly where it is not.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The diagnostic surface the catalog owns — every phase that raises a `loom.*`
 *  code the user can see: macro expansion (②), the AST validators (④), the IR
 *  check leaves (⑦), and the toolkit entry points that report a phase failure. */
function catalogedSources(): string[] {
  const out: string[] = [];
  for (const dir of [
    path.join("src", "language", "validators"),
    path.join("src", "ir", "validate", "checks"),
  ]) {
    for (const f of fs.readdirSync(path.join(repoRoot, dir)).sort()) {
      if (f.endsWith(".ts")) out.push(path.join(dir, f));
    }
  }
  out.push(path.join("src", "language", "ddd-validator.ts"));
  out.push(path.join("src", "macros", "expander.ts"));
  out.push(path.join("src", "api", "evolve.ts"));
  out.push(path.join("src", "api", "index.ts"));
  // QueryEmissionRefusal (§F2, Wave 2 packet 2.4) is a generation-time
  // (phase ⑧) diagnostic raised inside a query-language renderer, not a
  // validate-phase (④/⑦) check — its `loom.query-emission-invalid` message
  // lives in the catalog like every other coded diagnostic, so its one
  // `diagMessage(...)` call site is scanned here too (the object-literal /
  // Langium `accept()` shapes `sitesIn` looks for don't match a thrown
  // `Error`, so this only satisfies the orphan check, not the other three
  // invariants — appropriate, since this is a defensive backstop the IR
  // validator is meant to make unreachable, not a validator call site).
  out.push(path.join("src", "generator", "_expr", "target.ts"));
  return out;
}

interface Site {
  file: string;
  line: number;
  /** The `loom.*` code the site attaches. */
  code: string;
  /** The message argument, as source text. */
  message: ts.Expression;
  sf: ts.SourceFile;
}

/** True when the message is just a parameter of the enclosing function — a
 *  FORWARDING HELPER (`loweringDiag(message)` in `src/api/evolve.ts`), whose
 *  wording lives at its own call sites and is catalogued there.  Nothing is
 *  hard-coded at such a site, so there is nothing for the ratchet to catch. */
function isForwardedParam(message: ts.Expression, sf: ts.SourceFile): boolean {
  if (!ts.isIdentifier(message)) return false;
  for (let n: ts.Node | undefined = message.parent; n; n = n.parent) {
    if (!ts.isFunctionLike(n)) continue;
    return n.parameters.some((p) => p.name.getText(sf) === message.text);
  }
  return false;
}

/** A `code:` the scanner recognises as a `loom.*` code but cannot resolve to a
 *  static string — a template literal with a non-constant substitution.  Such a
 *  site is reported, never skipped: skipping it is what let the four
 *  `*-deployable-missing-ui` codes keep inline wording. */
interface DynamicCodeSite {
  file: string;
  line: number;
  /** The `code:` expression as source text. */
  text: string;
}

/** A `code:` expression the scanner has only recently begun to see (template
 *  literals — see invariant 4) whose wording has not been moved into the catalog
 *  yet.  RATCHETING: every entry must still match a live site, so a fix deletes
 *  its waiver in the same change; and a NEW dynamic/uncatalogued template code
 *  fails the gate rather than joining the list silently.
 *
 *  `code` is the exact source text of the `code:` expression, so the entries
 *  survive line drift. */
const TEMPLATE_CODE_DEBT: { file: string; code: string; why: string }[] = [
  {
    file: path.join("src", "language", "validators", "structural.ts"),
    code: "`loom.derived-${m.name}-not-string`",
    why: "reserved-derived typing: two codes (display/inspect) behind one computed code; wording not catalogued.",
  },
  {
    file: path.join("src", "language", "validators", "structural.ts"),
    code: "`loom.canonical-${kind}-conflict`",
    why: "lifecycle conflicts: two codes (create/destroy) behind one computed code; wording not catalogued.",
  },
  {
    file: path.join("src", "language", "validators", "structural.ts"),
    code: "`loom.${kind}-name-conflict`",
    why: "lifecycle conflicts: two codes (create/destroy) behind one computed code; wording not catalogued.",
  },
];

const isWaived = (file: string, codeText: string): boolean =>
  TEMPLATE_CODE_DEBT.some((w) => w.file === file && w.code === codeText);

/** The `loom.*` code a `code:` expression attaches, resolved statically.
 *
 *    - a string literal, or a substitution-free template literal → that string;
 *    - a template literal whose substitutions are all string literals → the
 *      folded string (the only case a set of possible codes is statically
 *      enumerable without type information);
 *    - any other template literal → `"dynamic"`, which FAILS invariant 4;
 *    - anything else (an identifier / property access — the diagnostic-forwarding
 *      sites in `validators/macros.ts`, which hard-code no wording of their own)
 *      → `undefined`, i.e. not a site this scanner can speak about. */
function resolveCode(codeNode: ts.Expression): string | "dynamic" | undefined {
  if (ts.isStringLiteralLike(codeNode)) {
    return codeNode.text.startsWith("loom.") ? codeNode.text : undefined;
  }
  if (!ts.isTemplateExpression(codeNode)) return undefined;
  let folded = codeNode.head.text;
  let isStatic = true;
  for (const span of codeNode.templateSpans) {
    if (ts.isStringLiteralLike(span.expression)) folded += span.expression.text;
    else isStatic = false;
    folded += span.literal.text;
  }
  if (isStatic) return folded.startsWith("loom.") ? folded : undefined;
  // A non-constant substitution.  Treat any template `code:` at a diagnostic
  // site as a loom code even when the static head does not start with `loom.`
  // (`` `${prefix}-conflict` `` must not be able to hide either).
  return "dynamic";
}

/** Every diagnostic construction site carrying a statically-resolvable `loom.*`
 *  code — both shapes: Langium's `accept(sev, msg, { …, code })` and the IR
 *  checks' / macro expander's `{ severity, message, code, … }` object literal.
 *  Sites whose code is dynamic land in `dynamic` instead. */
function sitesIn(file: string): { sites: Site[]; dynamic: DynamicCodeSite[] } {
  const src = fs.readFileSync(path.join(repoRoot, file), "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true);
  const out: Site[] = [];
  const dynamic: DynamicCodeSite[] = [];
  const push = (message: ts.Expression, codeNode: ts.Expression): void => {
    const resolved = resolveCode(codeNode);
    if (resolved === undefined) return;
    const codeText = codeNode.getText(sf);
    if (isWaived(file, codeText)) return;
    if (resolved === "dynamic") {
      dynamic.push({
        file,
        line: sf.getLineAndCharacterOfPosition(codeNode.getStart(sf)).line + 1,
        text: codeText.replace(/\s+/g, " "),
      });
      return;
    }
    if (isForwardedParam(message, sf)) return;
    out.push({
      file,
      line: sf.getLineAndCharacterOfPosition(message.getStart(sf)).line + 1,
      code: resolved,
      message,
      sf,
    });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && /(^|\.)accept$/.test(n.expression.getText(sf))) {
      const opts = n.arguments[2];
      if (n.arguments.length >= 3 && opts && ts.isObjectLiteralExpression(opts)) {
        const code = opts.properties.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) && p.name.getText(sf) === "code",
        );
        if (code) push(n.arguments[1]!, code.initializer);
      }
    }
    if (ts.isObjectLiteralExpression(n)) {
      const props = new Map<string, ts.Expression>();
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p)) props.set(p.name.getText(sf), p.initializer);
      }
      const message = props.get("message");
      const code = props.get("code");
      if (props.has("severity") && message && code) push(message, code);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { sites: out, dynamic };
}

const SCANNED = catalogedSources().map(sitesIn);
const ALL_SITES = SCANNED.flatMap((s) => s.sites);
const ALL_DYNAMIC = SCANNED.flatMap((s) => s.dynamic);

/** The catalog key a site renders, or `undefined` when it does not go through
 *  the catalog at all. */
function keyOf(site: Site): string | undefined {
  const m = site.message;
  if (!ts.isCallExpression(m)) return undefined;
  if (m.expression.getText(site.sf) !== "diagMessage") return undefined;
  const arg = m.arguments[0];
  return arg && ts.isStringLiteral(arg) ? arg.text : undefined;
}

const where = (s: Site): string => `${s.file}:${s.line} (${s.code})`;

describe("validator diagnostic-message catalog", () => {
  it("covers the whole validator surface", () => {
    // Guards the scanner itself: if the AST shapes above ever stop matching,
    // the invariants below would pass vacuously.
    expect(ALL_SITES.length).toBeGreaterThan(400);
  });

  it("has no dynamic `code:` — a computed code cannot hide a site from the ratchet", () => {
    const offenders = ALL_DYNAMIC.map((d) => `${d.file}:${d.line} → ${d.text}`);
    expect(
      offenders,
      "A diagnostic site must attach a string-literal `code:`. A computed code " +
        "(`loom.${x}-…`) is invisible to the catalog ratchet, so the site keeps " +
        "inline wording unnoticed. Spell out one site per code — see " +
        "SPA_MISSING_UI in src/language/validators/deployable.ts for the shape.",
    ).toEqual([]);
  });

  it("waives no template code that has since been fixed", () => {
    // The debt list ratchets: an entry that no longer matches a live site is
    // stale and must be deleted, so a fix cannot leave its waiver behind.
    const live = new Set<string>();
    for (const file of catalogedSources()) {
      const sf = ts.createSourceFile(
        file,
        fs.readFileSync(path.join(repoRoot, file), "utf8"),
        ts.ScriptTarget.ESNext,
        true,
      );
      const visit = (n: ts.Node): void => {
        if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "code") {
          live.add(`${file} ${n.initializer.getText(sf)}`);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    const stale = TEMPLATE_CODE_DEBT.filter((w) => !live.has(`${w.file} ${w.code}`)).map(
      (w) => `${w.file} → ${w.code}`,
    );
    expect(stale, "stale TEMPLATE_CODE_DEBT entry — delete it").toEqual([]);
  });

  it("has no inline wording — every coded diagnostic renders from the catalog", () => {
    const inline = ALL_SITES.filter((s) => keyOf(s) === undefined).map(where);
    expect(inline).toEqual([]);
  });

  it("renders a key that belongs to the code the site attaches", () => {
    const mismatched: string[] = [];
    for (const s of ALL_SITES) {
      const key = keyOf(s);
      if (key === undefined) continue;
      if (!(key in DIAGNOSTIC_MESSAGES)) mismatched.push(`${where(s)} → unknown key '${key}'`);
      else if (codeOfMessageKey(key as DiagnosticMessageKey) !== s.code) {
        mismatched.push(`${where(s)} → key '${key}' belongs to a different code`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("has no orphan entries", () => {
    // Every `diagMessage("…")` anywhere in the cataloged sources — not just the
    // code-carrying sites — because a key can legitimately be rendered one hop
    // away from its `code:` (the forwarding helpers above).
    const used = new Set<string>();
    for (const file of catalogedSources()) {
      const sf = ts.createSourceFile(
        file,
        fs.readFileSync(path.join(repoRoot, file), "utf8"),
        ts.ScriptTarget.ESNext,
        true,
      );
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && n.expression.getText(sf) === "diagMessage") {
          const arg = n.arguments[0];
          if (arg && ts.isStringLiteral(arg)) used.add(arg.text);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    const orphans = Object.keys(DIAGNOSTIC_MESSAGES).filter((k) => !used.has(k));
    expect(orphans).toEqual([]);
  });

  it("keys are a `loom.*` code, optionally `#<slug>`-qualified", () => {
    const bad = Object.keys(DIAGNOSTIC_MESSAGES).filter(
      (k) => !/^loom\.[a-z0-9]+(-[a-z0-9]+)*(#[a-z0-9]+(-[a-z0-9]+)*)?$/.test(k),
    );
    expect(bad).toEqual([]);
  });

  it("renders every entry — no catalog entry throws or comes out blank", () => {
    // Params are `unknown`, so a Proxy standing in for the params object
    // exercises each builder without needing per-entry fixtures.
    const anyParams = new Proxy({}, { get: (_t, prop) => `<${String(prop)}>` });
    for (const [key, entry] of Object.entries(DIAGNOSTIC_MESSAGES)) {
      const text = typeof entry === "string" ? entry : (entry as (p: unknown) => string)(anyParams);
      expect(text.trim(), key).not.toBe("");
    }
  });

  // F2-FFE-9 — the CLI prints `${d.code} ${d.source}: ${d.message}`
  // (src/cli/main.ts), and the UI / store / frontend checks pass the SAME
  // human-readable location as both the diagnostic's `source` and the
  // message's `where` param.  An entry that also LEADS with `${p.where}:`
  // therefore prints the location twice:
  //
  //   loom.sub-primitive-misplaced page 'Home': page 'Home': `Tab` is a …
  //   loom.…                       component 'TabbyTop': component 'TabbyTop': …
  //
  // The location belongs to `source`; the message says what is wrong.  This
  // pins the whole class rather than the two codes that were noticed — a new
  // check that copy-pastes the `${p.where}: ` lead fails here.
  //
  // Entries that weave `where` into a SENTENCE (`${p.where} uses a
  // discriminated union…`) are fine and unaffected: only a bare
  // `<where>:`/`<where> action …:` LEAD is a duplicated prefix.
  // The `loom.domain-service-*` body gates are the ONE family whose `where`
  // is not its `source`: `source` is the path `Ctx/Svc.op` while `where` spells
  // the KIND out (`domainService 'Archiver' operation 'stash'`), so the lead
  // adds information rather than repeating the prefix.  A waiver ratchets — if
  // one of these is reworded or its call site starts passing `source: where`,
  // drop its row here in the same change.
  const WHERE_LEAD_NOT_A_DUPLICATE = new Set<string>([
    "loom.domain-service-no-emit",
    "loom.domain-service-no-mutation",
    "loom.domain-service-no-repo-write",
    "loom.domain-service-no-workflow-start",
    "loom.domain-service-infra-call-from-aggregate",
    "loom.domain-service-cross-context-read",
    "loom.domain-service-read-unsupported",
  ]);

  it("no entry leads with its `where` param — the CLI already prints `source`", () => {
    const anyParams = new Proxy({}, { get: (_t, prop) => `<${String(prop)}>` });
    const leading: string[] = [];
    for (const [key, entry] of Object.entries(DIAGNOSTIC_MESSAGES)) {
      if (typeof entry === "string" || WHERE_LEAD_NOT_A_DUPLICATE.has(key)) continue;
      const text = (entry as (p: unknown) => string)(anyParams);
      if (!text.startsWith("<where>")) continue;
      // The lead is a duplicated PREFIX when the `where` run is closed by a
      // colon before the sentence starts (`<where>: …`, `<where> action 'x': …`).
      const head = text.slice(0, text.indexOf(":") + 1);
      if (text.includes(":") && /^<where>[^:]{0,40}:$/.test(head)) leading.push(`${key} → ${head}`);
    }
    expect(leading).toEqual([]);
  });

  it("every waived `where` lead is still a real waiver (no stale rows)", () => {
    const anyParams = new Proxy({}, { get: (_t, prop) => `<${String(prop)}>` });
    const stale = [...WHERE_LEAD_NOT_A_DUPLICATE].filter((key) => {
      const entry = DIAGNOSTIC_MESSAGES[key as DiagnosticMessageKey];
      if (typeof entry !== "function") return true;
      return !(entry as (p: unknown) => string)(anyParams).startsWith("<where>");
    });
    expect(stale).toEqual([]);
  });
});
