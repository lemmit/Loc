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
});
