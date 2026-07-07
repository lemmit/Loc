import { describe, expect, it } from "vitest";
import { resolveToSource } from "../../src/ir/types/origin.js";
import { generateSystems } from "../../src/system/index.js";
import { parseString, parseValid } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Round-trip test for the `--sourcemap` artifact (docs/plans/
// source-map-debug-kickoff.md §5/§6).  All five backends carry the emit
// bracket, so each must map at least one file per aggregate.
// ---------------------------------------------------------------------------

const BRACKETED: string[] = ["node", "dotnet", "elixir", "python", "java"];

const AGGREGATE_NAMES = ["Order", "Product"];

// One module, two aggregates (fields + operations), a valueobject, and an
// event — served by all five backend platforms so the fan-out slices can
// reuse this fixture unmodified.  The Phoenix deployable also mounts a
// scaffolded ui, so its pages carry a `macro` origin (the case the fan-out
// slices need to prove alongside the `source` case).
const SOURCE = `
system SourceMapDemo {
  subdomain Sales {
    context Orders {
      valueobject Money {
        amount: int
        currency: string
      }

      event OrderPlaced {
        order: Order id
      }

      aggregate Order {
        customerName: string
        total: Money
        operation confirm() {
          let note = customerName
          emit OrderPlaced { order: id }
        }
      }
      repository Orders for Order { }

      aggregate Product {
        name: string
        price: int
        // M17 phase 7 slice 4: the ONLY precondition in this fixture — added
        // so the widened statementExprMarks (every expression-bearing StmtIR
        // kind, not just let/assign/return) has a real predicate to anchor a
        // targetCol region on. Was an empty body pre-slice-4; adding this one
        // statement does not shift any other assertion in this file (nothing
        // here counts Product.discontinue()'s own statements — only the
        // workflow-level product.discontinue() CALL inside archiveOrder is
        // asserted elsewhere, unaffected by the operation body's contents).
        operation discontinue() { precondition price > 0 }
      }
      repository Products for Product { }

      workflow confirmOrder {
        create(orderId: Order id) {
          let order = Orders.getById(orderId)
          order.confirm()
        }
      }

      // Body DELIBERATELY differs from confirmOrder's: identical bodies
      // render to identical fragment text in the pooled workflow files, and
      // fragment()'s uniqueness rule then honestly skips BOTH — wiping every
      // workflow region there (observed live when this fixture first used a
      // copy of confirmOrder's body).
      workflow archiveOrder transactional {
        create(productId: Product id) {
          let product = Products.getById(productId)
          product.discontinue()
        }
      }

      channel Lifecycle {
        carries: OrderPlaced, PaymentTaken
      }

      // Correlated (by) deliberately: Java's dispatcher silently skips
      // by-less reactors entirely. Body text must stay DISTINCT from every
      // other workflow/op body in this fixture (identical bodies in a pooled
      // file collide on fragment()'s uniqueness rule and wipe both — see the
      // archiveOrder comment above). Generation-only fixture: this body would
      // loop at runtime (confirm re-emits OrderPlaced) — fine here, do not
      // reuse for boot tests.
      workflow notifyPlaced {
        orderId: Order id
        on(o: OrderPlaced) by o.order {
          let order = Orders.getById(o.order)
          order.confirm()
        }
      }

      event PaymentTaken {
        order: Order id
        amount: int
      }

      // Event-sourced saga with a create+on pair — exercises the MERGED
      // event-sourced handler renderers (.NET's if/else-nested branches,
      // Java's doubly-re-indented try-frame branches), the shapes with the
      // trickiest silent-failure risk in the re-indent replay. Bodies are
      // distinct from every other body here (the pooled duplicate-anchor
      // hazard above).
      workflow fulfillOrder eventSourced {
        orderId: Order id
        paid: int
        create(p: OrderPlaced) by p.order {
          emit PaymentTaken { order: p.order, amount: 1 }
        }
        on(pt: PaymentTaken) by pt.order {
          let alreadyPaid = paid
        }
        apply(pt: PaymentTaken) { paid := paid + pt.amount }
      }
    }
  }

  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  api SalesApi from Sales
  ui SalesUi with scaffold(subdomains: [Sales]) { }

  deployable honoApi    { platform: node                          contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 3000 }
  deployable dotnetApi  { platform: dotnet                        contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable pythonApi  { platform: python                        contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8000 }
  deployable javaApi    { platform: java                          contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8081 }
  deployable phoenixApi { platform: elixir { foundation: vanilla } contexts: [Orders] dataSources: [ordersState] ui: SalesUi port: 4000 }
  deployable reactApp   { platform: react targets: honoApi ui: SalesUi port: 3001 }
}
`;

// Deployable names run through `serviceSlug` (camelCase -> snake_case,
// src/system/index.ts) before becoming the output path prefix.
const SLUG_FOR: Record<string, string> = {
  node: "hono_api",
  dotnet: "dotnet_api",
  python: "python_api",
  java: "java_api",
  elixir: "phoenix_api",
};

const REACT_SLUG = "react_app";

// The elixir platform's `composeService` mints a fresh cryptographically
// random `SECRET_KEY_BASE` on every call (src/platform/elixir.ts) — a
// pre-existing nondeterminism independent of --sourcemap. Normalize it out
// so the byte-identical comparison below isn't a false negative on that
// unrelated axis.
function normalizeNondeterministic(content: string): string {
  return content.replace(/SECRET_KEY_BASE: "[0-9a-f]+"/, 'SECRET_KEY_BASE: "<redacted>"');
}

// Milestone 5 (Source Map v3 sidecars) appends exactly one trailing
// `//# sourceMappingURL=…` directive line to every mapped node/Hono `.ts`
// file — strip it before comparing against the flag-off run, whose files
// never carry it.
function stripSourceMappingDirective(content: string): string {
  return content.replace(/\/\/# sourceMappingURL=.*\n$/, "");
}

// M7 phase 6a: the .NET backend weaves enhanced `#line (a,b)-(c,d) "path"` /
// `#line hidden` / `#line default` directives into REGULAR named-operation
// bodies when `sourceTexts` is present — strip them before comparing a
// `.cs` file against the flag-off run, whose `.cs` output never carries
// them (see `test/generator/dotnet/line-directives.test.ts` for the
// directive-shape assertions).
function stripLineDirectives(content: string): string {
  return content.replace(/^#line (\(|default\b|hidden\b).*\n/gm, "");
}

// M10 phase 6b: the java backend weaves a fenced `// loom:sourcemap-begin` /
// `// loom:sourcemap-end` block (a `buildscript {}` at the top plus the
// `injectSmap` task registration near the bottom — see
// src/generator/java/emit/program.ts) into `build.gradle.kts` when the
// recorder is present, regardless of `sourceTexts` (the java generator
// itself never sees `sourceTexts` — only the `.smap` sidecar rendering,
// system-side, needs it).  Strip both fenced blocks (plus the blank-line
// separator each introduces) before comparing against the flag-off run,
// whose `build.gradle.kts` never carries them.
function stripJavaSourcemapFence(content: string): string {
  return content.replace(
    /\n?\/\/ loom:sourcemap-begin\n[\s\S]*?\/\/ loom:sourcemap-end\n{0,2}/g,
    "",
  );
}

// M18 phase 8 slice 1 (Node debug wiring, dap-node-debug.md): the node/Hono
// backend's `addTsExtensionsForNodeDebug` (src/generator/typescript/
// debug-imports.ts) suffixes every relative import with its real `.ts`/
// `.tsx` extension, ONLY when `sourcemap` is on — strip it back off before
// comparing a node-deployable `.ts` file against the flag-off run, whose
// imports stay extensionless (Bundler-style).
const RELATIVE_IMPORT_RE = /\b(?:from|import)\s*\(?\s*(['"])(\.[^'"]*)\1/g;
function stripNodeDebugImportExtensions(content: string): string {
  return content.replace(RELATIVE_IMPORT_RE, (full, quote: string, spec: string) => {
    const noExt = spec.replace(/\.(ts|tsx)$/, "");
    return full.replace(`${quote}${spec}${quote}`, `${quote}${noExt}${quote}`);
  });
}

// Same slice: `package.json` grows a `debug` script and `tsconfig.json`
// grows `allowImportingTsExtensions` — both ONLY under `sourcemap`.  Both
// are appended as the LAST key of their object (see
// src/platform/hono/v4/emit.ts's `projectPackageJson` / `projectTsconfigJson`),
// so parsing, deleting the key, and re-serializing with the same `null, 2`
// indent reproduces the flag-off file byte-for-byte (verified against a live
// generation — a plain regex strip risks the trailing-comma bookkeeping a
// last-position JSON key removal needs).
function stripNodeDebugScript(content: string): string {
  const pkg = JSON.parse(content) as { scripts?: Record<string, string> };
  if (pkg.scripts) delete pkg.scripts.debug;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}
function stripAllowImportingTsExtensions(content: string): string {
  const cfg = JSON.parse(content) as { compilerOptions?: Record<string, unknown> };
  if (cfg.compilerOptions) delete cfg.compilerOptions.allowImportingTsExtensions;
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

// `langium/test`'s `parseHelper` mints the in-memory doc's URI from a
// module-global counter (`/1.ddd`, `/2.ddd`, …) that keeps incrementing
// across every `it` in this file — never assume `/1.ddd`.  Parse with
// `parseString` (which returns the `LangiumDocument`, unlike `parseValid`)
// and read the REAL path back off `doc.uri.path` so `sourceTexts` is keyed
// correctly regardless of how many earlier tests already parsed something.
async function parseWithSourceTexts(
  source: string,
): Promise<{ model: Awaited<ReturnType<typeof parseValid>>; sourceTexts: Map<string, string> }> {
  const { model, doc, errors } = await parseString(source, { validate: true });
  if (errors.length) throw new Error(`unexpected validation errors:\n${errors.join("\n")}`);
  return { model, sourceTexts: new Map([[doc.uri.path, source]]) };
}

describe(".loom/sourcemap.json", () => {
  it("is absent by default, and output is otherwise byte-identical to a --sourcemap run", async () => {
    const { model, sourceTexts } = await parseWithSourceTexts(SOURCE);
    const withoutFlag = generateSystems(model).files;
    const withFlag = generateSystems(model, {
      sourcemap: true,
      sourceTexts,
    }).files;

    expect(withoutFlag.has(".loom/sourcemap.json")).toBe(false);
    expect([...withoutFlag.keys()].some((p) => p.endsWith(".map"))).toBe(false);
    // Honest skip, M10 phase 6b: flag-off never emits `.smap` sidecars nor
    // the java `injectSmap` Gradle fence, with or without `sourceTexts`.
    expect([...withoutFlag.keys()].some((p) => p.endsWith(".smap"))).toBe(false);
    for (const [path, content] of withoutFlag) {
      expect(content).not.toContain("//# sourceMappingURL=");
      expect(content).not.toContain("loom:sourcemap-begin");
      // Honest skip: flag-off never weaves .NET `#line` directives, with or
      // without `sourceTexts` (M7 phase 6a needs BOTH `sourcemap` and
      // `sourceTexts` — flag-off has neither).
      if (path.endsWith(".cs")) expect(content).not.toContain("\n#line ");
    }

    const withFlagMinusMap = new Map(withFlag);
    withFlagMinusMap.delete(".loom/sourcemap.json");
    // M18 phase 8 slice 1: `.vscode/launch.json` is a whole NEW file under
    // `sourcemap`, not a per-file content divergence — drop it from the
    // comparison the same way the wire artifact itself is dropped above.
    withFlagMinusMap.delete(".vscode/launch.json");
    for (const path of [...withFlagMinusMap.keys()]) {
      if (path.endsWith(".map") || path.endsWith(".smap")) withFlagMinusMap.delete(path);
    }

    expect([...withFlagMinusMap.keys()].sort()).toEqual([...withoutFlag.keys()].sort());
    const nodePrefix = `${SLUG_FOR.node}/`;
    for (const [path, content] of withoutFlag) {
      const other = withFlagMinusMap.get(path);
      expect(other, `missing ${path} in --sourcemap run`).toBeDefined();
      // The flag-on run also passes `sourceTexts`, so .cs output now carries
      // woven `#line` directives (M7 phase 6a) and `java_api/build.gradle.kts`
      // now carries the fenced `injectSmap` block (M10 phase 6b) — strip
      // each before the byte-identical comparison; every other extension /
      // path is untouched.
      let otherNormalized = stripSourceMappingDirective(other!);
      if (path.endsWith(".cs")) otherNormalized = stripLineDirectives(otherNormalized);
      if (path.endsWith("build.gradle.kts"))
        otherNormalized = stripJavaSourcemapFence(otherNormalized);
      // M18 phase 8 slice 1 (Node debug wiring): the node deployable's own
      // package.json/tsconfig.json/*.ts grow debug-only content under
      // `sourcemap` — normalize each back before comparing.
      if (path.startsWith(nodePrefix)) {
        if (path.endsWith("/package.json")) otherNormalized = stripNodeDebugScript(otherNormalized);
        else if (path.endsWith("/tsconfig.json"))
          otherNormalized = stripAllowImportingTsExtensions(otherNormalized);
        else if (path.endsWith(".ts") || path.endsWith(".tsx"))
          otherNormalized = stripNodeDebugImportExtensions(otherNormalized);
      }
      expect(normalizeNondeterministic(otherNormalized), `content drifted for ${path}`).toBe(
        normalizeNondeterministic(content),
      );
    }
  });

  it("emits a well-formed artifact when the flag is on", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const raw = files.get(".loom/sourcemap.json");
    expect(raw).toBeDefined();
    expect(raw!.endsWith("\n")).toBe(true);

    const map = JSON.parse(raw!) as {
      version: number;
      sources: string[];
      files: Record<string, { target: [number, number]; origin: unknown; construct?: string }[]>;
    };
    expect(map.version).toBe(1);
    expect(map.sources.length).toBeGreaterThan(0);
    expect(Object.keys(map.files).length).toBeGreaterThan(0);
  });

  // Span-tracking emission (M15 phase 7 slice 2, span-tracking-emission.md):
  // the wire artifact stays version 1 (additive field) but at least one
  // region on the TS/Hono aggregate file now carries a real `targetCol`.
  it("carries targetCol on the node backend's confirm() RHS region — additive, version unchanged", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as {
      version: number;
      files: Record<
        string,
        { target: [number, number]; construct?: string; targetCol?: [number, number] }[]
      >;
    };
    expect(map.version).toBe(1);

    const path = Object.keys(map.files).find(
      (p) => p.startsWith(`${SLUG_FOR.node}/`) && p.endsWith("domain/order.ts"),
    )!;
    const regions = map.files[path]!;
    const marked = regions.filter(
      (r) => r.construct === "Orders.Order.confirm" && r.targetCol !== undefined,
    );
    expect(marked.length).toBeGreaterThan(0);
    for (const r of marked) {
      expect(r.targetCol![0]).toBeGreaterThanOrEqual(1);
      expect(r.targetCol![0]).toBeLessThan(r.targetCol![1]);
      expect(r.target[0]).toBe(r.target[1]); // single-line, per the type comment
    }
  });

  // M17 phase 7 slice 4 (span-tracking-emission.md §4): marks widen from
  // let/assign/return to every expression-bearing StmtIR kind. The fixture's
  // `emit OrderPlaced { order: id }` (Order.confirm) and `precondition price
  // > 0` (Product.discontinue, the ONLY precondition in this fixture) are
  // the two new kinds this test proves land a real targetCol region —
  // recomputed straight from the emitted content, the #1744 pattern.
  it("carries targetCol on an emit field expr and a precondition predicate (M17 slice 4 widening)", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as {
      files: Record<
        string,
        { target: [number, number]; construct?: string; targetCol?: [number, number] }[]
      >;
    };

    // (a) the emit field expr: `order: id` renders as `order: this._id`
    // inside the pushed event object literal.
    const orderPath = Object.keys(map.files).find(
      (p) => p.startsWith(`${SLUG_FOR.node}/`) && p.endsWith("domain/order.ts"),
    )!;
    const orderContent = files.get(orderPath)!;
    const orderRegions = map.files[orderPath]!;
    const emitLine = orderContent.split("\n").findIndex((l) => l.includes("this._events.push")) + 1;
    expect(emitLine).toBeGreaterThan(0);
    const emitMarked = orderRegions.filter(
      (r) =>
        r.construct === "Orders.Order.confirm" &&
        r.targetCol !== undefined &&
        r.target[0] === emitLine,
    );
    expect(emitMarked.length).toBeGreaterThan(0);
    const emitLineText = orderContent.split("\n")[emitLine - 1]!;
    const idCol0 = emitLineText.indexOf("this._id");
    expect(idCol0).toBeGreaterThanOrEqual(0);
    const idRegion = emitMarked.find(
      (r) => r.targetCol![0] === idCol0 + 1 && r.targetCol![1] === idCol0 + 1 + "this._id".length,
    );
    expect(
      idRegion,
      "expected a targetCol region anchored on the emit field's `this._id`",
    ).toBeDefined();

    // (b) the precondition predicate: `price > 0` renders as
    // `if (!(this._price > 0)) throw ...`.
    const productPath = Object.keys(map.files).find(
      (p) => p.startsWith(`${SLUG_FOR.node}/`) && p.endsWith("domain/product.ts"),
    )!;
    const productContent = files.get(productPath)!;
    const productRegions = map.files[productPath]!;
    const preLine =
      productContent.split("\n").findIndex((l) => l.includes("Precondition failed")) + 1;
    expect(preLine).toBeGreaterThan(0);
    const preMarked = productRegions.filter(
      (r) =>
        r.construct === "Orders.Product.discontinue" &&
        r.targetCol !== undefined &&
        r.target[0] === preLine,
    );
    expect(preMarked.length).toBeGreaterThan(0);
    const preLineText = productContent.split("\n")[preLine - 1]!;
    const wholePredCol0 = preLineText.indexOf("this._price > 0");
    expect(wholePredCol0).toBeGreaterThanOrEqual(0);
    const predRegion = preMarked.find(
      (r) =>
        r.targetCol![0] === wholePredCol0 + 1 &&
        r.targetCol![1] === wholePredCol0 + 1 + "this._price > 0".length,
    );
    expect(
      predRegion,
      "expected a targetCol region anchored on the precondition's whole predicate `this._price > 0`",
    ).toBeDefined();
  });

  it("every recorded region resolves to a real source span and a sane target range", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as {
      sources: string[];
      files: Record<
        string,
        {
          target: [number, number];
          origin: import("../../src/ir/types/origin.js").OriginRef;
          construct?: string;
        }[]
      >;
    };

    for (const [path, regions] of Object.entries(map.files)) {
      const generatedContent = files.get(path);
      expect(generatedContent, `sourcemap references unknown output path ${path}`).toBeDefined();
      const generatedLineCount = generatedContent!.endsWith("\n")
        ? generatedContent!.split("\n").length - 1
        : generatedContent!.split("\n").length;

      for (const region of regions) {
        const [start, end] = region.target;
        expect(start, `${path}: target start out of range`).toBeGreaterThanOrEqual(1);
        expect(end, `${path}: target end out of range`).toBeLessThanOrEqual(
          Math.max(1, generatedLineCount),
        );
        expect(start, `${path}: target start > end`).toBeLessThanOrEqual(end);

        const resolved = resolveToSource(region.origin);
        expect(resolved, `${path}: origin chain never resolves to a source span`).toBeDefined();
        expect(
          map.sources,
          `${path}: resolved source path ${resolved!.path} not in sources`,
        ).toContain(resolved!.path);
        const [spanStart, spanEnd] = resolved!.span;
        expect(spanStart, `${path}: span start negative`).toBeGreaterThanOrEqual(0);
        expect(spanStart, `${path}: span start >= end`).toBeLessThan(spanEnd);
        expect(spanEnd, `${path}: span end beyond source length`).toBeLessThanOrEqual(
          SOURCE.length,
        );

        if (region.construct) {
          const aggName = AGGREGATE_NAMES.find((n) => region.construct!.endsWith(`.${n}`));
          if (aggName) {
            const text = SOURCE.slice(spanStart, spanEnd);
            expect(
              text,
              `${path}: construct ${region.construct} span doesn't mention ${aggName}`,
            ).toContain(aggName);
          }
        }
      }
    }
  });

  it.each(
    BRACKETED,
  )("bracketed platform %s maps at least one file per aggregate", async (platform) => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as {
      files: Record<string, { construct?: string }[]>;
    };

    const slug = SLUG_FOR[platform]!;
    const prefix = `${slug}/`;
    const mappedForPlatform = Object.keys(map.files).filter((p) => p.startsWith(prefix));
    expect(
      mappedForPlatform.length,
      `platform ${platform}: expected >= ${AGGREGATE_NAMES.length} mapped files under ${prefix}, saw ${JSON.stringify(mappedForPlatform)}`,
    ).toBeGreaterThanOrEqual(AGGREGATE_NAMES.length);

    for (const aggName of AGGREGATE_NAMES) {
      const constructs = mappedForPlatform.flatMap((p) => map.files[p]!.map((r) => r.construct));
      expect(
        constructs.some((c) => c?.endsWith(`.${aggName}`)),
        `platform ${platform}: no region's construct mentions ${aggName} (saw ${JSON.stringify(constructs)})`,
      ).toBe(true);
    }
  });

  // M8 (frontend recording bracket): the react frontend's page constructs are
  // page-name-shaped (`SalesUi.orders.List`), not aggregate-name-shaped, so
  // they don't fit the `.endsWith(".Order")` assertion the bracketed-platform
  // table above uses — a separate test asserts the frontend-specific shape:
  // every mapped `src/pages/...` file's construct starts with the ui name,
  // and its origin is the `macro` kind a scaffolded ui always carries,
  // resolving to a real `.ddd` span.
  it("react frontend maps page files under the ui name, each with a macro origin resolving to source", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as {
      files: Record<
        string,
        { construct?: string; origin: import("../../src/ir/types/origin.js").OriginRef }[]
      >;
    };

    const prefix = `${REACT_SLUG}/`;
    const pageEntries = Object.entries(map.files).filter(([p]) =>
      p.startsWith(`${prefix}src/pages/`),
    );
    expect(pageEntries.length, `no src/pages/... regions recorded under ${prefix}`).toBeGreaterThan(
      0,
    );

    for (const [path, regions] of pageEntries) {
      expect(regions.length, `${path}: expected at least one region`).toBeGreaterThan(0);
      for (const region of regions) {
        expect(region.construct, `${path}: missing construct`).toBeDefined();
        expect(
          region.construct!.startsWith("SalesUi."),
          `${path}: construct ${region.construct} doesn't start with the ui name`,
        ).toBe(true);
        expect(region.origin.kind, `${path}: expected a scaffold macro origin`).toBe("macro");
        const resolved = resolveToSource(region.origin);
        expect(resolved, `${path}: origin never resolves to a source span`).toBeDefined();
      }
    }
  });

  // Statement-granular sub-regions (Milestone 3, source-map-and-debugging.md
  // §5.2 — Hono reference in #1701, fan-out to the other four backends here).
  // `Order.confirm()` has 2 statements (`let note = customerName` then
  // `emit OrderPlaced { … }`); both are stamped with `origin` at lowering and
  // anchored via `SourceMapRecorder.fragment`.
  //
  // Per-backend expectations diverge on two axes:
  // - `file`: where the op body lands.  Four backends emit one
  //   aggregate-owned file; Elixir pools every op body into the per-context
  //   module `lib/<app>/<ctx>.ex`.
  // - `wholeFile`: the pooled elixir file deliberately carries NO whole-file
  //   region (milestone-1 decision — a pooled file has no single honest
  //   origin), so the statement sub-regions are its only regions.  The
  //   fixture's `emit` is HOISTED out of the rendered body (persist-then-
  //   dispatch restructuring, S5a) so it renders in a DIFFERENT structural
  //   position than the `let` — M13 (#1704 leftover) gives it its own
  //   per-emit fragment (`renderEmitDispatchLines`), so elixir's `tokens`
  //   now matches the other four backends' 2-statement shape.
  const STMT_CASES: {
    platform: string;
    file: string;
    tokens: string[];
    wholeFile: boolean;
  }[] = [
    {
      platform: "node",
      file: "domain/order.ts",
      tokens: ["customerName", "emit OrderPlaced"],
      wholeFile: true,
    },
    {
      platform: "dotnet",
      file: "Domain/Orders/Order.cs",
      tokens: ["customerName", "emit OrderPlaced"],
      wholeFile: true,
    },
    {
      platform: "python",
      file: "app/domain/order.py",
      tokens: ["customerName", "emit OrderPlaced"],
      wholeFile: true,
    },
    {
      platform: "java",
      file: "features/orders/Order.java",
      tokens: ["customerName", "emit OrderPlaced"],
      wholeFile: true,
    },
    {
      // M13 (#1704 leftover): the hoisted `emit` block now gets its OWN
      // per-emit fragment (`renderEmitDispatchLines`), alongside the regular
      // body's `let` — so elixir joins the other four backends at 2 tokens.
      platform: "elixir",
      file: "lib/phoenix_api/orders.ex",
      tokens: ["customerName", "emit OrderPlaced"],
      wholeFile: false,
    },
  ];

  it.each(
    STMT_CASES,
  )("statement-granular regions land on $platform's confirm() body, one per rendered statement", async ({
    platform,
    file,
    tokens,
    wholeFile,
  }) => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as {
      files: Record<
        string,
        {
          target: [number, number];
          origin: import("../../src/ir/types/origin.js").OriginRef;
          construct?: string;
          targetCol?: [number, number];
        }[]
      >;
    };

    const slug = SLUG_FOR[platform]!;
    const path = Object.keys(map.files).find((p) => p.startsWith(`${slug}/`) && p.endsWith(file));
    expect(path, `no ${file} region recorded under ${slug}/`).toBeDefined();
    const regions = map.files[path!]!;
    const content = files.get(path!)!;
    // This suite's `generateSystems` call above passes no `sourceTexts`, so
    // the .NET `#line` weave (M7 phase 6a, gated on BOTH `sourcemap` AND
    // `sourceTexts`) never fires here — the sub-region line math below stays
    // exactly the pre-M7 shape regardless of platform.
    if (platform === "dotnet") expect(content).not.toContain("#line");
    const fileLineCount = content.endsWith("\n")
      ? content.split("\n").length - 1
      : content.split("\n").length;

    // (a) one sub-region per RENDERED statement, layered onto the
    // whole-file region where one exists (a pooled file has none).  M15
    // phase 7 slice 2 (node/TS only) layers an ADDITIONAL, finer
    // `targetCol`-bearing region onto the SAME construct for the `let`
    // statement's RHS — exclude those from the one-per-statement count
    // here (they're covered by their own dedicated targetCol assertions
    // above) so this invariant stays about statement, not expression,
    // granularity.
    const opConstruct = "Orders.Order.confirm";
    const stmtRegions = regions
      .filter((r) => r.construct === opConstruct && r.targetCol === undefined)
      .sort((a, b) => a.target[0] - b.target[0]);
    expect(stmtRegions).toHaveLength(tokens.length);
    if (wholeFile) {
      expect(regions.length).toBeGreaterThan(stmtRegions.length);
    } else {
      // The pooled elixir context file also carries OTHER aggregates' own
      // op regions now — Product.discontinue grew a real precondition
      // statement in M17 phase 7 slice 4 (added so the widened
      // `statementExprMarks` has a predicate to anchor a targetCol mark on,
      // sourcemap.test.ts's own "targetCol on a precondition" case), so
      // "this op's regions are the file's ONLY regions" no longer holds —
      // the invariant that DOES still hold, and is what `wholeFile: false`
      // is actually pinning, is "no stray WHOLE-FILE (construct-less)
      // region exists" (a pooled elixir file has no single honest
      // whole-file origin — see the class comment above).
      expect(regions.every((r) => r.construct !== undefined)).toBe(true);
      expect(regions.length).toBeGreaterThanOrEqual(stmtRegions.length);
    }

    // (b) within the file's line range, non-overlapping, monotonically
    // increasing target[0].
    let prevEnd = 0;
    for (const r of stmtRegions) {
      const [start, end] = r.target;
      expect(start).toBeGreaterThanOrEqual(1);
      expect(end).toBeLessThanOrEqual(fileLineCount);
      expect(start).toBeLessThanOrEqual(end);
      expect(start).toBeGreaterThan(prevEnd);
      prevEnd = end;
    }

    // (c) each statement region's origin resolves to a span whose text
    // contains that statement's own distinctive token, in source order.
    stmtRegions.forEach((r, i) => {
      const resolved = resolveToSource(r.origin);
      expect(resolved, `stmt region ${i} origin never resolves to a source span`).toBeDefined();
      const text = SOURCE.slice(resolved!.span.start, resolved!.span.end);
      expect(text, `stmt region ${i} span doesn't contain "${tokens[i]}"`).toContain(tokens[i]);
    });
  });

  // Milestone 11 (workflow-body statement regions) — the `WorkflowStmtIR`
  // analogue of the aggregate op-body sub-regions above, riding the SAME
  // machinery (`statementSubRegions` + `SourceMapRecorder.fragment`) via the
  // shared `renderWorkflowStmtChunks` spine.  `confirmOrder`'s `create` body
  // has 2 statements (`let order = Orders.getById(orderId)` then
  // `order.confirm()`); both carry `origin` at lowering.
  //
  // Unlike the op-body case, three of the four covered backends (node,
  // python, java) emit the workflow body into a POOLED file shared by every
  // workflow — `http/workflows.ts`, `workflows_routes.py`,
  // `<Ctx>Workflows.java` — so those files carry NO whole-file region, only
  // the fragment-only statement regions.  .NET's `<Wf>Handler.cs` is
  // per-workflow (not pooled), so it keeps its Milestone-1 whole-file region
  // alongside the new statement regions.
  //
  // M13 adds elixir's own per-workflow `<wf>.ex` module: its `assembleBody`
  // REORDERS `with`-clauses vs. `emit`s into different structural buckets,
  // so (unlike the cursor-walked `statementSubRegions` the other four
  // backends share) it anchors each statement INDEPENDENTLY, one
  // `fragment()` call per statement, keyed to that statement's own text
  // regardless of where the bucketing relocated it.  The per-workflow file
  // is not pooled, so — like .NET — it keeps its Milestone-1 whole-file
  // region alongside the statement regions.
  const WORKFLOW_STMT_CASES: {
    platform: string;
    file: string;
    /** Whether this backend's workflow-body file also carries a
     *  Milestone-1 whole-file region (true only for .NET's and elixir's
     *  per-workflow handler files; the pooled node/python/java files carry
     *  none). */
    wholeFile: boolean;
  }[] = [
    { platform: "node", file: "http/workflows.ts", wholeFile: false },
    { platform: "dotnet", file: "Application/Workflows/ConfirmOrderHandler.cs", wholeFile: true },
    { platform: "python", file: "app/http/workflows_routes.py", wholeFile: false },
    {
      platform: "java",
      file: "application/workflows/OrdersWorkflows.java",
      wholeFile: false,
    },
    {
      platform: "elixir",
      file: "lib/phoenix_api/orders/workflows/confirm_order.ex",
      wholeFile: true,
    },
  ];

  it.each(
    WORKFLOW_STMT_CASES,
  )("workflow-body statement regions land on $platform's confirmOrder body, one per rendered statement", async ({
    platform,
    file,
    wholeFile,
  }) => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as {
      files: Record<
        string,
        {
          target: [number, number];
          origin: import("../../src/ir/types/origin.js").OriginRef;
          construct?: string;
        }[]
      >;
    };

    const slug = SLUG_FOR[platform]!;
    const path = Object.keys(map.files).find((p) => p.startsWith(`${slug}/`) && p.endsWith(file));
    expect(path, `no ${file} region recorded under ${slug}/`).toBeDefined();
    const regions = map.files[path!]!;
    const content = files.get(path!)!;
    const fileLineCount = content.endsWith("\n")
      ? content.split("\n").length - 1
      : content.split("\n").length;

    // .NET's per-workflow file() call records its Milestone-1 whole-file
    // region under the SAME `${ctx.name}.${wf.name}` construct as the
    // fragment-only statement regions (both derive from `wf.origin`), so a
    // bare construct filter can't tell them apart — exclude the region whose
    // target IS the whole file `[1, fileLineCount]` before looking at
    // statement granularity.
    const wfConstruct = "Orders.confirmOrder";
    const wholeFileRegion = regions.find((r) => r.target[0] === 1 && r.target[1] === fileLineCount);
    const stmtRegions = regions
      .filter((r) => r.construct === wfConstruct && r !== wholeFileRegion)
      .sort((a, b) => a.target[0] - b.target[0]);
    expect(stmtRegions.length).toBeGreaterThanOrEqual(2);

    // A pooled file (node/python/java) carries ONLY statement regions — no
    // whole-file region exists to layer onto — though for every workflow the
    // fixture declares (confirmOrder + the transactional archiveOrder +,
    // node-only, the notifyPlaced reactor sharing node's pooled
    // http/workflows.ts — Milestone 12), so every region must be
    // workflow-construct-tagged rather than exactly the confirmOrder set.
    // .NET's handler file is not pooled, so it keeps its whole-file region
    // alongside its own workflow's statement regions.
    if (wholeFile) {
      expect(wholeFileRegion, "expected a Milestone-1 whole-file region too").toBeDefined();
      expect(regions.length).toBeGreaterThan(stmtRegions.length);
    } else {
      expect(wholeFileRegion).toBeUndefined();
      for (const r of regions) {
        expect([
          "Orders.confirmOrder",
          "Orders.archiveOrder",
          "Orders.notifyPlaced",
          "Orders.fulfillOrder",
        ]).toContain(r.construct);
      }
    }

    // Monotonic, non-overlapping, in-bounds — same shape as the op-body case.
    let prevEnd = 0;
    for (const r of stmtRegions) {
      const [start, end] = r.target;
      expect(start).toBeGreaterThanOrEqual(1);
      expect(end).toBeLessThanOrEqual(fileLineCount);
      expect(start).toBeLessThanOrEqual(end);
      expect(start).toBeGreaterThan(prevEnd);
      prevEnd = end;
    }

    // Each statement region's origin resolves to a span whose text contains
    // that statement's own distinctive token, in source order.
    const tokens = ["Orders.getById", "order.confirm"];
    stmtRegions.forEach((r, i) => {
      const resolved = resolveToSource(r.origin);
      expect(resolved, `stmt region ${i} origin never resolves to a source span`).toBeDefined();
      const text = SOURCE.slice(resolved!.span.start, resolved!.span.end);
      expect(text, `stmt region ${i} span doesn't contain "${tokens[i]}"`).toContain(tokens[i]);
    });
  });

  // Milestone 12 (reactor-file recording) — the REACTOR-body analogue of the
  // Milestone 11 command-workflow-body case above.  `notifyPlaced`'s `on`
  // reactor has 2 statements (`let order = Orders.getById(o.order)` then
  // `order.confirm()`), riding the SAME `renderWorkflowStmtChunks` +
  // `statementSubRegions` + `fragment()` machinery, now extended onto the
  // reactor/event-create dispatch files: .NET's per-subscription
  // `<Wf>On<Event>Handler.cs` (whole-file + fragments), and the pooled
  // node/python/java dispatch files (fragment-only, no whole-file region —
  // node shares the SAME pooled `http/workflows.ts` the command-workflow
  // case above uses; python and java route reactors to their OWN pooled
  // file, separate from the command-workflow one).  M13 extends elixir's
  // OWN per-subscription handler file (`.../workflows/<wf>/on_<event>.ex`,
  // threaded through `emitDispatch`'s new `sourcemap` param) — like .NET,
  // it is single-workflow-attributable (not pooled), so it keeps its
  // Milestone-1 whole-file region alongside the statement regions.
  //
  // .NET's construct diverges from the other three: `emitDispatchHandlers`
  // runs over the SYSTEM-MODE merged context (so a reactor in one hosted
  // context can react to a channel declared in another), and that merged
  // context's `.name` is the deployable's C# namespace ("DotnetApi"), not
  // the first hosted context's own name ("Orders") — unlike node/python's
  // merge (`contexts[0]?.name`) or java's un-merged per-context call.  This
  // is pre-existing `emitDispatchHandlers` architecture, not new here.
  const REACTOR_STMT_CASES: {
    platform: string;
    file: string;
    construct: string;
    /** Whether this backend's dispatch file also carries a Milestone-1
     *  whole-file region (true only for .NET's per-subscription handler
     *  file; the pooled node/python/java files carry none). */
    wholeFile: boolean;
  }[] = [
    {
      platform: "dotnet",
      file: "Application/Workflows/NotifyPlacedOnOrderPlacedHandler.cs",
      construct: "DotnetApi.notifyPlaced",
      wholeFile: true,
    },
    {
      platform: "node",
      file: "http/workflows.ts",
      construct: "Orders.notifyPlaced",
      wholeFile: false,
    },
    {
      platform: "python",
      file: "app/dispatch.py",
      construct: "Orders.notifyPlaced",
      wholeFile: false,
    },
    {
      platform: "java",
      file: "application/workflows/OrdersDispatcher.java",
      construct: "Orders.notifyPlaced",
      wholeFile: false,
    },
    {
      platform: "elixir",
      file: "lib/phoenix_api/orders/workflows/notify_placed/on_order_placed.ex",
      construct: "Orders.notifyPlaced",
      wholeFile: true,
    },
  ];

  it.each(
    REACTOR_STMT_CASES,
  )("reactor-body statement regions land on $platform's notifyPlaced body, one per rendered statement", async ({
    platform,
    file,
    construct,
    wholeFile,
  }) => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as {
      files: Record<
        string,
        {
          target: [number, number];
          origin: import("../../src/ir/types/origin.js").OriginRef;
          construct?: string;
        }[]
      >;
    };

    const slug = SLUG_FOR[platform]!;
    const path = Object.keys(map.files).find((p) => p.startsWith(`${slug}/`) && p.endsWith(file));
    expect(path, `no ${file} region recorded under ${slug}/`).toBeDefined();
    const regions = map.files[path!]!;
    const content = files.get(path!)!;
    const fileLineCount = content.endsWith("\n")
      ? content.split("\n").length - 1
      : content.split("\n").length;

    // .NET's per-subscription file() call records its Milestone-1 whole-file
    // region under the SAME construct as the fragment-only statement
    // regions (both derive from `wf.origin`), so exclude the region whose
    // target IS the whole file before looking at statement granularity.
    const wholeFileRegion = regions.find((r) => r.target[0] === 1 && r.target[1] === fileLineCount);
    const stmtRegions = regions
      .filter((r) => r.construct === construct && r !== wholeFileRegion)
      .sort((a, b) => a.target[0] - b.target[0]);
    expect(stmtRegions.length).toBeGreaterThanOrEqual(2);

    if (wholeFile) {
      expect(wholeFileRegion, "expected a Milestone-1 whole-file region too").toBeDefined();
      expect(regions.length).toBeGreaterThan(stmtRegions.length);
    } else {
      expect(wholeFileRegion).toBeUndefined();
    }

    // Monotonic, non-overlapping, in-bounds — same shape as the command-
    // workflow-body case.
    let prevEnd = 0;
    for (const r of stmtRegions) {
      const [start, end] = r.target;
      expect(start).toBeGreaterThanOrEqual(1);
      expect(end).toBeLessThanOrEqual(fileLineCount);
      expect(start).toBeLessThanOrEqual(end);
      expect(start).toBeGreaterThan(prevEnd);
      prevEnd = end;
    }

    // Each statement region's origin resolves to a span whose text contains
    // that statement's own distinctive token, in source order.
    const tokens = ["Orders.getById", "order.confirm"];
    stmtRegions.forEach((r, i) => {
      const resolved = resolveToSource(r.origin);
      expect(resolved, `stmt region ${i} origin never resolves to a source span`).toBeDefined();
      const text = SOURCE.slice(resolved!.span.start, resolved!.span.end);
      expect(text, `stmt region ${i} span doesn't contain "${tokens[i]}"`).toContain(tokens[i]);
    });
  });

  // The TRANSACTIONAL paths re-indent the rendered body AFTER chunking
  // (.NET wraps the whole body in a tx block at +4 spaces; hono's builder
  // wraps the facade in a +2-space map) — the recording sites replay the
  // identical transform onto the chunks before anchoring, and a regression
  // there fails SILENTLY (fragment() records nothing on a missed anchor).
  // `archiveOrder transactional` pins that replay on both backends.
  it.each([
    { platform: "dotnet", file: "Application/Workflows/ArchiveOrderHandler.cs" },
    { platform: "node", file: "http/workflows.ts" },
  ])("transactional workflow bodies anchor through the re-indent on $platform", async ({
    platform,
    file,
  }) => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const map = JSON.parse(files.get(".loom/sourcemap.json")!) as {
      files: Record<
        string,
        {
          target: [number, number];
          origin: import("../../src/ir/types/origin.js").OriginRef;
          construct?: string;
        }[]
      >;
    };

    const slug = SLUG_FOR[platform]!;
    const path = Object.keys(map.files).find((p) => p.startsWith(`${slug}/`) && p.endsWith(file));
    expect(path, `no ${file} region recorded under ${slug}/`).toBeDefined();
    const content = files.get(path!)!;
    const fileLineCount = content.endsWith("\n")
      ? content.split("\n").length - 1
      : content.split("\n").length;

    const stmtRegions = map.files[path!]!.filter(
      (r) =>
        r.construct === "Orders.archiveOrder" &&
        !(r.target[0] === 1 && r.target[1] === fileLineCount),
    ).sort((a, b) => a.target[0] - b.target[0]);
    expect(
      stmtRegions.length,
      "transactional body's statement regions failed to anchor",
    ).toBeGreaterThanOrEqual(2);

    const tokens = ["Orders.getById", "order.confirm"];
    stmtRegions.forEach((r, i) => {
      const resolved = resolveToSource(r.origin);
      expect(resolved, `stmt region ${i} origin never resolves`).toBeDefined();
      const text = SOURCE.slice(resolved!.span.start, resolved!.span.end);
      expect(text).toContain(tokens[i]);
    });
  });

  // The MERGED event-sourced handler shapes carry the trickiest re-indent
  // replays — .NET nests each branch +4 inside the if/else, Java replays
  // TWICE (+8: if/else nest plus the try(RequestContext.openChild()) frame)
  // — and a missed replay fails silently (fragment() records nothing).
  // fulfillOrder's create+on pair pins both.
  it.each([
    {
      platform: "dotnet",
      file: "Application/Workflows/FulfillOrderStartOrderPlacedHandler.cs",
      construct: "DotnetApi.fulfillOrder",
      token: "emit PaymentTaken",
      wholeFile: true,
    },
    {
      platform: "dotnet",
      file: "Application/Workflows/FulfillOrderOnPaymentTakenHandler.cs",
      construct: "DotnetApi.fulfillOrder",
      token: "alreadyPaid",
      wholeFile: true,
    },
    {
      // java's dispatcher is POOLED across every reactor/starter in the
      // context — no single honest whole-file origin (same milestone-1
      // reasoning as the other pooled dispatch files).
      platform: "java",
      file: "application/workflows/OrdersDispatcher.java",
      construct: "Orders.fulfillOrder",
      token: "emit PaymentTaken",
      wholeFile: false,
    },
    // M13 — elixir's ES handlers are TWO SEPARATE files (not merged like
    // .NET's if/else, and not pooled like java's dispatcher), each
    // single-workflow-attributable: the `create` starter
    // (`start_order_placed.ex`) and the `on` reactor
    // (`on_payment_taken.ex`), both threaded through
    // `emitVanillaEsWorkflowFiles`/`emitDispatch`'s new `sourcemap` param.
    {
      platform: "elixir",
      file: "lib/phoenix_api/orders/workflows/fulfill_order/start_order_placed.ex",
      construct: "Orders.fulfillOrder",
      token: "emit PaymentTaken",
      wholeFile: true,
    },
    {
      platform: "elixir",
      file: "lib/phoenix_api/orders/workflows/fulfill_order/on_payment_taken.ex",
      construct: "Orders.fulfillOrder",
      token: "alreadyPaid",
      wholeFile: true,
    },
  ])("merged event-sourced bodies anchor through the branch re-indents ($platform $file)", async ({
    platform,
    file,
    construct,
    token,
    wholeFile,
  }) => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const map = JSON.parse(files.get(".loom/sourcemap.json")!) as {
      files: Record<
        string,
        {
          target: [number, number];
          origin: import("../../src/ir/types/origin.js").OriginRef;
          construct?: string;
        }[]
      >;
    };

    const slug = SLUG_FOR[platform]!;
    const path = Object.keys(map.files).find((p) => p.startsWith(`${slug}/`) && p.endsWith(file));
    expect(path, `no ${file} region recorded under ${slug}/`).toBeDefined();
    const content = files.get(path!)!;
    const fileLineCount = content.endsWith("\n")
      ? content.split("\n").length - 1
      : content.split("\n").length;

    const wholeFileRegion = map.files[path!]!.find(
      (r) => r.target[0] === 1 && r.target[1] === fileLineCount,
    );
    if (wholeFile) {
      expect(wholeFileRegion, "expected a Milestone-1 whole-file region too").toBeDefined();
    } else {
      expect(wholeFileRegion).toBeUndefined();
    }

    const stmtRegions = map.files[path!]!.filter(
      (r) => r.construct === construct && !(r.target[0] === 1 && r.target[1] === fileLineCount),
    );
    expect(
      stmtRegions.length,
      "merged-ES body's statement regions failed to anchor",
    ).toBeGreaterThanOrEqual(1);

    const sliced = stmtRegions.map((r) => {
      const resolved = resolveToSource(r.origin);
      expect(resolved, "origin never resolves to a source span").toBeDefined();
      return SOURCE.slice(resolved!.span.start, resolved!.span.end);
    });
    expect(
      sliced.some((t) => t.includes(token)),
      `no region's origin slices to "${token}" (got ${JSON.stringify(sliced)})`,
    ).toBe(true);
  });

  // M13 INVERTS the old "elixir workflow bodies stay out of scope" test:
  // elixir's `assembleBody` bucketing REORDERS `with`-clauses vs. `emit`s
  // (so the cursor-walked `statementSubRegions` the other backends share
  // doesn't apply), but a per-statement INDEPENDENT `fragment()` anchor
  // (keyed to each statement's own text, position-independent) works fine
  // regardless — so elixir workflows are no longer out of scope.  The four
  // legs (command-workflow body, reactor body, event-sourced handler,
  // aggregate hoisted emit) are now covered by the WORKFLOW_STMT_CASES /
  // REACTOR_STMT_CASES / merged-event-sourced-bodies / STMT_CASES cases
  // above, each carrying an `elixir` row.
  it("elixir's per-context module carries no stray confirmOrder-construct regions outside the dedicated workflow file", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as {
      files: Record<string, { target: [number, number]; construct?: string }[]>;
    };

    // `Orders.confirmOrder`-construct regions must land EXCLUSIVELY on the
    // dedicated `orders/workflows/confirm_order.ex` module — never leak
    // onto the pooled `orders.ex` context module the aggregate op bodies
    // share (a workflow and an op body are lowered by separate emitters;
    // this pins that they never cross-contaminate each other's file).
    const elixirConfirmOrderRegions = Object.entries(map.files)
      .filter(([p]) => p.startsWith(`${SLUG_FOR.elixir}/`))
      .flatMap(([p, regions]) =>
        regions
          .filter((r) => r.construct === "Orders.confirmOrder")
          .map((r) => ({ path: p, ...r })),
      );
    expect(elixirConfirmOrderRegions.length).toBeGreaterThan(0);
    for (const region of elixirConfirmOrderRegions) {
      expect(region.path).toBe(
        `${SLUG_FOR.elixir}/lib/phoenix_api/orders/workflows/confirm_order.ex`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Source Map v3 sidecars (Milestone 5, source-map-and-debugging.md §8) —
// node/Hono `.ts`/`.tsx` output only.  A small hand-rolled VLQ decoder
// mirrors `src/system/sourcemap-v3.ts`'s encoder so the test verifies the
// actual wire bytes, not just that `renderSourceMapV3` was called.
// ---------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decode one base64-VLQ field starting at `pos.i`, advancing `pos.i` past
 *  it.  Inverse of `encodeVLQ` in src/system/sourcemap-v3.ts. */
function decodeVLQField(str: string, pos: { i: number }): number {
  let result = 0;
  let shift = 0;
  let more: boolean;
  do {
    const digit = B64.indexOf(str[pos.i++]!);
    expect(digit, `invalid base64-VLQ char in "${str}" at ${pos.i - 1}`).toBeGreaterThanOrEqual(0);
    more = (digit & 0x20) !== 0;
    result += (digit & 0x1f) << shift;
    shift += 5;
  } while (more);
  return result & 1 ? -(result >> 1) : result >> 1;
}

interface DecodedSegment {
  genLine: number; // 0-based
  genCol: number;
  sourceIndex: number;
  sourceLine: number;
  sourceCol: number;
}

/** Decode a full v3 `mappings` string into absolute (delta-resolved)
 *  segments, replicating the running-total rules the spec defines:
 *  `genCol` resets to 0 every line; `sourceIndex`/`sourceLine`/`sourceCol`
 *  carry over across the whole mappings string. */
function decodeMappings(mappings: string): DecodedSegment[] {
  const segments: DecodedSegment[] = [];
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceCol = 0;
  const lines = mappings.split(";");
  for (let li = 0; li < lines.length; li++) {
    let genCol = 0;
    const line = lines[li]!;
    if (line === "") continue;
    for (const seg of line.split(",")) {
      const pos = { i: 0 };
      const fields: number[] = [];
      while (pos.i < seg.length) fields.push(decodeVLQField(seg, pos));
      expect(fields.length, `segment "${seg}" on line ${li} has an unexpected field count`).toBe(4);
      genCol += fields[0]!;
      sourceIndex += fields[1]!;
      sourceLine += fields[2]!;
      sourceCol += fields[3]!;
      segments.push({ genLine: li, genCol, sourceIndex, sourceLine, sourceCol });
    }
  }
  return segments;
}

describe("Source Map v3 sidecars", () => {
  it("emits valid Source Map v3 sidecars for the node backend", async () => {
    const { model, sourceTexts } = await parseWithSourceTexts(SOURCE);
    const [sourcePath] = sourceTexts.keys();
    const files = generateSystems(model, {
      sourcemap: true,
      sourceTexts,
    }).files;

    const tsPath = "hono_api/domain/order.ts";
    const mapPath = `${tsPath}.map`;
    const raw = files.get(mapPath);
    expect(raw, `${mapPath} not emitted`).toBeDefined();

    const v3 = JSON.parse(raw!) as {
      version: number;
      file: string;
      sources: string[];
      sourcesContent: string[];
      names: unknown[];
      mappings: string;
    };
    expect(v3.version).toBe(3);
    expect(v3.file).toBe("order.ts");
    expect(v3.sources).toContain(sourcePath);
    const sourceIdx = v3.sources.indexOf(sourcePath!);
    expect(v3.sourcesContent[sourceIdx]).toBe(SOURCE);

    const segments = decodeMappings(v3.mappings);
    expect(segments.length).toBeGreaterThan(0);
    for (const seg of segments) {
      expect(seg.sourceIndex).toBeGreaterThanOrEqual(0);
      expect(seg.sourceIndex).toBeLessThan(v3.sources.length);
    }

    // Cross-check against `.loom/sourcemap.json`'s own regions.  Before M15
    // phase 7 slice 2, the `let` statement's WHOLE-LINE region was the only
    // (and so the "narrowest") one covering its generated line, and the v3
    // segment pointed at the whole `let note = customerName` statement span.
    // Span-tracking emission now ALSO records a finer, `targetCol`-bearing
    // region for the RHS `customerName` ref alone (src/generator/typescript/
    // emit/aggregate.ts's opFragments loop, via `statementExprMarks` +
    // `renderExprWithMarks`'s level-wise anchoring) — a region with
    // `targetCol` takes priority in `renderSourceMapV3`'s per-line loop, so
    // the v3 segment for this line now points at the REAL generated column
    // of `this._customerName`, resolving back to the exact `customerName`
    // token (not merely the `let` statement's start).
    const tsContent = files.get(tsPath)!;
    const wireRaw = files.get(".loom/sourcemap.json")!;
    const wireMap = JSON.parse(wireRaw) as {
      files: Record<
        string,
        { target: [number, number]; construct?: string; targetCol?: [number, number] }[]
      >;
    };
    const stmtRegions = wireMap.files[tsPath]!.filter(
      (r) => r.construct === "Orders.Order.confirm",
    ).sort((a, b) => a.target[0] - b.target[0]);
    expect(stmtRegions.length).toBeGreaterThan(0);
    const fineRegion = stmtRegions.find((r) => r.targetCol);
    expect(
      fineRegion,
      "expected a targetCol-bearing region on confirm()'s let statement",
    ).toBeDefined();
    const letLine = fineRegion!.target[0]; // 1-based generated line
    expect(fineRegion!.target[0]).toBe(fineRegion!.target[1]); // single-line region

    const seg = segments.find((s) => s.genLine === letLine - 1);
    expect(seg, `no v3 segment recorded for generated line ${letLine}`).toBeDefined();

    // Recompute the expected generated column straight from the emitted TS
    // content — `this._customerName`'s own real 0-based column on that line
    // — rather than trusting the implementation to have gotten it right.
    const genLineText = tsContent.split("\n")[letLine - 1]!;
    const genCol0 = genLineText.indexOf("this._customerName");
    expect(genCol0).toBeGreaterThanOrEqual(0);
    expect(seg!.genCol).toBe(genCol0);
    // The wire artifact's own `targetCol` agrees (1-based, half-open) — the
    // `.loom/sourcemap.json` half of the brief's proof.
    expect(fineRegion!.targetCol).toEqual([genCol0 + 1, genCol0 + 1 + "this._customerName".length]);

    // The SOURCE side: the SECOND `customerName` occurrence (the field
    // DECLARATION is the first; `operation confirm`'s `let` RHS is the one
    // this mark must resolve to).
    const nameIdx = SOURCE.indexOf("customerName", SOURCE.indexOf("operation confirm"));
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    const expectedSourceLine = SOURCE.slice(0, nameIdx).split("\n").length - 1; // 0-based
    const expectedSourceCol = nameIdx - SOURCE.lastIndexOf("\n", nameIdx) - 1; // 0-based
    expect(seg!.sourceLine).toBe(expectedSourceLine);
    expect(seg!.sourceCol).toBe(expectedSourceCol);
    expect(seg!.sourceIndex).toBe(sourceIdx);

    // Exactly one trailing directive line naming the sidecar's basename.
    expect(tsContent.endsWith("//# sourceMappingURL=order.ts.map\n")).toBe(true);
  });

  it("without sourceTexts, flag-on emits no v3 sidecars (honest skip)", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;

    expect([...files.keys()].some((p) => p.endsWith(".map"))).toBe(false);
    for (const content of files.values()) {
      expect(content).not.toContain("//# sourceMappingURL=");
    }
  });

  // M8 free ride: the v3 loop (src/system/index.ts) walks every RECORDED
  // `.ts`/`.tsx` path with no per-frontend code of its own — once the react
  // generator records its `.tsx` page regions (M8), a react page picks up a
  // `.map` sidecar + trailing directive exactly like a Hono `.ts` file does,
  // with zero new code in the v3 loop itself.
  it("free-rides the v3 loop for a react .tsx page when both sourcemap and sourceTexts are passed", async () => {
    const { model, sourceTexts } = await parseWithSourceTexts(SOURCE);
    const files = generateSystems(model, { sourcemap: true, sourceTexts }).files;

    const tsxPath = "react_app/src/pages/orders/list.tsx";
    const mapPath = `${tsxPath}.map`;
    const raw = files.get(mapPath);
    expect(raw, `${mapPath} not emitted`).toBeDefined();

    const v3 = JSON.parse(raw!) as { version: number; file: string; sources: string[] };
    expect(v3.version).toBe(3);
    expect(v3.file).toBe("list.tsx");

    const tsxContent = files.get(tsxPath)!;
    expect(tsxContent.endsWith("//# sourceMappingURL=list.tsx.map\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JSR-45 SMAP sidecars (Milestone 10 phase 6b, source-map-and-debugging.md
// §9) — the java backend's own debugger artifact.  Unlike the v3 loop
// (which appends a trailing directive to the mapped file itself), the
// `.java` source is untouched; the sidecar is a standalone `<file>.smap`
// text document, consumed at BUILD time by the emitted `injectSmap` Gradle
// task (src/generator/java/emit/program.ts) rather than by anything reading
// the `.java` file at runtime.
// ---------------------------------------------------------------------------

describe("JSR-45 SMAP sidecars (java)", () => {
  it("emits a .smap sidecar for the java backend's Order.java naming the Loom stratum", async () => {
    const { model, sourceTexts } = await parseWithSourceTexts(SOURCE);
    const files = generateSystems(model, { sourcemap: true, sourceTexts }).files;

    const javaPath = "java_api/src/main/java/com/loom/javaapi/features/orders/Order.java";
    expect(files.has(javaPath), `expected ${javaPath} in output`).toBe(true);
    const smapPath = `${javaPath}.smap`;
    const raw = files.get(smapPath);
    expect(raw, `${smapPath} not emitted`).toBeDefined();

    expect(raw!.startsWith("SMAP\n")).toBe(true);
    const lines = raw!.split("\n");
    expect(lines[1]).toBe("Order.java");
    expect(lines[2]).toBe("Loom");
    expect(lines).toContain("*S Loom");
    expect(lines).toContain("*F");
    expect(lines).toContain("*L");
    expect(raw!.trimEnd().endsWith("*E")).toBe(true);

    // The `let note = customerName` statement's own *L entry names the
    // exact .ddd input line it sits on (computed independently from SOURCE,
    // the same way the v3 sidecar test cross-checks its segment).
    const letIdx = SOURCE.indexOf("let note = customerName");
    expect(letIdx).toBeGreaterThanOrEqual(0);
    const expectedDdlLine = SOURCE.slice(0, letIdx).split("\n").length; // 1-based
    const lEntries = lines.slice(lines.indexOf("*L") + 1, lines.indexOf("*E"));
    expect(
      lEntries.some((e) => e.startsWith(`${expectedDdlLine}#`)),
      `no *L entry for .ddd line ${expectedDdlLine} in:\n${lEntries.join("\n")}`,
    ).toBe(true);
  });

  it("without sourceTexts, flag-on emits no .smap sidecars (honest skip)", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;

    expect([...files.keys()].some((p) => p.endsWith(".smap"))).toBe(false);
  });

  it("emits the fenced injectSmap Gradle block in java_api/build.gradle.kts whenever the recorder is present, even without sourceTexts", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;

    const content = files.get("java_api/build.gradle.kts")!;
    expect(content).toContain("// loom:sourcemap-begin");
    expect(content).toContain("// loom:sourcemap-end");
    expect(content).toContain('classpath("org.ow2.asm:asm:');
    expect(content).toContain('tasks.register("injectSmap")');
    expect(content).toContain('tasks.named("compileJava") { finalizedBy("injectSmap") }');
    expect(content).toContain('tasks.named("bootJar") { dependsOn("injectSmap") }');
  });
});
