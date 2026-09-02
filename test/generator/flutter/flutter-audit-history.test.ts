// Flutter entity-history — the audit trail (docs/audit.md) reaching the
// Dart/Riverpod frontend end-to-end: the derived `history(id)` read collected
// into a Riverpod `.family` provider (`reads-emit.ts`), the `AuditEntry` /
// `AuditFieldChange` wire models with hand-written `fromJson` (`dart-model-
// emit.ts`), and the `Timeline` primitive rendered natively through the
// `renderTimeline` WalkerTarget fork (`flutter-target.ts`) instead of the
// "History is not yet supported on flutter" notice.
//
// The load-bearing assertion is the two-sided name link: the page's hoisted
// `ref.watch(<var>Provider(id))` and the emitted `final <var>Provider = …` are
// asserted against the SAME string, and every `<x>Provider` the page references
// is asserted to be defined in `lib/reads.dart` — so the walker's reference and
// the collector's emission cannot drift apart (the dangling-provider failure
// mode that kept flutter out of `HISTORY_CAPABLE_FRAMEWORKS`).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** The cross-target fixture (`audit-history-frontend-cross-target.test.ts`)
 *  with the flutter frontend: a scaffolded audited aggregate, whose Detail page
 *  carries the History section — `QueryView { of: <api>.Order.history(id),
 *  data: entries => Timeline(of: entries) }`. */
const scaffoldSystem = (audited: boolean): string => `
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
    deployable web { platform: flutter, targets: api, ui: Web, port: 3001 }
  }
`;

const fileOf = (files: Map<string, string>, suffix: string): string => {
  for (const [p, c] of files) if (p.endsWith(suffix)) return c;
  throw new Error(`no file ending in ${suffix}; got ${[...files.keys()].join(", ")}`);
};

/** The scaffolded detail page's emit path.  AGGREGATE-QUALIFIED: a page's file
 *  is keyed on its area-qualified identity, not on its role-scoped name, so a
 *  second aggregate in the same ui gets `product_detail_page.dart` rather than
 *  silently overwriting this one's `detail_page.dart`.  (That collision routed
 *  a two-aggregate scaffold's `/products` at the Customers list, and survived
 *  CI because `flutter analyze` calls the duplicate import an `info`.)  Keep
 *  the aggregate prefix here: without it this suffix matches nothing. */
const DETAIL_PAGE = "web/lib/pages/order_detail_page.dart";

describe("flutter entity-history — read provider + wire models + Timeline", () => {
  it("emits the history provider under the exact name the page watches", async () => {
    const files = await generateSystemFiles(scaffoldSystem(true));
    const reads = fileOf(files, "web/lib/reads.dart");
    const detail = fileOf(files, DETAIL_PAGE);

    // BOTH sides of the link, against one spelling — the provider…
    expect(reads).toContain(
      "final orderHistoryProvider =\n    FutureProvider.family<List<AuditEntry>, String>((ref, id) async {",
    );
    // …and the page's hoist that watches it, keyed by the route id.
    expect(detail).toContain("final orderHistory = ref.watch(orderHistoryProvider(id));");
  });

  it("the api call is the path-nested /history route returning a BARE array", async () => {
    const files = await generateSystemFiles(scaffoldSystem(true));
    const reads = fileOf(files, "web/lib/reads.dart");
    // Path-nested over a different table — not the `/<coll>/<find>?<param>=…`
    // shape a named find builds, and not the paged `items` envelope `.all`
    // unwraps (the JS clients parse `z.array(AuditEntry)`).
    expect(reads).toContain("await http.get(apiUri('/orders/$id/history'));");
    expect(reads).toContain("final rows = jsonDecode(res.body) as List<dynamic>;");
    expect(reads).toContain(".map((e) => AuditEntry.fromJson(e as Map<String, dynamic>))");
    expect(reads).not.toContain("body['items']");
  });

  it("emits the AuditEntry + AuditFieldChange Dart wire models", async () => {
    const files = await generateSystemFiles(scaffoldSystem(true));
    const models = fileOf(files, "web/lib/models.dart");
    expect(models).toContain("class AuditEntry {");
    expect(models).toContain("factory AuditEntry.fromJson(Map<String, dynamic> json) =>");
    expect(models).toContain("class AuditFieldChange {");
    // `at` decodes like every other wire datetime — a real Dart `DateTime`.
    expect(models).toContain("final DateTime at;");
    expect(models).toContain("at: DateTime.parse(json['at'] as String),");
    // `changes` narrows the `json[]` wire element to the typed change row, so
    // `__c.field` resolves in the Timeline.
    expect(models).toContain("final List<AuditFieldChange> changes;");
    expect(models).toContain(
      "changes: (json['changes'] as List<dynamic>).map((e) => AuditFieldChange.fromJson(e as Map<String, dynamic>)).toList(),",
    );
    // A `json` leaf is `dynamic` — already nullable, so no `dynamic?` (an
    // `unnecessary_question_mark` analyzer error), and no `copyWith` (whose
    // nullable param spelling cannot express a `dynamic` field).
    expect(models).toContain("final dynamic actor;");
    expect(models).not.toContain("dynamic?");
    expect(models).not.toMatch(/AuditEntry copyWith|AuditFieldChange copyWith/);
  });

  it("renders the Timeline natively — no 'not yet supported' notice", async () => {
    const files = await generateSystemFiles(scaffoldSystem(true));
    const detail = fileOf(files, DETAIL_PAGE);
    // The section frame + the timeline itself, keyed for widget-test finders.
    expect(detail).toContain("key: const Key('orders-detail-history')");
    expect(detail).toContain("key: const Key('orders-detail-history-timeline')");
    // One entry block per command, keyed by auditId, header always rendered…
    expect(detail).toContain("...orderHistory.map((e) => Padding(key: ValueKey(e.auditId)");
    expect(detail).toContain("Text(e.action, style: const TextStyle(fontWeight: FontWeight.bold))");
    // …the timestamp through DateFormat (with the intl import present)…
    expect(detail).toContain("DateFormat.yMMMd().add_jm().format(e.at)");
    expect(detail).toContain("import 'package:intl/intl.dart';");
    // …the actor only when recorded, and changes as "field: before → after"
    // with `—` for the null side.
    expect(detail).toContain("if (e.actor != null) Text('${e.actor}')");
    expect(detail).toContain(
      "...e.changes.map((c) => Text('${c.field}: ${c.before ?? '—'} → ${c.after ?? '—'}'))",
    );
    // The QueryView arms survive around it — loading / error / empty.  (The
    // error text rides the i18n runtime, Dart-escaped: `Couldn\'t load history`.)
    expect(detail).toContain("load history");
    expect(detail).toContain("No history yet.");
    // And the honest-degradation notice is gone.
    expect(detail).not.toContain("History is not yet supported on flutter");
  });

  it("every provider the page references is one the collector emitted", async () => {
    // The anti-drift net, page-wide: collect EVERY `<x>Provider` identifier the
    // detail page mentions and require a `final <x>Provider =` definition —
    // either in `lib/reads.dart` (query reads) or in the page itself (the
    // Riverpod state triad).  A walker reference without a collector emission
    // (the pre-port failure mode) fails here by name.
    const files = await generateSystemFiles(scaffoldSystem(true));
    const reads = fileOf(files, "web/lib/reads.dart");
    const detail = fileOf(files, DETAIL_PAGE);
    const referenced = new Set(detail.match(/\b[a-z]\w*Provider\b/g) ?? []);
    expect(referenced).toContain("orderHistoryProvider");
    for (const name of referenced) {
      expect(
        reads.includes(`final ${name} =`) || detail.includes(`final ${name} =`),
        `page references ${name} but nothing defines it`,
      ).toBe(true);
    }
  });

  it("a non-audited aggregate's flutter output carries none of it", async () => {
    const files = await generateSystemFiles(scaffoldSystem(false));
    const web = [...files].filter(([p]) => p.startsWith("web/"));
    const markers = ["AuditEntry", "AuditFieldChange", "orderHistory", "/history"];
    const hits = web.flatMap(([p, c]) =>
      markers.filter((m) => c.includes(m)).map((m) => `${p}: ${m}`),
    );
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The Timeline's `testid:` → widget `Key` — Dart-ESCAPED (audit §D item 12).
//
// `renderTimeline` hand-rolled `Key('${tid[1]}')` around the raw testid,
// bypassing `dartString` — the one place in the Flutter emitter that escapes a
// string literal.  A `'`, a `\` or a `$` (Dart's interpolation sigil) in the
// value therefore closed the literal early or interpolated a name that does not
// exist: uncompilable Dart from a valid `.ddd`.  Every OTHER Flutter primitive
// routes its key through the pack's `testidKey`, which does escape.
// ---------------------------------------------------------------------------
const historySystem = (testid: string): string => `
  system HistoryDemo {
    subdomain Ordering {
      context Ordering {
        aggregate Order audited with crudish {
          reference: string
          quantity: int
        }
        repository Orders for Order { }
      }
    }
    api OrderingApi from Ordering
    ui Web {
      api Ops: OrderingApi
      page OrderHistory(id: string) {
        route: "/orders/:id/history"
        body: QueryView {
          of: Ops.Order.history(id),
          data: entries => Timeline(of: entries, testid: ${JSON.stringify(testid)})
        }
      }
    }
    storage primary { type: postgres }
    resource orderingState { for: Ordering, kind: state, use: primary }
    deployable api {
      platform: node, contexts: [Ordering], dataSources: [orderingState],
      serves: OrderingApi, port: 3000
    }
    deployable web { platform: flutter, targets: api, ui: Web { Ops: api }, port: 3001 }
  }
`;

describe("flutter Timeline — the testid Key is Dart-escaped", () => {
  it("escapes an apostrophe instead of closing the literal", async () => {
    const files = await generateSystemFiles(historySystem("it's-x"));
    const page = fileOf(files, "web/lib/pages/order_history_page.dart");
    expect(page).toContain(String.raw`key: const Key('it\'s-x')`);
    // The unescaped spelling is uncompilable Dart (`Key('it's-x')`).
    expect(page).not.toContain("Key('it's-x')");
  });

  it("escapes Dart's `$` interpolation sigil", async () => {
    const files = await generateSystemFiles(historySystem("total-$id"));
    const page = fileOf(files, "web/lib/pages/order_history_page.dart");
    expect(page).toContain(String.raw`key: const Key('total-\$id')`);
  });

  it("leaves an ordinary testid byte-identical", async () => {
    const files = await generateSystemFiles(historySystem("order-timeline"));
    const page = fileOf(files, "web/lib/pages/order_history_page.dart");
    expect(page).toContain("key: const Key('order-timeline')");
  });
});
