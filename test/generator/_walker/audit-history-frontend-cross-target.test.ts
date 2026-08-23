// ---------------------------------------------------------------------------
// Entity history, reachable from a real app — the api-client `history()` call
// and the scaffolded History section that consumes it, across every frontend.
//
// #2378 landed `GET /<agg>/{id}/history` and the `Timeline` primitive renders
// an `AuditEntry[]`, but neither made the trail reachable: the frontend clients
// iterate `repo.finds`, and the derived history read sits BESIDE it
// (`RepositoryIR.historyFind` — deliberate, since ~120 generic `finds`
// consumers assume a find reads the aggregate's own table at `/<name-snake>`).
// So the client had no method to call and the scaffold had nothing to render.
//
// Two claims are load-bearing here and BOTH are asserted, in both directions:
//
//   1. An `audited` aggregate gets `history(id)` on its client and a History
//      section on its scaffolded Detail page.
//   2. A NON-audited aggregate's output is UNCHANGED — no schema, no hook, no
//      section.  Asserted as a real byte-for-byte file diff between an audited
//      and a non-audited generation of the SAME system, not as a handful of
//      `not.toContain`s, because "byte-identical" is the actual promise.
//
// The frontend support matrix is asserted too, and it is NOT the same as
// `Timeline`'s: a target must also COLLECT the derived read, and all seven
// render paths now do — the four JS-family frontends over the api client,
// Phoenix/HEEx over an in-process `audit_records` scan (a LiveView hosts its
// contexts in the same OTP app, so it needs no client), Feliz over a
// page-entry-keyed `Remote<AuditEntry list>` fetch (`feliz/wire.ts`
// `felizHistoryRead`; positives in
// `test/generator/feliz/feliz-audit-history.test.ts`), and Flutter over a
// Riverpod `.family` provider decoding the `AuditEntry` wire model
// (`flutter/reads-emit.ts` + the `renderTimeline` fork in
// `flutter/flutter-target.ts`; positives in
// `test/generator/flutter/flutter-audit-history.test.ts`).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  HISTORY_CAPABLE_FRAMEWORKS,
  skipsEntityHistoryRead,
} from "../../../src/generator/_walker/history-read.js";
import { angularTarget } from "../../../src/generator/angular/walker/angular-target.js";
import { heexTarget } from "../../../src/generator/elixir/heex-target.js";
import { felizTarget } from "../../../src/generator/feliz/feliz-target.js";
import { flutterTarget } from "../../../src/generator/flutter/flutter-target.js";
import { tsxTarget } from "../../../src/generator/react/walker/tsx-target.js";
import { svelteTarget } from "../../../src/generator/svelte/walker/svelte-target.js";
import { vueTarget } from "../../../src/generator/vue/walker/vue-target.js";
import { generateSystemFiles } from "../../_helpers/index.js";

/** The same scaffolded system twice — `audited` on or off.  Everything else is
 *  identical, so any output difference is attributable to the audit trail. */
const scaffoldSystem = (frontend: string, audited: boolean): string => `
  system HistoryDemo {
    subdomain Ordering {
      context Ordering {
        aggregate Order ${audited ? "audited " : ""}with crudish {
          reference: string
          quantity: int
        }
        repository Orders for Order { }
      }
    }
    ui Web with scaffold(subdomains: [Ordering]) { }
    storage primary { type: postgres }
    resource orderingState { for: Ordering, kind: state, use: primary }
    deployable api {
      platform: node, contexts: [Ordering], dataSources: [orderingState], port: 3000
    }
    deployable web { platform: ${frontend}, targets: api, ui: Web, port: 3001 }
  }
`;

/** The Phoenix twin: LiveView is fullstack, so the scaffolded ui is hosted ON
 *  the elixir backend (no separate frontend deployable). */
const heexSystem = (audited: boolean): string => `
  system HistoryDemo {
    subdomain Ordering {
      context Ordering {
        aggregate Order ${audited ? "audited " : ""}with crudish {
          reference: string
          quantity: int
        }
        repository Orders for Order { }
      }
    }
    ui Web with scaffold(subdomains: [Ordering]) { }
    storage primary { type: postgres }
    resource orderingState { for: Ordering, kind: state, use: primary }
    deployable api {
      platform: elixir, contexts: [Ordering], dataSources: [orderingState], port: 3000, ui: Web
    }
  }
`;

const allFiles = (files: Map<string, string>): string => {
  let all = "";
  for (const content of files.values()) all += `\n${content}`;
  return all;
};

/** Every frontend-project path whose CONTENT differs between the audited and
 *  non-audited generations of the same system.  Scoped to `web/` because the
 *  audit WRITE side (the `audit_records` DDL, the per-command insert, the
 *  backend history route) legitimately differs — this file is about what the
 *  FRONTEND does with it. */
async function frontendDiffPaths(frontend: string): Promise<string[]> {
  const on = await generateSystemFiles(scaffoldSystem(frontend, true));
  const off = await generateSystemFiles(scaffoldSystem(frontend, false));
  const paths = new Set([...on.keys(), ...off.keys()].filter((p) => p.startsWith("web/")));
  return [...paths].filter((p) => on.get(p) !== off.get(p)).sort();
}

/** Markers of every emission this change adds.  None may appear anywhere in a
 *  non-audited aggregate's frontend. */
const HISTORY_MARKERS = [
  "useHistoryOrder",
  "AuditEntry",
  "AuditFieldChange",
  "loom-timeline",
  "orders-detail-history",
  "History is not yet supported on",
];

describe("api client — `history(id)` on the four JS-family frontends", () => {
  it.each([
    ["react", "export function useHistoryOrder(id: string | undefined) {"],
    ["vue", "export function useHistoryOrder(id: string | undefined) {"],
    // svelte-query v6 takes thunks, matching this module's own `use<Agg>ById`.
    ["svelte", "export function useHistoryOrder(id: () => string | undefined) {"],
    ["angular", "export function useHistoryOrder(id: string | undefined) {"],
  ])("%s emits the hook over GET /<tag>/{id}/history", async (frontend, signature) => {
    const out = allFiles(await generateSystemFiles(scaffoldSystem(frontend, true)));
    expect(out).toContain(signature);
    // The route is PATH-nested over a different table — not the `/<tag>/<find>
    // ?<param>=…` shape every `finds` arm builds.  That difference is the whole
    // reason `historyFind` sits beside `finds`.
    expect(out).toMatch(/\/orders\/\$\{id\(?\)?\}\/history/);
  });

  it("names the hook through the walker's own formula, so the call site links", async () => {
    // The page body's `<api>.Order.history(id)` is lowered by `hookFnName`; the
    // module's export is computed from the SAME function.  A hand-spelled
    // `useHistory${agg}` would be a second definition of one rule.
    const out = allFiles(await generateSystemFiles(scaffoldSystem("react", true)));
    expect(out).toContain('import { useHistoryOrder, useOrderById } from "../../api/order";');
    expect(out).toContain("const orderHistory = useHistoryOrder(id);");
  });

  it("derives the entry DTO from the shared wire shape, `changes` narrowed", async () => {
    const out = allFiles(await generateSystemFiles(scaffoldSystem("react", true)));
    // The canonical ordered field list from `auditEntryWireShape()`.
    expect(out).toContain("export const AuditEntry = z.object({\n  auditId: z.string(),");
    expect(out).toContain("  actor: z.unknown().nullish(),");
    expect(out).toContain("  correlationId: z.string().nullish(),");
    // `changes` is `json[]` on the wire (TypeIR has no nested-record leaf); the
    // client narrows the ELEMENT so `__c.field` typechecks in the Timeline.
    expect(out).toContain("  changes: z.array(AuditFieldChange),");
    expect(out).toContain("export const AuditEntryListResponse = z.array(AuditEntry);");
  });

  it("angular carries the entry as an interface (it has no zod layer)", async () => {
    const out = allFiles(await generateSystemFiles(scaffoldSystem("angular", true)));
    expect(out).toContain("export interface AuditFieldChange {");
    expect(out).toContain("export interface AuditEntry {");
    expect(out).toContain("  changes: AuditFieldChange[];");
    expect(out).toContain("  history(id: string) {");
  });
});

describe("scaffolded Detail page — the History section", () => {
  it.each([
    ["react"],
    ["vue"],
    ["svelte"],
    ["angular"],
  ])("%s renders a Timeline over the history read", async (frontend) => {
    const out = allFiles(await generateSystemFiles(scaffoldSystem(frontend, true)));
    expect(out).toContain("orders-detail-history");
    expect(out).toContain("orders-detail-history-timeline");
    expect(out).toContain("loom-timeline");
    // Wrapped in a QueryView, so the trail gets the same loading / error /
    // empty arms every other scaffolded read has.  An audit trail that
    // silently renders nothing while in flight reads as "never touched".
    expect(out).toContain("Couldn't load history");
    expect(out).toContain("No history yet.");
  });

  it("keys the section off the ROUTE id, not the loaded record", async () => {
    // A page-level sibling of the record QueryView — the trail is addressed by
    // the route param, so it neither needs nor should wait for the entity read.
    const out = allFiles(await generateSystemFiles(scaffoldSystem("react", true)));
    expect(out).toContain("const orderHistory = useHistoryOrder(id);");
    expect(out).toMatch(/\(orderHistory\.data \?\? \[\]\)\.map\(\(__e\)/);
  });
});

describe("non-audited aggregate — nothing new reaches its frontend", () => {
  it.each([
    ["react"],
    ["vue"],
    ["svelte"],
    ["angular"],
    ["feliz"],
    ["flutter"],
  ])("%s: not one marker of the audit trail appears", async (frontend) => {
    const files = await generateSystemFiles(scaffoldSystem(frontend, false));
    const web = [...files].filter(([p]) => p.startsWith("web/"));
    const hits = web.flatMap(([p, c]) =>
      HISTORY_MARKERS.filter((m) => c.includes(m)).map((m) => `${p}: ${m}`),
    );
    expect(hits).toEqual([]);
  });

  it.each([
    ["react"],
    ["vue"],
    ["svelte"],
    ["angular"],
  ])("%s: the audit trail moves EXACTLY three frontend files, and no others", async (frontend) => {
    // The blast-radius pin.  "Byte-identical for a non-audited aggregate" is
    // enforced end-to-end by the baseline-fixture gate
    // (`page-emitter-equivalence.test.ts` diffs `examples/acme.ddd`, which has
    // no audited aggregate, against `test/fixtures/baseline-output/`).  What
    // THIS asserts is the complementary half the fixture can't: when the trail
    // IS on, it reaches the aggregate's api module, its Detail page, and the
    // message catalogue — and nothing else in the project shifts.
    const moved = await frontendDiffPaths(frontend);
    expect(moved).toHaveLength(3);
    expect(moved.filter((p) => /api\/order\.ts$/.test(p))).toHaveLength(1);
    expect(moved.filter((p) => /locales\/en\.json$/.test(p))).toHaveLength(1);
    expect(moved.filter((p) => /(detail|\[id\])/.test(p))).toHaveLength(1);
  });

  it("react: no schema, no hook, no section", async () => {
    const out = allFiles(await generateSystemFiles(scaffoldSystem("react", false)));
    expect(out).not.toContain("useHistoryOrder");
    expect(out).not.toContain("AuditEntryListResponse");
    expect(out).not.toContain("orders-detail-history");
  });
});

describe("every render path collects the read (the degrade-honestly set is empty)", () => {
  // The honest-degradation contract (a VISIBLE "History is not yet supported
  // on <framework>" widget, never a source comment) still guards any FUTURE
  // frontend outside `HISTORY_CAPABLE_FRAMEWORKS` — the mechanism is pinned by
  // the disposition test below.  Every shipped target now collects the read:
  // the four JS-family frontends over the api client, Phoenix over its
  // in-process loader, Feliz over `felizHistoryRead`, Flutter over the
  // Riverpod `.family` provider.

  it("feliz: collects the read and renders the trail natively", async () => {
    const out = allFiles(await generateSystemFiles(scaffoldSystem("feliz", true)));
    // The notice is gone — replaced by a real Model field + fetch + view.
    expect(out).not.toContain("History is not yet supported on feliz");
    // The read is COLLECTED into its own page-entry-keyed field — never the
    // unfiltered list (the misbinding that excluded feliz).  The full wiring
    // (Msg, decoder, Cmd.batch, Timeline markup) is pinned in
    // `test/generator/feliz/feliz-audit-history.test.ts`.
    expect(out).toContain("OrderHistory");
    expect(out).toContain("/history");
    expect(out).toContain("orders-detail-history");
  });

  it("flutter: collects the read and renders the trail natively", async () => {
    const out = allFiles(await generateSystemFiles(scaffoldSystem("flutter", true)));
    // The notice is gone — replaced by a real provider + a real widget.
    expect(out).not.toContain("History is not yet supported on flutter");
    // The read is COLLECTED: a `.family` provider keyed by the route id over
    // the path-nested history route, watched by the page under the SAME name
    // the walker's `buildHookUse` derives — the dangling-provider failure mode
    // this file used to pin is now the linked pair.
    expect(out).toContain("final orderHistoryProvider =");
    expect(out).toContain("FutureProvider.family<List<AuditEntry>, String>((ref, id) async {");
    expect(out).toContain("ref.watch(orderHistoryProvider(id))");
    expect(out).toContain("/orders/$id/history");
    // And the section renders through the `renderTimeline` fork, keyed for
    // widget-test finders.  (The full per-entry markup is pinned in
    // `test/generator/flutter/flutter-audit-history.test.ts`.)
    expect(out).toContain("key: const Key('orders-detail-history')");
    expect(out).toContain("key: const Key('orders-detail-history-timeline')");
  });

  it("phoenix/HEEx: serves the trail in-process rather than skipping it", async () => {
    const out = allFiles(await generateSystemFiles(heexSystem(true)));
    expect(out).not.toContain("entity history not yet supported on phoenixLiveView");
    expect(out).toContain("orders-detail-history");
    // The trail is loaded by its own page-private loader over `audit_records`,
    // NOT bound to the aggregate's list — the misbinding the skip existed to
    // prevent, and the reason `source: "history"` is its own binding kind.
    expect(out).toContain("defp load_order_history(_socket, id) do");
    expect(out).toContain('Api.Audit.History.for_target(Api.Repo, "Order", id)');
    expect(out).toContain("|> Enum.map(&order_audit_entry/1)");
    // Guard 2 — reachability rides the ENTITY read, since `audit_records`
    // carries no tenant column for a capability filter to scope.
    expect(out).toContain("case Api.Ordering.get_order(id) do");
    // And it renders through the same `Timeline` the JSX frontends use.
    expect(out).toContain(
      '<ol class="loom-timeline" data-testid="orders-detail-history-timeline">',
    );
    expect(out).toContain("<%= for e <- @order_history || [] do %>");
  });

  // The three cases above assert what today's three unported frontends DO.
  // This one pins the DISPOSITION ITSELF: every framework a walker target
  // declares is either in the capable set or named here as a reviewed skip.
  //
  // Two drifts it stops, both of which the per-frontend cases above are blind
  // to.  A SEVENTH frontend target lands and nobody thinks about the audit
  // trail: it inherits the skip by default, silently, and this test fails
  // until someone writes the name down.  Or a frontend is PORTED — the read
  // collected, `Timeline` rendered — and its name moves out of `SKIPPED` into
  // `HISTORY_CAPABLE_FRAMEWORKS`, which is the same edit that makes the port
  // real.  Neither can happen quietly.
  it("every walker target's framework is dispositioned — capable, or a named skip", () => {
    const declared = [
      tsxTarget,
      vueTarget,
      svelteTarget,
      angularTarget,
      felizTarget,
      flutterTarget,
      heexTarget,
    ].map((t) => t.framework);

    /** Frameworks whose read layer does NOT collect `history(id)` — see the
     *  module header of `_walker/history-read.ts` for what each does wrong. */
    const SKIPPED: string[] = [];

    expect([...declared].sort()).toEqual([...HISTORY_CAPABLE_FRAMEWORKS, ...SKIPPED].sort());
    // And the predicate agrees with the table, rather than merely coexisting
    // with it: a skipped framework really does skip a history read.
    const aggregates = { has: (n: string) => n === "Order" };
    const historyRead = {
      kind: "method-call",
      member: "history",
      receiver: { kind: "ref", name: "Order" },
    } as unknown as Parameters<typeof skipsEntityHistoryRead>[1];
    for (const framework of declared) {
      expect(skipsEntityHistoryRead(framework, historyRead, aggregates)).toBe(
        SKIPPED.includes(framework),
      );
    }
  });
});
