// Flutter parity lint — proves the post-generation scan (`analyzeFlutterParity`)
// finds the diagnostic markers the emitters produce and attributes them to the
// source construct, and reports a clean bill for a fully-lowering `ui`.  This is
// the browser-safe Tier-A "will my app fully render on Flutter?" check.

import { describe, expect, it } from "vitest";
import {
  analyzeFlutterParity,
  flutterParitySummary,
} from "../../../src/generator/flutter/parity.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

// A read-bearing component is deferred (not threaded into the walker), so its
// invocation falls back to `/* unknown layout component: Live */`.
const WITH_FALLBACK = `
system Par {
  api A from D
  subdomain D { context C {
    aggregate Item { name: string }
    repository Items for Item {}
  } }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui App {
    framework: flutter
    api Shop: A
    component Live() { body: QueryView { of: Shop.Item.all, loading: Text { "…" }, error: Text { "e" }, empty: Text { "none" }, data: rows => Text { "n" } } }
    page Home { route: "/" body: Stack { Heading { "H", level: 1 }, Live() } }
  }
  deployable api1 { platform: node contexts: [C] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App { Shop: api1 } port: 3006 }
}`;

// A plain display + form ui with no deferred constructs → fully renders.
const CLEAN = `
system Par {
  api A from D
  subdomain D { context C {
    aggregate Item { name: string  qty: int }
    repository Items for Item {}
  } }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui App {
    framework: flutter
    api Shop: A
    component Banner(label: string) { body: Card { Text { label } } }
    page Home {
      route: "/"
      state { n: int = 0 }
      action inc() { n := n + 1 }
      body: Stack { Heading { "H", level: 1 }, Banner(label: "hi"), Text { "n: " + n }, Button { "+", onClick: inc } }
    }
    page NewItem { route: "/new" body: Stack { Heading { "New", level: 1 }, CreateForm { of: Item } } }
  }
  deployable api1 { platform: node contexts: [C] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App { Shop: api1 } port: 3006 }
}`;

describe("flutter parity lint", () => {
  it("finds a deferred (read-bearing) component invocation + attributes it to the page", async () => {
    const files = await generateSystemFiles(WITH_FALLBACK);
    const findings = analyzeFlutterParity(files);
    const unknown = findings.find((f) => f.kind === "unknown-component");
    expect(unknown, "no unknown-component finding").toBeDefined();
    expect(unknown!.message).toContain("unknown layout component: Live");
    expect(unknown!.source).toBe("page Home");
    expect(unknown!.file).toMatch(/home_page\.dart$/);
    expect(unknown!.line).toBeGreaterThan(0);
  });

  it("reports a clean bill for a fully-lowering ui", async () => {
    const files = await generateSystemFiles(CLEAN);
    const summary = flutterParitySummary(files);
    expect(summary.fullyRenders, JSON.stringify(summary.findings, null, 2)).toBe(true);
    expect(summary.count).toBe(0);
  });

  it("ignores non-dart files and `//` banner comments", async () => {
    // Only `.dart` files are scanned, and `//` file banners are never markers —
    // the clean ui (which has `//`-commented headers) yields zero findings.
    const files = await generateSystemFiles(CLEAN);
    const findings = analyzeFlutterParity(files);
    expect(findings).toHaveLength(0);
  });
});
