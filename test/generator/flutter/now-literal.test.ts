// The `now()` literal on Flutter — it used to emit the bare word `now`.
//
// `now` is an `ExprIR` LITERAL kind whose `value` is the string "now", not a
// number.  `DART_LEAVES.literal` classified string/bool/null and then fell
// through to "numeric literal verbatim", so `now` came out as `now`: an
// unbound Dart identifier on BOTH flutter expression paths (the shared view
// walker via `flutterTarget.exprLiteral`, and the Riverpod `build()`/action
// path via `emitExpr`, which share the one leaf table).
//
// A Loom `datetime` is a Dart `DateTime` here, decoded off the wire with
// `DateTime.parse(...)` (`dart-types.ts`) and normalized with `.toUtc()`
// before any field read (`dart-expr.ts`'s `datetime.startOfDay`), so the
// current instant is `DateTime.now().toUtc()` — `DateTime.now()` alone is a
// LOCAL-time value.  Feliz renders `System.DateTime.UtcNow` for the same
// literal (`test/generator/feliz/now-literal.test.ts`).
//
// The second half of the defect is Dart-specific: the state seed is built by
// `buildStateInits`, whose `constEligible` treated EVERY `literal`-kind init as
// a compile-time constant.  `DateTime.now().toUtc()` is a runtime call, so the
// emitted `const SchedState(...)` would not compile ("Arguments of a constant
// creation must be constant expressions").

import { describe, expect, it } from "vitest";
import { DART_LEAVES, DART_NOW } from "../../../src/generator/flutter/dart-expr.js";
import { renderRiverpod } from "../../../src/generator/flutter/riverpod-emit.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { allContexts } from "../../../src/ir/types/loom-ir.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const sys = (page: string) => `
system Sched {
  subdomain S { context Shop {
    aggregate Product { name: string }
    repository Products for Product { }
  } }
  ui MobileApp {
    framework: flutter
    ${page}
  }
  api A from S
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: MobileApp port: 3006 }
}
`;

/** The Riverpod projection (`<Page>State` / `<Page>Notifier` / provider) for a page. */
async function riverpod(page: string): Promise<string> {
  const { model } = await parseString(sys(page), { validate: false });
  const enriched = enrichLoomModel(lowerModel(model));
  const p = enriched.systems[0]!.uis[0]!.pages.find((x) => x.name === "Sched")!;
  return renderRiverpod(p, allContexts(enriched)).source;
}

/** The emitted `lib/pages/sched_page.dart` from a full `generate system`. */
async function pageFile(page: string): Promise<string> {
  const files = await generateSystemFiles(sys(page));
  const key = [...files.keys()].find((k) => k.endsWith("lib/pages/sched_page.dart"));
  expect(key, `no sched page in: ${[...files.keys()].join(", ")}`).toBeDefined();
  return files.get(key!)!;
}

describe("flutter — the `now()` literal", () => {
  it("renders `DateTime.now().toUtc()` from the shared leaf table", () => {
    expect(DART_LEAVES.literal("now", "now")).toBe("DateTime.now().toUtc()");
    expect(DART_NOW).toBe("DateTime.now().toUtc()");
  });

  it("seeds a datetime state cell with a real instant, NOT in a const context", async () => {
    const src = await riverpod(`
    page Sched {
      route: "/"
      state { until: datetime = now() }
      body: Text { string(until) }
    }`);
    expect(src).toContain("return SchedState(until: DateTime.now().toUtc());");
    // The exact defects: a bare `now` is an unbound Dart identifier, and a
    // `const` invocation cannot carry a runtime `DateTime.now()` argument.
    expect(src).not.toMatch(/until: now\b/);
    expect(src).not.toContain("const SchedState(until: DateTime.now()");
  });

  it("keeps `const` on a state class whose inits ARE compile-time constants", async () => {
    const src = await riverpod(`
    page Sched {
      route: "/"
      state { count: int = 0 }
      body: Text { string(count) }
    }`);
    // The const-eligibility narrowing must not regress the ordinary literal case.
    expect(src).toContain("return const SchedState(count: 0);");
  });

  it("assigns a real instant in an action body (notifier update path)", async () => {
    const src = await riverpod(`
    page Sched {
      route: "/"
      state { until: datetime = now() }
      action push() { until := now() }
      body: Button { "go", onClick: push }
    }`);
    expect(src).toContain("state = state.copyWith(until: DateTime.now().toUtc());");
    expect(src).not.toMatch(/until: now\b/);
  });

  it("renders in a view-position expression (shared walker path)", async () => {
    const src = await pageFile(`
    page Sched {
      route: "/"
      state { until: datetime = now() }
      body: match {
        until < now() => Text { "late" }
        else          => Text { "ok" }
      }
    }`);
    expect(src).toContain("DateTime.now().toUtc()");
    expect(src).not.toMatch(/\buntil\) < now\b/);
    expect(src).not.toMatch(/< now\)/);
  });
});
