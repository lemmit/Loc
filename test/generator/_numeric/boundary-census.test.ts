import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// M-T9.36 boundary-enumeration census.
//
// The numeric wire-codec decision (money = RS-12 fixed-scale string, decimal
// = RS-24 float64, int/long = integer) now lives ONCE per backend, in that
// backend's `numeric-codec.ts` leaf table (`src/generator/_numeric/target.ts`
// defines the shared contract).  This census is the gate that makes it STAY
// that way: every RAW numeric-coercion literal this refactor extracted — the
// exact source-text signatures below, one set per backend, gathered by
// grepping the fenced trees for every occurrence BEFORE and AFTER the
// refactor — must appear ONLY inside that backend's `numeric-codec.ts` (or
// the shared `_numeric/**`).  A new read path that hand-rolls
// `.toFixed(...)` / `ToString("F...")` / `.setScale(...)` / `money_str(...)`
// / `Decimal.round(...)` instead of calling `numericEncode(...)` fails this
// test, naming the file:line.
//
// Signatures are chosen NARROWLY on purpose — precise enough that a
// non-boundary use (the `_expr/target.ts` money-literal/arithmetic leaf
// tables, a workflow's zero-value seed, a LiveView display helper) needs an
// explicit, reasoned WAIVER rather than being silently swallowed by an
// overbroad pattern.  Waivers ratchet: `mustStillMatch` below asserts every
// waived line is still THERE and still the reason it was waived for — delete
// the waiver in the same change that deletes or rewrites the line.
// ---------------------------------------------------------------------------

interface Signature {
  pattern: RegExp;
  label: string;
}

interface Waiver {
  file: string;
  contains: string;
  reason: string;
}

interface BackendCensus {
  name: string;
  /** Fenced source directories (relative to repo root), walked recursively. */
  dirs: string[];
  /** Basenames exempt entirely — the seam's own leaf-table file(s). */
  codecBasenames: string[];
  signatures: Signature[];
  waivers: Waiver[];
}

const REPO_ROOT = join(__dirname, "..", "..", "..");

function listTsFiles(dir: string): string[] {
  const abs = join(REPO_ROOT, dir);
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (entry === "node_modules") continue;
        walk(p);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        out.push(p);
      }
    }
  };
  walk(abs);
  return out;
}

/** True when `line` is a comment line in this codebase's TSDoc style — a
 *  trimmed line starting `//`, `*`, or `/*`.  Documentation that MENTIONS a
 *  signature (`` `.toFixed(4)` ``, in a doc comment explaining the seam) is
 *  not a violation; only real code is. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

const BACKENDS: BackendCensus[] = [
  {
    name: "typescript/hono",
    dirs: ["src/generator/typescript", "src/platform/hono"],
    codecBasenames: ["numeric-codec.ts"],
    signatures: [
      { pattern: /\.toFixed\(/, label: "bare .toFixed( money-scale format" },
      { pattern: /new Decimal\(/, label: "bare new Decimal( construction" },
    ],
    waivers: [
      {
        file: "src/generator/typescript/render-expr.ts",
        contains: "return `new Decimal(${v})`;",
        reason:
          "ExprTarget money-literal constructor (_expr/target.ts's leaf domain), not a read boundary",
      },
      {
        file: "src/generator/typescript/render-expr.ts",
        contains: 'if (lit === "money") return `new Decimal(${JSON.stringify(value)})`;',
        reason: "ExprTarget money-literal constructor, not a read boundary",
      },
      {
        file: "src/generator/typescript/render-expr.ts",
        contains: "acc.plus((${args[0]})(x)), new Decimal(0))",
        reason: "ExprTarget sum-fold zero seed, not a read boundary",
      },
      {
        file: "src/generator/typescript/render-expr.ts",
        contains: "acc.plus(x), new Decimal(0))",
        reason: "ExprTarget sum-fold zero seed, not a read boundary",
      },
      {
        file: "src/generator/typescript/render-expr.ts",
        contains: "renderMoneyBinary(e.op, `new Decimal(${left})`, right);",
        reason: "ExprTarget money-arithmetic operand widening, not a read boundary",
      },
      {
        file: "src/platform/hono/v4/workflow-eventsourced-builder.ts",
        contains: 'return "new Decimal(0)";',
        reason: "workflow saga-state zero-default construction, not a read boundary",
      },
      {
        file: "src/platform/hono/v4/projection-builder.ts",
        contains: "new Decimal(${cur} ?? 0).${verb}(${value}).toString()",
        reason:
          "projection-state ACCUMULATE (read-modify-WRITE of persisted state) — not one of the five read boundaries; handed off, see docs/new-plan/waves/handoffs/wave-2-numeric-codec.md",
      },
    ],
  },
  {
    name: "dotnet",
    dirs: ["src/generator/dotnet"],
    codecBasenames: ["numeric-codec.ts"],
    signatures: [
      { pattern: /ToString\("F\d/, label: 'bare .ToString("F<n>"...) money-scale format' },
      { pattern: /double\.Parse\(/, label: "bare double.Parse( decimal narrowing" },
    ],
    waivers: [],
  },
  {
    name: "java",
    dirs: ["src/generator/java"],
    codecBasenames: ["numeric-codec.ts"],
    signatures: [
      { pattern: /\.setScale\(/, label: "bare .setScale( money-scale format" },
      { pattern: /\.toPlainString\(\)/, label: "bare .toPlainString() money wire format" },
      { pattern: /\.doubleValue\(\)/, label: "bare .doubleValue() decimal narrowing" },
      { pattern: /new BigDecimal\(/, label: "bare new BigDecimal( construction" },
    ],
    waivers: [
      {
        file: "src/generator/java/render-expr.ts",
        contains: '`${recv}.setScale(${args[0] ?? "0"}, java.math.RoundingMode.HALF_UP)`,',
        reason:
          "ExprTarget decimal/money .round() stdlib intrinsic (user-invoked DSL operation), not a read boundary",
      },
      {
        file: "src/generator/java/render-expr.ts",
        contains: '"decimal.floor": (recv) => `${recv}.setScale(0, java.math.RoundingMode.FLOOR)`,',
        reason: "ExprTarget decimal.floor() stdlib intrinsic, not a read boundary",
      },
      {
        file: "src/generator/java/render-expr.ts",
        contains: '"money.floor": (recv) => `${recv}.setScale(0, java.math.RoundingMode.FLOOR)`,',
        reason: "ExprTarget money.floor() stdlib intrinsic, not a read boundary",
      },
      {
        file: "src/generator/java/render-expr.ts",
        contains:
          '"decimal.ceil": (recv) => `${recv}.setScale(0, java.math.RoundingMode.CEILING)`,',
        reason: "ExprTarget decimal.ceil() stdlib intrinsic, not a read boundary",
      },
      {
        file: "src/generator/java/render-expr.ts",
        contains: '"money.ceil": (recv) => `${recv}.setScale(0, java.math.RoundingMode.CEILING)`,',
        reason: "ExprTarget money.ceil() stdlib intrinsic, not a read boundary",
      },
      {
        file: "src/generator/java/render-expr.ts",
        contains: 'if (from === "decimal" || from === "money") return `${v}.toPlainString()`;',
        reason: "ExprTarget string(decimal|money) convert intrinsic, not a read boundary",
      },
      {
        file: "src/generator/java/render-expr.ts",
        contains: 'if (lit === "decimal" || lit === "money") return `new BigDecimal("${value}")`;',
        reason: "ExprTarget decimal/money LITERAL constructor, not a read boundary",
      },
    ],
  },
  {
    name: "python",
    dirs: ["src/generator/python"],
    codecBasenames: ["numeric-codec.ts"],
    signatures: [
      { pattern: /money_str\(/, label: "money_str(...) call" },
      { pattern: /Decimal\(cast\(/, label: "Decimal(cast(...)) money decode" },
      { pattern: /float\(cast\(/, label: "float(cast(...)) decimal decode" },
    ],
    waivers: [
      {
        file: "src/generator/python/index.ts",
        contains: "def money_str(amount: Decimal) -> str:",
        reason:
          "the RUNTIME helper's own definition (emitted once into every generated project's wire.py) — the thing every other site now calls, not a call site itself",
      },
    ],
  },
  {
    name: "elixir",
    dirs: ["src/generator/elixir"],
    codecBasenames: ["numeric-codec.ts"],
    signatures: [
      { pattern: /Decimal\.round\(/, label: "bare Decimal.round( money-scale format" },
      { pattern: /Decimal\.to_float\(/, label: "bare Decimal.to_float( decimal narrowing" },
    ],
    waivers: [
      {
        file: "src/generator/elixir/render-expr.ts",
        contains: "Decimal.to_integer(Decimal.round(${v}, 0, :down))",
        reason: "ExprTarget int-convert intrinsic, not a read boundary",
      },
      {
        file: "src/generator/elixir/render-expr.ts",
        contains:
          '"decimal.round": (recv, args) => `Decimal.round(${recv}, ${args[0] ?? "0"}, :half_up)`,',
        reason:
          "ExprTarget decimal.round() stdlib intrinsic (user-invoked DSL operation), not a read boundary",
      },
      {
        file: "src/generator/elixir/render-expr.ts",
        contains:
          '"money.round": (recv, args) => `Decimal.round(${recv}, ${args[0] ?? "0"}, :half_up)`,',
        reason: "ExprTarget money.round() stdlib intrinsic, not a read boundary",
      },
      {
        file: "src/generator/elixir/render-expr.ts",
        contains: '"decimal.floor": (recv) => `Decimal.round(${recv}, 0, :floor)`,',
        reason: "ExprTarget decimal.floor() stdlib intrinsic, not a read boundary",
      },
      {
        file: "src/generator/elixir/render-expr.ts",
        contains: '"money.floor": (recv) => `Decimal.round(${recv}, 0, :floor)`,',
        reason: "ExprTarget money.floor() stdlib intrinsic, not a read boundary",
      },
      {
        file: "src/generator/elixir/render-expr.ts",
        contains: '"decimal.ceil": (recv) => `Decimal.round(${recv}, 0, :ceiling)`,',
        reason: "ExprTarget decimal.ceil() stdlib intrinsic, not a read boundary",
      },
      {
        file: "src/generator/elixir/render-expr.ts",
        contains: '"money.ceil": (recv) => `Decimal.round(${recv}, 0, :ceiling)`,',
        reason: "ExprTarget money.ceil() stdlib intrinsic, not a read boundary",
      },
      {
        file: "src/generator/elixir/heex-walker-core.ts",
        contains: "Decimal.to_integer(Decimal.round(${v}, 0, :down))",
        reason:
          "HEEx walker's int-convert intrinsic (parallels render-expr.ts), not a read boundary",
      },
      {
        file: "src/generator/elixir/liveview-emit.ts",
        contains: "defp number_of(%Decimal{} = v), do: Decimal.to_float(v)",
        reason:
          "LiveView template DISPLAY helper (HTML rendering) — not a wire boundary; the S6/M-T1.25 display-formatting class, out of M-T9.36's scope",
      },
    ],
  },
];

interface Violation {
  file: string;
  line: number;
  text: string;
  label: string;
}

function censusViolations(b: BackendCensus): Violation[] {
  const violations: Violation[] = [];
  for (const dir of b.dirs) {
    for (const abs of listTsFiles(dir)) {
      const rel = relative(REPO_ROOT, abs).replace(/\\/g, "/");
      const base = rel.split("/").pop()!;
      if (b.codecBasenames.includes(base)) continue;
      const content = readFileSync(abs, "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (isCommentLine(line)) continue;
        for (const sig of b.signatures) {
          if (!sig.pattern.test(line)) continue;
          const waived = b.waivers.some((w) => w.file === rel && line.includes(w.contains));
          if (waived) continue;
          violations.push({ file: rel, line: i + 1, text: line.trim(), label: sig.label });
        }
      }
    }
  }
  return violations;
}

describe("M-T9.36 numeric-codec boundary census", () => {
  for (const b of BACKENDS) {
    it(`${b.name}: every numeric-coercion signature lives only in numeric-codec.ts`, () => {
      const violations = censusViolations(b);
      if (violations.length > 0) {
        const msg = violations
          .map((v) => `  ${v.file}:${v.line} — ${v.label}\n    ${v.text}`)
          .join("\n");
        expect.fail(
          `${violations.length} raw numeric-coercion literal(s) outside the ${b.name} numeric codec seam:\n${msg}\n` +
            `Route each through numericEncode(...) from the backend's numeric-codec.ts, ` +
            `or add a reasoned waiver if it is genuinely not a read boundary.`,
        );
      }
    });
  }

  it("every waiver still matches its exact waived line (waivers ratchet — no stale entries)", () => {
    const stale: string[] = [];
    for (const b of BACKENDS) {
      for (const w of b.waivers) {
        const abs = join(REPO_ROOT, w.file);
        const content = readFileSync(abs, "utf8");
        if (!content.includes(w.contains)) {
          stale.push(`${b.name}: ${w.file} no longer contains: ${w.contains}`);
        }
      }
    }
    expect(stale, stale.join("\n")).toEqual([]);
  });
});
