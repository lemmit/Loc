// ---------------------------------------------------------------------------
// Java backend — event-sourced workflows (workflow-and-applier.md A2-S5b; java
// joined EVENT_SOURCING_WORKFLOW_BACKENDS).  An `eventSourced` workflow persists
// in the single per-context `<ctx>_events` log (its `stream_type = "<Wf>"` rows)
// folded through its `apply(...)` blocks — the saga analogue of a
// `persistedAs(eventLog)` aggregate — instead of a
// mutable JPA correlation-state entity.  Asserts the `<Wf>State` fold class, the
// absence of a JPA state entity/table, and the fold-load / append-own-events
// dispatch handlers (JdbcTemplate-backed stream IO).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `system S { subdomain O { context O {
  aggregate Order { status: string  operation place() { status := "P"  emit OrderPlaced { order: id } } }
  repository Orders for Order { }
  event OrderPlaced { order: Order id }
  event PaymentRegistered { order: Order id, amount: int }
  channel L { carries: OrderPlaced, PaymentRegistered  delivery: broadcast  retention: ephemeral }
  workflow Tally eventSourced {
    orderId: Order id
    total: int
    create(p: OrderPlaced) by p.order { emit PaymentRegistered { order: p.order, amount: 0 } }
    on(pr: PaymentRegistered) by pr.order { precondition total >= 0  emit PaymentRegistered { order: pr.order, amount: total } }
    apply(pr: PaymentRegistered) { total := total + pr.amount }
  }
} } api A from O storage pg { type: postgres }
  resource oState { for: O, kind: state, use: pg }
  deployable api { platform: java contexts: [O] serves: A dataSources: [oState] port: 8080 } }`;

const WF = "api/src/main/java/com/loom/api/application/workflows";

async function gen(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

const file = (files: Map<string, string>, suffix: string): string =>
  [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

/** Slice one @EventListener handler method out of the dispatcher source. */
const method = (d: string, sig: string): string => {
  const start = d.indexOf(sig);
  if (start < 0) return "";
  const after = d.indexOf("@EventListener", start + sig.length);
  return d.slice(start, after < 0 ? undefined : after);
};

describe("java event-sourced workflows", () => {
  it("emits a <Wf>State fold class (appliers + _fromEvents + codec), no JPA", async () => {
    const s = (await gen()).get(`${WF}/TallyState.java`)!;
    expect(s).toContain("public class TallyState {");
    expect(s).not.toContain("@Entity");
    expect(s).not.toContain("@EmbeddedId");
    // The applier folds against `this` (the fold-target instance), like an aggregate.
    expect(s).toContain("private void _applyPaymentRegistered(PaymentRegistered pr) {");
    expect(s).toContain("this.total = this.total + pr.amount();");
    expect(s).toContain("void _apply(DomainEvent ev) {");
    expect(s).toContain(
      "public static TallyState _fromEvents(OrderId orderId, List<DomainEvent> events) {",
    );
    // Fold-from-zero seeds the correlation key + typed zeros for required fields.
    expect(s).toContain("s.orderId = orderId;");
    expect(s).toContain("s.total = 0;");
    expect(s).toContain("public static DomainEvent _rowToEvent(String type, String data) {");
    expect(s).toContain("public static String _toData(DomainEvent ev) {");
  });

  it("emits no mutable saga-state entity / Spring Data repo for the ES workflow", async () => {
    const files = await gen();
    expect([...files.keys()].some((k) => k.endsWith("persistence/TallyState.java"))).toBe(false);
    expect([...files.keys()].some((k) => k.endsWith("TallyStateRepository.java"))).toBe(false);
  });

  it("the create starter appends its own events and skips the unused fold", async () => {
    const d = method(file(await gen(), "ODispatcher.java"), "public void onTallyStartOrderPlaced(");
    expect(d).toContain("var __key = p.order();");
    expect(d).toContain("var __sid = String.valueOf(__key.value());");
    // This starter only emits a constant, so it never reads `state` — the stream
    // load + fold is a pure no-op and is skipped (parity with the python port).
    expect(d).not.toContain("_fromEvents");
    expect(d).not.toContain("__loaded");
    expect(d).toContain("__events.add(new PaymentRegistered(p.order(), 0));");
    // Context `O` has a `state` dataSource (`oState`), so its saga stream lands
    // in the `o` schema — the single per-context `o_events` log, its rows tagged
    // `stream_type = "Tally"`.
    expect(d).toContain(
      "insert into o.o_events (stream_type, stream_id, version, type, data) values (?, ?, ?, ?, ?::jsonb)",
    );
    expect(d).toContain(
      '"Tally", __sid, __v, __e.getClass().getSimpleName(), TallyState._toData(__e));',
    );
    expect(d).toContain("for (var __e : __events) events.publishEvent(__e);");
  });

  it("the on-reactor drops + logs when the stream is empty and reads folded state", async () => {
    const d = method(
      file(await gen(), "ODispatcher.java"),
      "public void onTallyOnPaymentRegistered(",
    );
    expect(d).toContain("var __rows = jdbc.queryForList(");
    expect(d).toContain("if (__rows.isEmpty()) {");
    expect(d).toContain("event_unrouted");
    // The reactor reads `total` (a precondition), so it folds the stream.
    expect(d).toContain("var state = TallyState._fromEvents(__key, __loaded);");
    // The precondition reads the folded state (package-private field, same package).
    expect(d).toContain("if (!(state.total >= 0)) throw new DomainException(");
  });
});
