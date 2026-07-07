// ---------------------------------------------------------------------------
// Bucket E1 — vanilla (Ecto/Phoenix, non-Ash) statement-kind coverage for the
// workflow `for-each` body, the `if-let` branches, and the exception-less
// returning-op body.  Before this slice these paths dropped uncovered
// statement kinds as `# TODO`:
//
//   - for-each body only handled `op-call`        → other kinds # TODO'd
//   - if-let branch only handled op-call/emit/factory-let → other kinds # TODO'd
//   - exception-less returning-op had no `call`    → # TODO(exception-less)
//
// Each path now mirrors the full statement dispatch.  These tests assert the
// real lowering AND that no `# TODO` appears for the covered kinds.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

function wrap(body: string): string {
  return `
system Shop {
  subdomain Sales {
    context Orders {
      event Confirmed { order: Order id }
      criterion Pending(d: bool) of Order = this.open == d
      aggregate Order with crudish {
        open: bool
        total: int
        tags: string[]
        operation confirm() { open := false }
        operation tagWith(t: string): Order or Rejected {
          tags += t
          tags -= t
          total += 1
          recompute()
        }
        function recompute(): int = this.total + 1
      }
      error Rejected { why: string }
      repository Orders for Order { }
      retrieval PendingQ(d: bool) of Order { where: this.open == d }
${body}
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}
`;
}

async function fileEndingIn(src: string, suffix: string): Promise<string> {
  const files = await generateSystemFiles(src);
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no generated file ending in ${suffix}`);
  return files.get(key)!;
}

describe("vanilla for-each body — broader statement set", () => {
  const SRC = wrap(`
      workflow batchConfirm {
        create(d: bool) {
          let xs = Orders.run(PendingQ(d), page: { offset: 0, limit: 50 })
          for x in xs {
            x.confirm()
            emit Confirmed { order: x.id }
          }
        }
      }`);

  it("lowers an op-call + emit loop body through a per-iteration with-chain", async () => {
    const wf = await fileEndingIn(SRC, "/workflows/batch_confirm.ex");
    // op-call becomes a fallible `<-` clause...
    expect(wf).toMatch(/\{:ok, loop_updated\} <- Context\.confirm_order\(x, %\{\}\)/);
    // ...the emit side-effect runs in the do-branch, then continue.
    expect(wf).toMatch(/Phoenix\.PubSub\.broadcast\(.*Events\.Confirmed\{order: x\.id\}\)/);
    expect(wf).toContain("{:cont, {:ok, loop_updated}}");
    expect(wf).toContain("err -> {:halt, err}");
  });

  it("emits no `# TODO: lower for-each body statement kind` comment", async () => {
    const wf = await fileEndingIn(SRC, "/workflows/batch_confirm.ex");
    expect(wf).not.toContain("# TODO: lower for-each body statement kind");
  });

  it("keeps the flat `case` shape for a lone op-call body", async () => {
    const src = wrap(`
      workflow loneConfirm {
        create(d: bool) {
          let xs = Orders.run(PendingQ(d), page: { offset: 0, limit: 50 })
          for x in xs { x.confirm() }
        }
      }`);
    const wf = await fileEndingIn(src, "/workflows/lone_confirm.ex");
    expect(wf).toMatch(/case Context\.confirm_order\(x, %\{\}\) do/);
    expect(wf).toContain("{:ok, updated} -> {:cont, {:ok, updated}}");
  });
});

describe("vanilla if-let branches — broader statement set", () => {
  const SRC = wrap(`
      workflow findAndConfirm {
        create(flag: bool) {
          if let o = Orders.find(Pending(flag)) {
            o.confirm()
            emit Confirmed { order: o.id }
          } else {
            let fresh = Order.create({ open: false, total: 0, tags: [] })
          }
        }
      }`);

  it("lowers a then-branch op-call + emit and an else-branch factory-let", async () => {
    const wf = await fileEndingIn(SRC, "/workflows/find_and_confirm.ex");
    expect(wf).toMatch(/Context\.confirm_order\(o, %\{\}\)/);
    expect(wf).toMatch(/Phoenix\.PubSub\.broadcast\(.*Events\.Confirmed\{order: o\.id\}\)/);
    // The else-branch factory-let bind is unread, so it `_`-discards (an unused
    // real-named bind would trip `--warnings-as-errors`).
    expect(wf).toMatch(/\{:ok, _\} = Context\.create_order\(%\{[^}]*\}\)/);
  });

  it("emits no `# TODO: lower if-let branch statement kind` comment", async () => {
    const wf = await fileEndingIn(SRC, "/workflows/find_and_confirm.ex");
    expect(wf).not.toContain("# TODO: lower if-let branch statement kind");
  });
});

describe("vanilla exception-less returning op — collection mutations + call", () => {
  const SRC = wrap(`
      workflow noop { create(d: bool) { let xs = Orders.run(PendingQ(d)) for x in xs { } } }`);

  it("renders add/remove collection mutations and a bare call (no # TODO)", async () => {
    const ctx = await fileEndingIn(SRC, "/orders.ex");
    // the NON-bang op def — `def tag_with_order(` won't match the §13
    // `def tag_with_order!(` LiveView-action bang that now precedes it.
    const start = ctx.indexOf("def tag_with_order(");
    const fn = ctx.slice(start, start + 900);
    // `tags += t` / `tags -= t` collection rebinds.
    expect(fn).toMatch(/record = %\{record \| tags: \(record\.tags \|\| \[\]\) \+\+ \[t\]\}/);
    expect(fn).toMatch(/record = %\{record \| tags: List\.delete\(record\.tags \|\| \[\], t\)\}/);
    // `total += 1` scalar arithmetic.
    expect(fn).toMatch(/record = %\{record \| total: record\.total \+ 1\}/);
    // `recompute()` bare call → a real call to the emitted aggregate
    // `function` (§11b), discarding the result (`_ = recompute(record)`).
    expect(fn).toMatch(/_ = recompute\(record\)/);
    expect(fn).not.toContain("# TODO(exception-less)");
    // …and that callable target IS emitted on this module, so the call resolves.
    expect(ctx).toMatch(/def recompute\(%Api\.Orders\.Order\{\} = record\) do/);
  });
});

describe("vanilla nested control flow — for-each / if-let bodies recurse", () => {
  // The for-each validator only inspects op-calls, so nested control flow /
  // repo binds are valid input.  Before the recursion fix each dropped a
  // `# TODO: lower ... statement kind`; now they reuse `lowerStatement` as a
  // `<-` with-clause so a nested failure short-circuits the enclosing chain.

  it("(1) an if-let inside a for-each body lowers with no # TODO", async () => {
    const wf = await fileEndingIn(
      wrap(`workflow ifLetInForEach {
        create(d: bool) {
          let xs = Orders.run(PendingQ(d), page: { offset: 0, limit: 50 })
          for x in xs { if let o = Orders.find(Pending(d)) { x.confirm() } }
        }
      }`),
      "/workflows/if_let_in_for_each.ex",
    );
    expect(wf).not.toContain("# TODO");
    // The nested if-let is a `{:ok, _} <-` clause inside the reduce_while chain.
    expect(wf).toMatch(/Enum\.reduce_while\([\s\S]*with \{:ok, _\} <- \([\s\S]*case Context\.run_/);
  });

  it("(2) a for-each over a branch-local repo-run inside an if-let branch lowers with no # TODO", async () => {
    const wf = await fileEndingIn(
      wrap(`workflow forEachInIfLet {
        create(d: bool) {
          if let o = Orders.find(Pending(d)) {
            let ys = Orders.run(PendingQ(d))
            for y in ys { y.confirm() }
          }
        }
      }`),
      "/workflows/for_each_in_if_let.ex",
    );
    expect(wf).not.toContain("# TODO");
    // The branch threads the repo-run bind then the nested loop as with-clauses.
    expect(wf).toMatch(/\{:ok, ys\} <- Context\.run_pending_q_order\(d\)/);
    expect(wf).toMatch(/Enum\.reduce_while\(ys,/);
  });

  it("(3) an if-let inside an if-let branch lowers with no # TODO", async () => {
    const wf = await fileEndingIn(
      wrap(`workflow ifLetInIfLet {
        create(d: bool) {
          if let o = Orders.find(Pending(d)) {
            if let p = Orders.find(Pending(d)) { p.confirm() }
          }
        }
      }`),
      "/workflows/if_let_in_if_let.ex",
    );
    expect(wf).not.toContain("# TODO");
  });

  it("(4) a for-each nested inside a for-each body lowers with no # TODO", async () => {
    const wf = await fileEndingIn(
      wrap(`workflow forEachInForEach {
        create(d: bool) {
          let xs = Orders.run(PendingQ(d))
          for x in xs {
            let ys = Orders.run(PendingQ(d))
            for y in ys { y.confirm() }
          }
        }
      }`),
      "/workflows/for_each_in_for_each.ex",
    );
    expect(wf).not.toContain("# TODO");
    // Inner reduce_while is a with-clause inside the outer reduce_while callback.
    expect(wf).toMatch(/Enum\.reduce_while\(xs,[\s\S]*Enum\.reduce_while\(ys,/);
  });

  it("underscores an unused loop var so --warnings-as-errors stays clean", async () => {
    // The body keys off the workflow param `d`, never naming the row `x`.
    const wf = await fileEndingIn(
      wrap(`workflow unusedRow {
        create(d: bool) {
          let xs = Orders.run(PendingQ(d))
          for x in xs { if let o = Orders.find(Pending(d)) { o.confirm() } }
        }
      }`),
      "/workflows/unused_row.ex",
    );
    expect(wf).toMatch(/fn _x, _acc ->/);
  });
});
