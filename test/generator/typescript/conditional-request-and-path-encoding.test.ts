// Two halves of the same client/server contract that were each only half-wired.
//
// 1. OPTIMISTIC CONCURRENCY (`versioned`).  Every update route READ `If-Match`
//    — but no response ever carried an `ETag`, and no generated frontend ever
//    sent `If-Match`.  So the conditional-write path was undiscoverable, and
//    `expectedVersion` always fell back to the version the server had just
//    loaded, which defeats the point: the race being guarded is the one across
//    the user's THINK TIME, between the read and the write.  Worse, the header
//    was parsed with a bare `Number(ifMatch)` — and an entity-tag is a QUOTED
//    string, so a client echoing the tag correctly (`If-Match: "3"`) produced
//    `NaN`, matched no row, and got a spurious 409 for doing the right thing.
//
// 2. PATH ENCODING.  71 interpolations of a caller-supplied id into a client
//    URL, and `encodeURIComponent` appeared zero times in generated source.
//    Harmless while every id is a UUID; not harmless for a `string` id or a
//    find argument, where a `/` silently re-routes the request and a `?`
//    truncates the path into a query string.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

async function emit(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  // Assert the fixture actually parsed + validated.  A swallowed parse error
  // here would leave the emitted set half-formed and every assertion below
  // would be testing nothing (experience_gathered.md §59).
  expect(doc.parseResult.parserErrors.map((e) => e.message)).toEqual([]);
  expect((doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message)).toEqual([]);
  return generateSystems(doc.parseResult.value as Model).files;
}

const SRC = (caps: string) => `
system Acme {
  subdomain Core {
    context Orders {
      aggregate Order with crudish${caps} { code: string  status: string }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Core
  ui Console with scaffold(aggregates: [Order]) {
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: node
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 3000
  }
  deployable web {
    platform: react
    targets: api
    ui: Console
    port: 5173
  }
}
`;

// The one shape `versioned` does NOT default onto: an event-sourced aggregate.
const ES_SRC = `
system Ledger {
  subdomain Core {
    context Accounts {
      event Renamed { account: Account id, code: string }
      aggregate Account persistedAs: eventLog {
        code: string
        create open(code: string) { emit Renamed { account: id, code: code } }
        operation rename(newCode: string) { emit Renamed { account: id, code: newCode } }
        apply(e: Renamed) { code := e.code }
      }
      repository Accounts for Account { }
    }
  }
  api AccountsApi from Core
  storage primary { type: postgres }
  resource accountsLog { for: Accounts, kind: eventLog, use: primary }
  deployable api {
    platform: node
    contexts: [Accounts]
    dataSources: [accountsLog]
    serves: AccountsApi
    port: 3000
  }
}
`;

const fileEndingWith = (files: Map<string, string>, suffix: string): string => {
  const hit = [...files.entries()].find(([p]) => p.endsWith(suffix))?.[1];
  expect(hit, `file ending ${suffix}`).toBeDefined();
  return hit as string;
};

describe("conditional requests — ETag out, If-Match in", () => {
  it("a versioned aggregate's by-id read publishes the tag the write expects back", async () => {
    const files = await emit(SRC(", versioned"));
    const routes = fileEndingWith(files, "http/order.routes.ts");
    // The read hands the client a tag...
    expect(routes).toContain('c.header("etag", versionETag(found.version));');
    // ...and the write parses the header it gets back through the shared
    // helper, NOT `Number(...)` on a quoted string.
    expect(routes).toContain("const expectedVersion = parseIfMatch(ifMatch, aggregate.version);");
    expect(routes).not.toContain("Number(ifMatch)");
    // Both helpers are imported (the import list is patched by usage).
    expect(routes).toMatch(/import \{[^}]*\bparseIfMatch\b[^}]*\} from "\.\/problem-details";/);
    expect(routes).toMatch(/import \{[^}]*\bversionETag\b[^}]*\} from "\.\/problem-details";/);
  });

  it("parseIfMatch accepts the RFC forms and rejects the rest with a 400", async () => {
    const files = await emit(SRC(", versioned"));
    const problem = fileEndingWith(files, "http/problem-details.ts");
    expect(problem).toContain("export function versionETag(version: number): string {");
    expect(problem).toContain('return `"${version}"`;');
    expect(problem).toContain("export function parseIfMatch(");
    // `*` is "any current representation" — no precondition.
    expect(problem).toContain('if (raw === "*") return current;');
    // Strong `"3"`, weak `W/"3"` and the legacy bare `3`; nothing else.
    expect(problem).toContain('const match = /^(?:W\\/)?(?:"(\\d+)"|(\\d+))$/.exec(raw);');
    // A malformed value is a CLIENT error, not a silent NaN that turns into a
    // spurious 409 further down.
    expect(problem).toContain("throw new HTTPException(400, {");

    // Behavioural check on the emitted source itself: run the two helpers.
    // Run the EMITTED source, not a transliteration of it — a hand-copied
    // reimplementation here would keep passing after the emitter regressed.
    // Only the two signatures carry TypeScript syntax, so erasing those makes
    // the block runnable while every line under test stays the emitted one.
    const declared = problem
      .slice(problem.indexOf("export function versionETag"))
      .split("/** Factory:")[0]!;
    const block = declared
      .replace(
        "export function versionETag(version: number): string {",
        "function versionETag(version) {",
      )
      .replace(
        "export function parseIfMatch(header: string | undefined, current: number): number {",
        "function parseIfMatch(header, current) {",
      );
    expect(block, "both signatures erased").not.toContain("export function");
    const fn = new Function("HTTPException", `${block}\n return { versionETag, parseIfMatch };`);
    class FakeHttpException extends Error {
      constructor(readonly status: number) {
        super("http");
      }
    }
    const { versionETag, parseIfMatch } = fn(FakeHttpException) as {
      versionETag: (v: number) => string;
      parseIfMatch: (h: string | undefined, cur: number) => number;
    };
    expect(versionETag(3)).toBe('"3"');
    // The round trip that used to produce NaN → a spurious 409.
    expect(parseIfMatch(versionETag(3), 99)).toBe(3);
    expect(parseIfMatch('W/"3"', 99)).toBe(3);
    expect(parseIfMatch("3", 99)).toBe(3);
    expect(parseIfMatch("*", 99)).toBe(99);
    expect(parseIfMatch(undefined, 99)).toBe(99);
    for (const bad of ['"3', 'x"3"', '"abc"', "", "3, 4"]) {
      expect(() => parseIfMatch(bad, 99), `If-Match: ${bad}`).toThrow(FakeHttpException);
    }
  });

  it("a project with no versioned aggregate pays nothing for the feature", async () => {
    // `versioned` is DEFAULT-ON (the expander applies it to every aggregate
    // that is not event-sourced), and an event-sourced aggregate is exactly the
    // exclusion: its append-only `(stream_id, version)` stream IS its
    // concurrency control, so there is no state-table `version` to tag.  That
    // makes this the one shape where the helpers must not be emitted — the
    // "the feature off pays nothing" rule the rest of the emitters follow.
    const files = await emit(ES_SRC);
    const problem = fileEndingWith(files, "http/problem-details.ts");
    expect(problem).not.toContain("versionETag");
    expect(problem).not.toContain("parseIfMatch");
    const routes = fileEndingWith(files, "http/account.routes.ts");
    expect(routes).not.toContain('c.header("etag"');
  });
});

describe("path parameters are percent-encoded in the generated client", () => {
  it("every id interpolated into a client URL goes through seg()", async () => {
    const files = await emit(SRC(""));
    const client = fileEndingWith(files, "src/api/client.ts");
    expect(client).toContain(
      "export const seg = (value: string | number): string => encodeURIComponent(String(value));",
    );

    const mod = fileEndingWith(files, "src/api/order.ts");
    expect(mod).toContain('import { api, seg } from "./client";');
    // The by-id read, the destroy and every operation POST.
    expect(mod).toContain("await api.get(`/orders/${seg(id)}`)");
    expect(mod).toContain("await api.delete(`/orders/${seg(id)}`)");
    // No raw interpolation of an id into a path survives anywhere in the module.
    expect(mod).not.toMatch(/`\/orders\/\$\{id\}/);
  });

  it("seg leaves a UUID byte-identical but neutralises a path-breaking id", () => {
    // The emitted helper is one expression; assert on its semantics directly so
    // the test says WHY the encoding matters rather than only that it is there.
    const seg = (value: string | number): string => encodeURIComponent(String(value));
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    expect(seg(uuid)).toBe(uuid);
    // Without encoding these three reach a different endpoint than the caller
    // asked for — a re-route, a truncation, and a dropped fragment.
    expect(seg("a/b")).toBe("a%2Fb");
    expect(seg("a?b=1")).toBe("a%3Fb%3D1");
    expect(seg("a#b")).toBe("a%23b");
  });
});
