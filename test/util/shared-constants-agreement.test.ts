import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Platform, SavingShape } from "../../src/ir/types/loom-ir.js";
import { AUDIT_HISTORY_FIND as AUDIT_HISTORY_FIND_REEXPORT } from "../../src/ir/util/audit-history.js";
import { platformSavingShapes } from "../../src/language/validators/data/platform-rules.js";
import { allPlatformDescriptors, frontendPlatformNames } from "../../src/platform/metadata.js";
import {
  API_BASE_PATH,
  AUTH_BASE_PATH,
  apiRoutePrefix,
  KEYCLOAK_HOST_PORT,
} from "../../src/util/api-base.js";
import { AUDIT_HISTORY_FIND } from "../../src/util/audit-names.js";
import { CAPABILITIES_TAG, FILTER_ORIGIN_TAG } from "../../src/util/capability-tag.js";
import { RENDERABLE_FILTER_PRIMITIVES } from "../../src/util/filter-param-kinds.js";
import { PLATFORM_SAVING_SHAPES } from "../../src/util/platform-axes.js";
import {
  PRINCIPAL_ORG_PATH,
  PRINCIPAL_ROOT_ORG,
  PRINCIPAL_TYPE_NAME,
  principalIdField,
} from "../../src/util/principal.js";

// ---------------------------------------------------------------------------
// A shared constant is, on its own, untestable: `expect(X).toBe("x")` restates
// the definition.  What IS testable — and what actually rots — is the claim
// each of these constants makes in its own doc comment about being the SINGLE
// SOURCE OF TRUTH for some code that lives elsewhere.  Every test below is that
// agreement, never the constant's value in isolation:
//
//   (a) filter-param-kinds.ts  ⇄  the `filterParamKind` switch in the scaffold
//                                 macro (`_body-builders.ts`)
//   (b) platform-axes.ts       ⇄  the `Platform` / `SavingShape` IR vocabulary
//                                 and the platform descriptor table
//   (c) api-base.ts            ⇄  itself (derived paths) and the compose
//                                 emitter's Keycloak host port
//   (d) principal.ts           ⇄  the five backends' auth emitters
//   (e) capability-tag.ts /    ⇄  the expander / lowering / emitter sites that
//       audit-names.ts             spell the same key
//
// Several of these reach into module source text.  That is deliberate: the code
// under test is module-private (`filterParamKind`) or lives inside an emitter's
// template string (the `rootOrg` derivations), and a hand-copied duplicate of it
// here would be the very drift the test claims to prevent.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), "utf8");

// ===========================================================================
// (a) RENDERABLE_FILTER_PRIMITIVES ⇄ filterParamKind
// ===========================================================================

const BODY_BUILDERS = "src/macros/stdlib/scaffold/_body-builders.ts";

/** The primitive names `filterParamKind` returns a NON-NULL kind for — read
 *  out of its `switch (type.base.name)`.  Every `case` in that switch falls
 *  into a `return "<kind>"`; the only `null` is its `default`. */
function filterParamKindCases(): string[] {
  const src = read(BODY_BUILDERS);
  const start = src.indexOf("function filterParamKind(");
  expect(start, `filterParamKind not found in ${BODY_BUILDERS}`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  const fn = src.slice(start, end);
  const sw = fn.slice(fn.indexOf("switch ("));
  // Everything before `default:` returns a kind; nothing after it does.
  const arms = sw.slice(0, sw.indexOf("default:"));
  return [...arms.matchAll(/case "([a-zA-Z]+)":/g)].map((m) => m[1]!);
}

/** The `PrimitiveType` name alternatives in the grammar. */
function grammarPrimitives(): string[] {
  const src = read("src/language/ddd.langium");
  const m = /PrimitiveType:\s*\n\s*name=\(([^)]*)\)/.exec(src);
  expect(m, "PrimitiveType rule not found in ddd.langium").not.toBeNull();
  return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

describe("(a) RENDERABLE_FILTER_PRIMITIVES agrees with `filterParamKind`", () => {
  it("every listed name is a `case` the macro's switch returns a kind for", () => {
    // The subset direction: a name here that the macro drops would put a filter
    // input in the scaffolded bar with nothing behind it.
    const cases = new Set(filterParamKindCases());
    for (const name of RENDERABLE_FILTER_PRIMITIVES) {
      expect(cases.has(name), `"${name}" is listed but has no arm in filterParamKind`).toBe(true);
    }
  });

  it("every kind-returning `case` is listed here", () => {
    // The other direction: a macro arm not listed here would make the IR check
    // `loom.scaffold-filter-param-unsupported` report a param the bar DID render.
    for (const name of filterParamKindCases()) {
      expect(
        RENDERABLE_FILTER_PRIMITIVES.has(name),
        `filterParamKind renders "${name}" but it is not in RENDERABLE_FILTER_PRIMITIVES`,
      ).toBe(true);
    }
  });

  it("the two sets are therefore equal", () => {
    expect([...RENDERABLE_FILTER_PRIMITIVES].sort()).toEqual(
      [...new Set(filterParamKindCases())].sort(),
    );
  });

  it("the deliberately held-back names are absent (decimal / money / enum)", () => {
    // `decimal` / `money`: the `0` unset sentinel does not type-check on Feliz.
    // `enum`: every frontend types an enum-valued state field as bare `string`
    //         while the query param is the zod enum union (TS2322).
    for (const held of ["decimal", "money", "enum"]) {
      expect(RENDERABLE_FILTER_PRIMITIVES.has(held), `"${held}" must stay held back`).toBe(false);
    }
  });

  it("`decimal` and `money` are real grammar primitives, so their absence is a CHOICE", () => {
    // Guards against the set drifting into vacuous correctness: if these ever
    // stopped being primitives, "absent" would prove nothing.
    const prims = grammarPrimitives();
    expect(prims).toContain("decimal");
    expect(prims).toContain("money");
    // `enum` is NOT a PrimitiveType — an enum-typed param arrives as a
    // `NamedType` and is rejected one branch earlier, before the switch.
    expect(prims).not.toContain("enum");
  });

  it("every listed name is a real grammar primitive", () => {
    const prims = new Set(grammarPrimitives());
    for (const name of RENDERABLE_FILTER_PRIMITIVES) {
      expect(prims.has(name), `"${name}" is not a PrimitiveType in the grammar`).toBe(true);
    }
  });

  it("the non-primitive `ref` arm is keyed off IdType, not a primitive name", () => {
    // Documented: "An `X id` param IS renderable … so it is not a primitive-name
    // question".  Pinned so the `ref` kind never leaks into this NAME set.
    const src = read(BODY_BUILDERS);
    expect(src).toContain('if (type.base.$type === "IdType") return "ref";');
    expect(RENDERABLE_FILTER_PRIMITIVES.has("ref")).toBe(false);
    expect(RENDERABLE_FILTER_PRIMITIVES.has("id")).toBe(false);
  });
});

// ===========================================================================
// (b) PLATFORM_SAVING_SHAPES ⇄ the Platform / SavingShape vocabulary
// ===========================================================================

const ALL_SAVING_SHAPES: readonly SavingShape[] = ["relational", "embedded", "document"];

describe("(b) PLATFORM_SAVING_SHAPES keys and values are real vocabulary", () => {
  it("every key is a real `Platform`", () => {
    const known = new Set(allPlatformDescriptors().map((d) => d.name));
    // The descriptor table de-dupes the shared react/`static` surface, so add
    // the alias keys back from the table's own key space.
    for (const name of frontendPlatformNames()) known.add(name as Platform);
    for (const key of Object.keys(PLATFORM_SAVING_SHAPES)) {
      expect(known.has(key as Platform), `"${key}" is not a registered platform`).toBe(true);
    }
  });

  it("every key is a BAREWORD family, never a `family@version` pin", () => {
    // Documented: "Keyed by the bareword family (a `family@version` pin resolves
    // via `platformFamily` in the validator)".
    for (const key of Object.keys(PLATFORM_SAVING_SHAPES)) {
      expect(key).not.toContain("@");
    }
  });

  it("every listed shape is a real `SavingShape`", () => {
    for (const [platform, shapes] of Object.entries(PLATFORM_SAVING_SHAPES)) {
      expect(shapes, `${platform} has no shape list`).toBeDefined();
      for (const shape of shapes!) {
        expect(ALL_SAVING_SHAPES).toContain(shape);
      }
    }
  });

  it("no platform lists a shape twice, and none lists an empty set", () => {
    for (const [platform, shapes] of Object.entries(PLATFORM_SAVING_SHAPES)) {
      expect(shapes!.length, `${platform} lists no shapes at all`).toBeGreaterThan(0);
      expect([...new Set(shapes!)], platform).toEqual([...shapes!]);
    }
  });

  it("every FRONTEND platform is absent — frontends own no persistence", () => {
    // Documented: "Frontend platforms (`react`/`static`) own no persistence and
    // are omitted".  Derived from the descriptor table so a new frontend is
    // covered without editing this test.
    for (const name of frontendPlatformNames()) {
      expect(
        Object.hasOwn(PLATFORM_SAVING_SHAPES, name),
        `frontend "${name}" must not carry a saving-shape row`,
      ).toBe(false);
    }
  });

  it("every BACKEND platform carries a row (no backend is silently shapeless)", () => {
    const backends = allPlatformDescriptors()
      .filter((d) => !d.isFrontend)
      .map((d) => d.name);
    expect(backends.length).toBeGreaterThanOrEqual(5);
    for (const name of backends) {
      expect(
        Object.hasOwn(PLATFORM_SAVING_SHAPES, name),
        `backend "${name}" has no saving-shape row`,
      ).toBe(true);
    }
  });

  it("every backend supports `relational` (the default shape)", () => {
    for (const shapes of Object.values(PLATFORM_SAVING_SHAPES)) {
      expect(shapes).toContain("relational");
    }
  });

  it("the elixir row's documented widening still lives in the validator", () => {
    // The row deliberately omits `document`; `validateSavingShapeSupport`
    // unconditionally widens it before checking, so reading the row alone would
    // tell you the opposite of what ships.  Pin the widening's existence — if it
    // is ever folded into the table the comment must go with it.
    expect(PLATFORM_SAVING_SHAPES.elixir).not.toContain("document");
    expect(read("src/ir/validate/checks/system-checks.ts")).toContain(
      'dep.platform === "elixir" ? ([...base, "document"] as readonly SavingShape[]) : base',
    );
  });

  it("the sole consumer reads the table through `platformSavingShapes`", () => {
    // The validator-side accessor is the only reader; it must hand back the
    // very row, so a table edit lands in the check with nothing in between.
    for (const key of Object.keys(PLATFORM_SAVING_SHAPES)) {
      expect(platformSavingShapes(key), key).toBe(PLATFORM_SAVING_SHAPES[key as Platform]);
    }
  });

  it("a `family@version` pin resolves to its family's row", () => {
    // Documented: "a `family@version` pin resolves via `platformFamily` in the
    // validator" — which is why the table may stay keyed by bareword.
    expect(platformSavingShapes("node@v5")).toBe(PLATFORM_SAVING_SHAPES.node);
    expect(platformSavingShapes("node@v4")).toBe(PLATFORM_SAVING_SHAPES.node);
    expect(platformSavingShapes("dotnet@v10")).toBe(PLATFORM_SAVING_SHAPES.dotnet);
  });

  it("the accessor is undefined for every frontend platform and for junk", () => {
    for (const name of frontendPlatformNames()) {
      expect(platformSavingShapes(name), name).toBeUndefined();
    }
    expect(platformSavingShapes(undefined)).toBeUndefined();
    expect(platformSavingShapes("not-a-platform")).toBeUndefined();
  });
});

// ===========================================================================
// (c) api-base.ts — the derived paths and the reserved Keycloak port
// ===========================================================================

describe("(c) api-base derived paths agree with API_BASE_PATH", () => {
  it("API_BASE_PATH has a leading slash and no trailing slash", () => {
    expect(API_BASE_PATH.startsWith("/")).toBe(true);
    expect(API_BASE_PATH.endsWith("/")).toBe(false);
  });

  it("AUTH_BASE_PATH is exactly API_BASE_PATH + `/auth`", () => {
    expect(AUTH_BASE_PATH).toBe(`${API_BASE_PATH}/auth`);
    // Documented consequence: one `/api → backend` proxy rule covers auth too.
    expect(AUTH_BASE_PATH.startsWith(`${API_BASE_PATH}/`)).toBe(true);
  });

  it("apiRoutePrefix() is API_BASE_PATH with the leading slash dropped and a trailing one added", () => {
    expect(apiRoutePrefix()).toBe(`${API_BASE_PATH.slice(1)}/`);
    expect(apiRoutePrefix().startsWith("/")).toBe(false);
    expect(apiRoutePrefix().endsWith("/")).toBe(true);
  });

  it("apiRoutePrefix() round-trips back to API_BASE_PATH", () => {
    // The relative form ASP.NET's `[Route("api/…")]` / FastAPI's `prefix` need.
    expect(`/${apiRoutePrefix()}`.replace(/\/$/, "")).toBe(API_BASE_PATH);
  });

  it("the infra probes stay at the ROOT, not under the API base", () => {
    // Documented contrast: `/health` / `/ready` are hit directly by Docker/k8s.
    for (const probe of ["/health", "/ready"]) {
      expect(probe.startsWith(`${API_BASE_PATH}/`)).toBe(false);
    }
  });
});

describe("(c) KEYCLOAK_HOST_PORT vs the compose emitter's port assignment", () => {
  const COMPOSE = "src/system/index.ts";

  it("is the same starting port `keycloakHostPort` scans from", () => {
    // The emitter does not import the constant (it repeats the literal), so this
    // agreement is the only thing keeping the two from drifting apart.
    const src = read(COMPOSE);
    const fn = src.slice(src.indexOf("function keycloakHostPort("));
    const m = /let port = (\d+);/.exec(fn.slice(0, fn.indexOf("\n}")));
    expect(m, `no starting port found in keycloakHostPort (${COMPOSE})`).not.toBeNull();
    expect(Number(m![1])).toBe(KEYCLOAK_HOST_PORT);
  });

  it("the emitter steps past any port a deployable already publishes", () => {
    // The reason a raw collision is survivable today: `keycloakHostPort` scans
    // the deployables' ports and takes the first free one at or above the
    // constant.  Pinned because the `it.fails` below depends on it.
    const src = read(COMPOSE);
    const body = src.slice(src.indexOf("function keycloakHostPort("));
    const fn = body.slice(0, body.indexOf("\n}"));
    expect(fn).toContain("sys.deployables.map((d) => d.port)");
    expect(fn).toContain("while (used.has(port)) port++");
  });

  // DEFECT (handed off, not fixed here — this packet is test-only).
  //
  //   src/util/api-base.ts:36-41 — `KEYCLOAK_HOST_PORT = 8081`.
  //
  // Two problems, both visible from the constant's own doc comment:
  //
  //   1. It COLLIDES with a default deployable port: `java` is `defaultPort:
  //      8081` (src/platform/metadata.ts:259, src/platform/java.ts:28), so an
  //      auth-bundled system with a Java backend has both services aimed at
  //      host 8081.  The compose emitter survives it only by SCANNING
  //      (`keycloakHostPort`, src/system/index.ts:717-721 — "the Java backend's
  //      default port is also 8081"), i.e. the constant is not actually a
  //      reserved port, it is a starting point.
  //   2. It is ORPHANED.  The comment says it is "Shared here so the system
  //      compose emitter AND the IR-level host-port uniqueness validator agree",
  //      but NOTHING imports it: `src/system/index.ts:718` repeats the literal
  //      `8081` and `src/ir/validate/checks/system-checks.ts:1435-1437` only
  //      describes the behaviour in a comment.  `grep -rn KEYCLOAK_HOST_PORT
  //      src/` returns one hit — the declaration.
  //
  // PROPOSED PATCH: either (a) import the constant at both sites so the comment
  // becomes true —
  //     // src/system/index.ts
  //     import { KEYCLOAK_HOST_PORT } from "../util/api-base.js";
  //     let port = KEYCLOAK_HOST_PORT;
  //   and reword the comment from "reserved port" to "the port Keycloak scans
  //   UP FROM"; or (b) delete the constant and keep the literal at its single
  //   real use site.  (a) is preferred — it keeps one spelling and makes the
  //   java-collision note discoverable from the constant.
  it.fails("does not collide with any platform's default host port", () => {
    const collisions = allPlatformDescriptors()
      .filter((d) => d.defaultPort === KEYCLOAK_HOST_PORT)
      .map((d) => `${d.name}:${d.defaultPort}`);
    expect(collisions).toEqual([]);
  });

  it("records the current collision explicitly (java's default port is 8081)", () => {
    const clashing = allPlatformDescriptors()
      .filter((d) => d.defaultPort === KEYCLOAK_HOST_PORT)
      .map((d) => d.name);
    expect(clashing).toEqual(["java"]);
  });

  it("collides with no OTHER platform than java", () => {
    // The narrow property that does hold: exactly one backend clashes, and the
    // emitter's scan handles exactly that one.
    const clashing = allPlatformDescriptors().filter(
      (d) => d.defaultPort === KEYCLOAK_HOST_PORT && d.name !== "java",
    );
    expect(clashing).toEqual([]);
  });
});

// ===========================================================================
// (d) principal.ts — the principal names and the root-segment rule
// ===========================================================================

/** The root-segment rule `PRINCIPAL_ROOT_ORG` documents: "the first segment of
 *  `orgPath` (the substring before the first `.`, or the whole path when it has
 *  no `.`)".  The reference the emitted implementations are checked against. */
function rootSegment(orgPath: string): string {
  const i = orgPath.indexOf(".");
  return i === -1 ? orgPath : orgPath.slice(0, i);
}

const ROOT_SEGMENT_CASES: ReadonlyArray<readonly [string, string]> = [
  ["a.b.c", "a"],
  ["a", "a"],
  ["", ""],
  ["acme.emea.paris", "acme"],
  ["acme.", "acme"],
  [".b", ""], // a leading dot means an EMPTY root segment, not "b"
  ["a..b", "a"],
];

describe("(d) principal — the documented root-segment rule", () => {
  it("takes the substring before the first `.`, else the whole path", () => {
    for (const [input, expected] of ROOT_SEGMENT_CASES) {
      expect(rootSegment(input), JSON.stringify(input)).toBe(expected);
    }
  });

  it("is idempotent — a root segment is its own root segment", () => {
    for (const [input] of ROOT_SEGMENT_CASES) {
      expect(rootSegment(rootSegment(input))).toBe(rootSegment(input));
    }
  });

  it("under FLAT tenancy (`orgPath` has no dot) rootOrg == orgPath", () => {
    // Documented: "under flat tenancy `orgPath` is the root-segment claim, so
    // `rootOrg == orgPath`".
    for (const flat of ["acme", "tenant-1", "", "a"]) {
      expect(rootSegment(flat)).toBe(flat);
    }
  });

  it("the Hono emitter emits exactly this rule", () => {
    // Extracted verbatim rather than transliterated: this is the real emitted
    // helper, and a change to it fails here instead of only in a compose e2e.
    const src = read("src/platform/hono/v4/auth-emit.ts");
    const start = src.indexOf("function rootOrgOf(orgPath: string): string {");
    expect(start, "rootOrgOf not found in the hono auth emitter").toBeGreaterThanOrEqual(0);
    const body = src.slice(start, src.indexOf("\n}", start) + 2);
    expect(body.replace(/\s+/g, " ").trim()).toBe(
      'function rootOrgOf(orgPath: string): string { const i = orgPath.indexOf("."); return i === -1 ? orgPath : orgPath.slice(0, i); }',
    );
  });

  it("every backend's auth emitter derives the root segment from the FIRST dot", () => {
    // Five independent implementations of one rule (TS `indexOf`, C#
    // `IndexOf`, Java `indexOf`, Python `split(".", 1)[0]`, Elixir
    // `:binary.split(path, ".")`).  Pinned as a set so a backend that quietly
    // switches to `lastIndexOf` / an unbounded `split` is caught here.
    const sites: ReadonlyArray<readonly [string, RegExp]> = [
      ["src/platform/hono/v4/auth-emit.ts", /orgPath\.indexOf\("\."\)/],
      ["src/generator/dotnet/auth-emit.ts", /OrgPath\.IndexOf\('\.'\)/],
      ["src/generator/java/emit/auth.ts", /path\.indexOf\('\.'\)/],
      ["src/generator/python/auth-emit.ts", /org_path\.split\("\\?\."?, 1\)\[0\]/],
      ["src/generator/elixir/auth-emit.ts", /:binary\.split\(path, "\."\)/],
    ];
    for (const [file, pattern] of sites) {
      expect(read(file), `${file} no longer derives rootOrg from the first dot`).toMatch(pattern);
    }
  });
});

describe("(d) principal — the member names every backend spells", () => {
  it("the derived member names are the ones the emitters hardcode", () => {
    // The emitters do NOT import these constants (they are baked into template
    // strings in each target language's casing), so a rename of the constant
    // would leave the emitters behind silently.  This is that tripwire.
    const camel: ReadonlyArray<readonly [string, string]> = [
      ["src/platform/hono/v4/auth-emit.ts", PRINCIPAL_ORG_PATH],
      ["src/platform/hono/v4/auth-emit.ts", PRINCIPAL_ROOT_ORG],
      ["src/generator/java/emit/auth.ts", PRINCIPAL_ORG_PATH],
      ["src/generator/java/emit/auth.ts", PRINCIPAL_ROOT_ORG],
    ];
    for (const [file, name] of camel) {
      expect(read(file), `${file} no longer spells "${name}"`).toContain(name);
    }
    // Snake-cased targets spell the same members with their own casing.
    expect(read("src/generator/python/auth-emit.ts")).toContain("root_org");
    expect(read("src/generator/python/auth-emit.ts")).toContain("org_path");
    expect(read("src/generator/elixir/auth-emit.ts")).toContain(":root_org");
    expect(read("src/generator/elixir/auth-emit.ts")).toContain(":org_path");
  });

  it("lowering and the type system gate BOTH derived members through the constants", () => {
    for (const file of [
      "src/ir/lower/lower-expr.ts",
      "src/language/type-system.ts",
      "src/language/validators/tenancy.ts",
    ]) {
      const src = read(file);
      expect(src, file).toContain("PRINCIPAL_ORG_PATH");
      expect(src, file).toContain("PRINCIPAL_ROOT_ORG");
    }
  });

  it("PRINCIPAL_TYPE_NAME is what the prelude's `auditable` stamps reference", () => {
    // `createdBy` / `updatedBy` are `User id` refs; a rename that missed the
    // prelude would produce an unresolvable id type.
    const prelude = read("src/macros/prelude.ts");
    expect(prelude).toContain("PRINCIPAL_TYPE_NAME");
    expect(prelude).toContain('field("createdBy", idRef(PRINCIPAL_TYPE_NAME)');
    expect(prelude).toContain('field("updatedBy", idRef(PRINCIPAL_TYPE_NAME)');
    // It is a plain PascalCase type name, usable as an `X id` target.
    expect(PRINCIPAL_TYPE_NAME).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });
});

describe("(d) principal — principalIdField", () => {
  it("prefers the field literally named `id`, wherever it is declared", () => {
    expect(principalIdField({ fields: [{ name: "sub" }, { name: "id" }] })).toBe("id");
    expect(principalIdField({ fields: [{ name: "id" }, { name: "sub" }] })).toBe("id");
  });

  it("falls back to the FIRST declared field when there is no `id`", () => {
    expect(principalIdField({ fields: [{ name: "sub" }, { name: "email" }] })).toBe("sub");
  });

  it("is null when there is no `user {}` block at all", () => {
    expect(principalIdField(undefined)).toBeNull();
  });

  it("is null for an empty field list", () => {
    expect(principalIdField({ fields: [] })).toBeNull();
  });

  it("is case-sensitive — `Id` is not `id` and takes the first-field path", () => {
    expect(principalIdField({ fields: [{ name: "sub" }, { name: "Id" }] })).toBe("sub");
  });

  it("the Java auditing emitter re-implements the SAME rule", () => {
    // src/generator/java/emit/jpa-auditing-config.ts:23 carries a private
    // duplicate ("the field named `id`, else the first declared field").  It is
    // not importable, so pin the rule's text there; the two must not diverge.
    const java = read("src/generator/java/emit/jpa-auditing-config.ts");
    expect(java).toContain('userFields.find((f) => f.name === "id") ?? userFields[0]');
  });
});

// ===========================================================================
// (e) capability-tag.ts / audit-names.ts ⇄ their consumers
// ===========================================================================

describe("(e) capability-tag — the transient AST annotation keys", () => {
  it("both keys are `$`-prefixed (the documented clone / reflection discipline)", () => {
    // A `$`-prefixed key is skipped by the AST-copy helpers and by Langium's
    // reflection.  Drop the `$` and the expander's `expandHost` re-scan
    // double-applies every typed capability.
    expect(CAPABILITIES_TAG.startsWith("$")).toBe(true);
    expect(FILTER_ORIGIN_TAG.startsWith("$")).toBe(true);
  });

  it("the two keys are distinct (they annotate different nodes)", () => {
    expect(CAPABILITIES_TAG).not.toBe(FILTER_ORIGIN_TAG);
  });

  it("neither collides with a Langium bookkeeping property", () => {
    // `$type`, `$container`, `$containerProperty`, `$containerIndex`,
    // `$cstNode`, `$document` are Langium's own; stashing under one of them
    // would corrupt the AST rather than annotate it.
    const langium = [
      "$type",
      "$container",
      "$containerProperty",
      "$containerIndex",
      "$cstNode",
      "$document",
      "$refText",
      "$ref",
    ];
    expect(langium).not.toContain(CAPABILITIES_TAG);
    expect(langium).not.toContain(FILTER_ORIGIN_TAG);
  });

  it("the `$`-prefix skip rule the discipline depends on is really implemented", () => {
    // src/macros/api/factories.ts skips `$`-prefixed keys when rebuilding a
    // node's bookkeeping; without that, these tags would survive into clones.
    const factories = read("src/macros/api/factories.ts");
    expect(factories).toContain('if (k.startsWith("$")) continue;');
  });

  it("the WRITER (expander) and both READERS go through the constants", () => {
    // Writer: phase ② macro expander.  Readers: phase ⑤ lowering (capabilities
    // + filter origins) and the language-layer seed validator.
    expect(read("src/macros/expander.ts")).toContain(
      'import { CAPABILITIES_TAG, FILTER_ORIGIN_TAG } from "../util/capability-tag.js";',
    );
    expect(read("src/ir/lower/lower-capabilities.ts")).toContain(
      'import { CAPABILITIES_TAG, FILTER_ORIGIN_TAG } from "../../util/capability-tag.js";',
    );
    expect(read("src/language/validators/seed.ts")).toContain("CAPABILITIES_TAG");
  });

  it("no consumer spells the literal key instead of importing it", () => {
    // A hardcoded "$loomCapabilities" would survive a rename of the constant
    // and silently stop matching what the expander writes.
    for (const file of [
      "src/macros/expander.ts",
      "src/ir/lower/lower-capabilities.ts",
      "src/language/validators/seed.ts",
    ]) {
      expect(read(file), file).not.toContain(`"${CAPABILITIES_TAG}"`);
      expect(read(file), file).not.toContain(`"${FILTER_ORIGIN_TAG}"`);
    }
  });
});

describe("(e) audit-names — AUDIT_HISTORY_FIND has exactly one spelling", () => {
  it("the `ir/util/audit-history.ts` re-export is the same value", () => {
    // Documented: "`ir/util/audit-history.ts` re-exports what it needs from
    // here, so its public surface is unchanged and there is still exactly one
    // spelling."  This is that claim, checked at runtime.
    expect(AUDIT_HISTORY_FIND_REEXPORT).toBe(AUDIT_HISTORY_FIND);
  });

  it("is a plain lowercase find name (it must be legal as a repository `find`)", () => {
    expect(AUDIT_HISTORY_FIND).toMatch(/^[a-z][A-Za-z0-9]*$/);
  });

  it("every consumer imports the constant instead of spelling the name", () => {
    // Five layers name this read: the scaffold macro (phase ②), the walker's
    // history-read detector, the frontend api-module hook name, the Feliz
    // wire/target pair, enrichment's synthesised find, and the AST validator's
    // reserved-op set.  A rename that missed ANY of them silently produces a
    // page calling an endpoint that is not emitted.
    const consumers = [
      "src/macros/stdlib/scaffold/_body-builders.ts",
      "src/generator/_walker/history-read.ts",
      "src/generator/_frontend/api-module.ts",
      "src/generator/feliz/wire.ts",
      "src/generator/feliz/feliz-target.ts",
      "src/ir/util/audit-history.ts",
      "src/ir/enrich/enrichments.ts",
      "src/language/validators/_shared.ts",
    ];
    for (const file of consumers) {
      const src = read(file);
      expect(src, `${file} does not use AUDIT_HISTORY_FIND`).toContain("AUDIT_HISTORY_FIND");
      // …and none of them re-spells the literal.
      expect(src, `${file} hardcodes "${AUDIT_HISTORY_FIND}"`).not.toContain(
        `=== "${AUDIT_HISTORY_FIND}"`,
      );
    }
  });

  it("the enrichment guard uses the constant, so an author-declared `history` still wins", () => {
    // Documented: "an author-declared find of the same name wins, exactly as
    // with `all`" — implemented as a skip-if-already-present guard.
    const enrich = read("src/ir/enrich/enrichments.ts");
    expect(enrich).toContain("repo.finds.some((f) => f.name === AUDIT_HISTORY_FIND)");
  });
});
