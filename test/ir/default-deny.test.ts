// Default-deny enforcement (auth.md / quickstart §4.3).  Under
// `auth { enforcement: denyByDefault }`, every public aggregate action
// reachable on an `auth: required` backend must declare a `requires` gate;
// `requires true` is the explicit "intentionally public" escape.
// `enforcement: opt` (the default) preserves the per-`requires` opt-in.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function denyErrors(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === "loom.default-deny-ungated")
    .map((d) => d.message);
}

function sys(opts: { enforcement: string; authRequired: boolean; gate: string }): string {
  return `
system Helpdesk {
  user { id: string role: string }
  auth { enforcement: ${opts.enforcement} }
  subdomain S {
    context Tickets {
      aggregate Ticket {
        open: bool
        operation close() { ${opts.gate}open := false }
      }
      repository Tickets for Ticket { }
    }
  }
  storage primary { type: postgres }
  resource st { for: Tickets, kind: state, use: primary }
  api SupportApi from S
  deployable api { platform: node contexts: [Tickets] serves: SupportApi dataSources: [st] port: 8080${opts.authRequired ? " auth: required" : ""} }
}
`;
}

describe("default-deny enforcement", () => {
  it("rejects an ungated public operation under denyByDefault", async () => {
    const errs = await denyErrors(
      sys({ enforcement: "denyByDefault", authRequired: true, gate: "" }),
    );
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("Ticket.close");
    expect(errs[0]).toContain("requires");
  });

  it("accepts a real requires gate", async () => {
    const errs = await denyErrors(
      sys({
        enforcement: "denyByDefault",
        authRequired: true,
        gate: 'requires currentUser.role == "agent"\n        ',
      }),
    );
    expect(errs).toEqual([]);
  });

  it("accepts `requires true` as the intentionally-public escape", async () => {
    const errs = await denyErrors(
      sys({ enforcement: "denyByDefault", authRequired: true, gate: "requires true\n        " }),
    );
    expect(errs).toEqual([]);
  });

  it("does not enforce under the default `enforcement: opt`", async () => {
    const errs = await denyErrors(sys({ enforcement: "opt", authRequired: true, gate: "" }));
    expect(errs).toEqual([]);
  });

  it("does not enforce when the deployable is not auth: required", async () => {
    const errs = await denyErrors(
      sys({ enforcement: "denyByDefault", authRequired: false, gate: "" }),
    );
    expect(errs).toEqual([]);
  });

  // --- Creates + workflows (the command surface beyond operations/destroys) ---

  /** A system with an aggregate `create`, a command-triggered `workflow`, and a
   *  read `find` — commands gated by `gate`, the find by `findGate` (each a
   *  `requires …` clause, or "" for ungated). */
  function commandSys(gate: string, findGate = ""): string {
    return `
system Helpdesk {
  user { id: string role: string }
  auth { enforcement: denyByDefault }
  subdomain S {
    context Tickets {
      aggregate Ticket {
        subject: string
        open: bool
        create register(s: string) { ${gate}subject := s open := true }
      }
      repository Tickets for Ticket {
        find openOnes(): Ticket[] ${findGate}where open == true
      }
      workflow openTicket {
        create(s: string) { ${gate}let t = Ticket.register(s) }
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: Tickets, kind: state, use: primary }
  api SupportApi from S
  deployable api { platform: node contexts: [Tickets] serves: SupportApi dataSources: [st] port: 8080 auth: required }
}
`;
  }

  const OP_GATE = 'requires currentUser.role == "agent"\n        ';
  const FIND_GATE = 'requires currentUser.role == "agent" ';

  it("rejects an ungated public create under denyByDefault", async () => {
    const errs = await denyErrors(commandSys(""));
    expect(errs.some((m) => m.includes("Ticket.register"))).toBe(true);
  });

  it("rejects an ungated command-triggered workflow under denyByDefault", async () => {
    const errs = await denyErrors(commandSys(""));
    expect(errs.some((m) => m.includes("workflow 'openTicket'"))).toBe(true);
  });

  it("rejects an ungated repository find under denyByDefault", async () => {
    const errs = await denyErrors(commandSys(""));
    expect(errs.some((m) => m.includes("find 'Tickets.openOnes'"))).toBe(true);
  });

  it("accepts gated creates + workflows + finds (requires on every reachable endpoint)", async () => {
    const errs = await denyErrors(commandSys(OP_GATE, FIND_GATE));
    expect(errs).toEqual([]);
  });

  it("accepts `requires true` on a find as the intentionally-public escape", async () => {
    const errs = await denyErrors(commandSys(OP_GATE, "requires true "));
    expect(errs).toEqual([]);
  });

  it("does not flag the auto-`findAll` (no author gate surface)", async () => {
    // The synthesized `find all` list route has no source line to gate; only
    // author-declared named finds are in scope.  A system whose only read is the
    // auto-findAll must pass once its commands are gated.
    const src = `
system Helpdesk {
  user { id: string role: string }
  auth { enforcement: denyByDefault }
  subdomain S {
    context Tickets {
      aggregate Ticket {
        subject: string
        create register(s: string) { requires true subject := s }
      }
      repository Tickets for Ticket { }
    }
  }
  storage primary { type: postgres }
  resource st { for: Tickets, kind: state, use: primary }
  api SupportApi from S
  deployable api { platform: node contexts: [Tickets] serves: SupportApi dataSources: [st] port: 8080 auth: required }
}
`;
    expect(await denyErrors(src)).toEqual([]);
  });

  // --- Projections (the last read surface default-deny walked past) ---

  /** A system with one FOLDED and one QUERY-TIME projection, each gated by the
   *  matching argument (a `requires …` clause, or "" for ungated). */
  function projectionSys(foldedGate: string, queryGate: string): string {
    return `
system Helpdesk {
  user { id: string role: string }
  auth { enforcement: denyByDefault }
  subdomain S {
    context Tickets {
      aggregate Ticket { subject: string  open: bool }
      repository Tickets for Ticket { }
      event Opened { ticket: Ticket id  subject: string }
      projection TicketBook keyed by ticket ${foldedGate}{
        ticket: Ticket id
        subject: string
        on(e: Opened) { ticket := e.ticket  subject := e.subject }
      }
      projection OpenTickets ${queryGate}{
        subject: string
        from Ticket as t
        where t.open == true
        select subject = t.subject
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: Tickets, kind: state, use: primary }
  api SupportApi from S
  deployable api { platform: node contexts: [Tickets] serves: SupportApi dataSources: [st] port: 8080 auth: required }
}
`;
  }

  const PROJ_GATE = 'requires currentUser.role == "agent" ';

  it("rejects an ungated FOLDED projection under denyByDefault", async () => {
    // `/projections/ticket_book` and `/projections/ticket_book/{key}` publish
    // the read model's rows to any caller — the same hole as an ungated find,
    // and the one default-deny could not close until a folded projection could
    // both spell and enforce a gate.
    const errs = await denyErrors(projectionSys("", PROJ_GATE));
    expect(errs.some((m) => m.includes("projection 'TicketBook'"))).toBe(true);
    expect(errs.some((m) => m.includes("OpenTickets"))).toBe(false);
  });

  it("rejects an ungated QUERY-TIME projection under denyByDefault", async () => {
    const errs = await denyErrors(projectionSys(PROJ_GATE, ""));
    expect(errs.some((m) => m.includes("projection 'OpenTickets'"))).toBe(true);
    expect(errs.some((m) => m.includes("TicketBook"))).toBe(false);
  });

  it("accepts both projection kinds once gated", async () => {
    expect(await denyErrors(projectionSys(PROJ_GATE, PROJ_GATE))).toEqual([]);
  });

  it("`requires true` is the intentionally-public escape for a projection too", async () => {
    expect(await denyErrors(projectionSys("requires true ", "requires true "))).toEqual([]);
  });

  it("does not enforce projections under `enforcement: opt`", async () => {
    const opt = projectionSys("", "").replace(
      "auth { enforcement: denyByDefault }",
      "auth { enforcement: opt }",
    );
    expect(await denyErrors(opt)).toEqual([]);
  });
});

// An explicit `commandHandler` / `queryHandler` bound through an
// `api { route <M> "<path>" -> <Ctx>.<Handler> }` is a real HTTP endpoint on
// all five backends, but `validateDefaultDeny` used to walk right past it —
// it enumerated aggregate actions, workflow command entries, finds and
// history, and never touched `ctx.commandHandlers` / `ctx.queryHandlers`.
function handlerSys(opts: { gate: string; extern: boolean }): string {
  const handler = opts.extern
    ? `      extern commandHandler CancelOrder(orderId: Order id): Order id;`
    : `      commandHandler CancelOrder(orderId: Order id): Order id {
        ${opts.gate}
        let o = Orders.getById(orderId)
        o.cancel()
        return o.id
      }`;
  return `
system Shop {
  auth { enforcement: denyByDefault }
  user { id: string  role: string }
  subdomain Sales {
    context Ordering {
      aggregate Order {
        code: string
        status: string
        operation cancel() requires currentUser.role == "agent" { status := "cancelled" }
      }
      repository Orders for Order { }
${handler}
    }
  }
  api ShopApi from Sales {
    route POST "/orders/cancel" -> Ordering.CancelOrder
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable d {
    platform: node
    contexts: [Ordering]
    dataSources: [st]
    serves: ShopApi
    port: 4000
    auth: required
  }
}`;
}

describe("default-deny — route-bound explicit handlers", () => {
  it("flags an ungated route-bound commandHandler", async () => {
    const errs = await denyErrors(handlerSys({ gate: "", extern: false }));
    expect(errs.join("\n")).toContain("commandHandler 'Ordering.CancelOrder'");
    expect(errs.join("\n")).toContain('route POST "/orders/cancel"');
  });

  it("accepts a route-bound commandHandler whose body declares a gate", async () => {
    const errs = await denyErrors(
      handlerSys({ gate: 'requires currentUser.role == "agent"', extern: false }),
    );
    expect(errs.join("\n")).not.toContain("CancelOrder");
  });

  it("`requires true` is the intentionally-public escape here too", async () => {
    const errs = await denyErrors(handlerSys({ gate: "requires true", extern: false }));
    expect(errs.join("\n")).not.toContain("CancelOrder");
  });

  // An `extern` handler has NO body, so "add a `requires`" would be an
  // instruction it is impossible to follow.  The diagnostic has to name what
  // is actually actionable instead, or it is the audit-history trap again.
  it("tells an `extern` handler something it can actually act on", async () => {
    const errs = await denyErrors(handlerSys({ gate: "", extern: true }));
    const msg = errs.find((m) => m.includes("CancelOrder"))!;
    expect(msg).toContain("has no body");
    expect(msg).toContain("drop `extern`");
    expect(msg).not.toContain("Add a `requires <expr>` to its body");
  });
});
