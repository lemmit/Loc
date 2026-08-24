// M-T6.38 — a `when` state gate is enforced at the DOMAIN-METHOD entry, not
// only at the route.
//
// The defect this pins was SILENT on four of the five backends.  `operation
// cancel() when <pred>` emitted its gate at the route / command-handler layer
// only, so every OTHER caller of the domain method walked straight past it:
//
//   * a workflow step / saga cascade (`on(e: Event)` and the event-triggered
//     `create(e: Event) by` starter both call `aggregate.<op>()` in-process),
//   * an `extern` command handler,
//   * the LiveView action seam.
//
// The refused write then LANDED, with no 409 and no log — the absence of a
// refusal, which is exactly the shape a wire-shape differential cannot see (the
// request that should have been refused is never made over HTTP).  So the gate
// now renders at the domain-method entry on all five backends; the route keeps
// its own pre-load check so the HTTP answer (409 + problem envelope) is still
// produced before the aggregate is touched, and the wire contract is unchanged.
//
// Why one shared test rather than five: the claim is a PARITY claim — the gate
// has to be an invariant of the domain method on every backend, or a workflow
// written once against a five-target system silently means different things per
// target.  Elixir already satisfied it (its gate has always lived inside the
// context function `cancel_order/2`, which is what the workflow starter calls);
// it is asserted here alongside the other four so the property can't regress.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** A `when`-gated operation reached from TWO directions: the HTTP route, and an
 *  event-triggered workflow starter that loads the aggregate and calls the
 *  domain method directly.  `place()` is the emitter of the event that drives
 *  the workflow, so the whole cascade is in one system. */
/** The workflow half of the cascade, spelled once so the private-operation leg
 *  can drop it verbatim (a workflow may only call PUBLIC operations). */
const WORKFLOW = `      workflow AutoCancel {
        orderId: Order id
        create(p: OrderPlaced) by p.order {
          let o = Orders.getById(p.order)
          o.cancel()
        }
      }`;

const SOURCE = (platform: string) => `
system GateProbe {
  subdomain Sales {
    context Orders {
      enum St { Draft, Shipped, Cancelled }
      aggregate Order with crudish {
        code: string
        status: St
        operation place() {
          status := St.Shipped
          emit OrderPlaced { order: id }
        }
        operation cancel() when this.status != St.Shipped && this.status != St.Cancelled {
          status := St.Cancelled
        }
      }
      repository Orders for Order { }
      event OrderPlaced { order: Order id }
      channel Lifecycle {
        carries: OrderPlaced
        delivery: broadcast
        retention: ephemeral
      }
${WORKFLOW}
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource salesState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: ${platform}
    contexts: [Orders]
    dataSources: [salesState]
    serves: SalesApi
    port: 8080
  }
}
`;

/** The refusal detail — one derived rule, byte-identical on all five
 *  (`domain-denial-detail-parity.test.ts` pins that half). */
const DETAIL = "operation 'cancel' is not allowed in the current state of Order.";

/** Per-backend: where the DOMAIN method lives, where the WORKFLOW STEP that
 *  calls it lives, and the call the step makes. */
const BACKENDS: {
  platform: string;
  /** The file holding the aggregate's operation methods. */
  domain: RegExp;
  /** The file holding the in-process workflow starter. */
  caller: RegExp;
  /** The domain-method invocation the workflow starter makes. */
  call: string;
}[] = [
  {
    platform: "node",
    domain: /\/domain\/order\.ts$/,
    caller: /\/http\/workflows\.ts$/,
    call: "o.cancel();",
  },
  {
    platform: "dotnet",
    domain: /\/Domain\/Orders\/Order\.cs$/,
    caller: /\/Application\/Workflows\/AutoCancelStartOrderPlacedHandler\.cs$/,
    call: "o.Cancel();",
  },
  {
    platform: "java",
    domain: /\/features\/orders\/Order\.java$/,
    caller: /\/application\/workflows\/OrdersDispatcher\.java$/,
    call: "o.cancel();",
  },
  {
    platform: "python",
    domain: /\/app\/domain\/order\.py$/,
    caller: /\/app\/dispatch\.py$/,
    call: "o.cancel()",
  },
  {
    platform: "elixir",
    // Phoenix hosts the operation on the CONTEXT module, and has always gated
    // it there — the only backend that was already correct.
    domain: /\/lib\/[^/]+\/orders\.ex$/,
    caller: /\/workflows\/auto_cancel\/start_order_placed\.ex$/,
    call: "cancel_order(o",
  },
];

async function pick(platform: string, path: RegExp): Promise<string> {
  const files = await generateSystemFiles(SOURCE(platform));
  const hit = [...files.entries()].find(([p]) => path.test(p));
  if (!hit) {
    throw new Error(
      `no emitted file matched ${path} for ${platform} — emitted:\n` +
        [...files.keys()].sort().join("\n"),
    );
  }
  return hit[1];
}

describe("M-T6.38 — the `when` state gate is a property of the domain method", () => {
  for (const b of BACKENDS) {
    it(`${b.platform}: the domain method refuses before it mutates`, async () => {
      const domain = await pick(b.platform, b.domain);
      expect(
        domain,
        "the `when` gate is missing from the domain method — every non-route " +
          "caller (workflow step, saga cascade, extern handler) then writes unrefused",
      ).toContain(DETAIL);
    });

    it(`${b.platform}: the workflow step reaches the gated domain method`, async () => {
      const caller = await pick(b.platform, b.caller);
      // The half that makes the assertion above load-bearing: if the starter
      // stopped calling the domain method, the gate could sit anywhere and this
      // suite would still be green.
      expect(caller).toContain(b.call);
    });

    it(`${b.platform}: a PRIVATE gated operation is gated too`, async () => {
      // A private operation has no route — which is precisely why the gate has
      // to live on the method: the only callers it can have are in-system ones.
      // (The validator warns that a private `when` exposes no `can-<op>` query;
      // it does NOT mean the gate is inert.)
      //
      // The workflow goes with it: `loom.workflow-private-operation` — a
      // workflow may only call PUBLIC operations — so the two-caller cascade
      // the other legs use cannot survive privatisation.  This leg asserts on
      // the domain method alone, which is the thing under test.
      const files = await generateSystemFiles(
        SOURCE(b.platform)
          .replace("operation cancel() when", "private operation cancel() when")
          .replace(WORKFLOW, ""),
      );
      const hit = [...files.entries()].find(([p]) => b.domain.test(p));
      expect(hit?.[1]).toContain(DETAIL);
    });

    it(`${b.platform}: an ungated operation emits no refusal`, async () => {
      // `place()` carries no `when`, so the same domain file must not have
      // grown a gate for it — a backend that widened the predicate onto every
      // operation would fail here rather than at runtime.
      const domain = await pick(b.platform, b.domain);
      expect(domain).not.toContain("operation 'place' is not allowed in the current state");
    });
  }
});
