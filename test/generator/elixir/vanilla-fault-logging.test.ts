import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// Vanilla (Ecto/Phoenix, non-Ash) foundation — domain-seam fault logging
// (S1 of the observability parity drain, docs/audits/domain-seam-log-parity.md).
//
// The vanilla foundation emitted NO domain-seam catalog log events. The
// shared `<App>Web.ProblemDetails` module is the single chokepoint every
// fault response flows through (incl. not_found_response/3, which delegates
// to problem_response/4), so logging there gives the whole fault tier in one
// place. Events match the cross-backend catalog (src/generator/_obs/
// log-events.ts) and carry each fault's REAL HTTP status (vanilla validation
// is 422 by Ecto convention — not normalised to the other backends' 400).

const SOURCE = `
system ObsFault {
  subdomain Sales {
    context Orders {
      aggregate Order { code: string }
      repository Orders for Order { }
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

describe("vanilla — fault-tier catalog logging", () => {
  it("ProblemDetails requires Logger and logs the fault events by status", async () => {
    const files = await generateSystemFiles(SOURCE);
    const pd = files.get([...files.keys()].find((k) => k.endsWith("_web/problem_details.ex"))!)!;
    expect(pd).toBeDefined();
    expect(pd).toContain("require Logger");

    // The 422 validation path logs domain_error with its real status.
    expect(pd).toContain(
      'Logger.warning("domain_error", event: "domain_error", message: "Validation failed", status: 422)',
    );

    // The generic problem_response/4 classifies by status — one event per
    // fault, with the real HTTP status emitted (not normalised).
    expect(pd).toContain(
      '403 -> Logger.warning("forbidden", event: "forbidden", message: detail, status: status)',
    );
    expect(pd).toContain(
      '409 -> Logger.warning("disallowed", event: "disallowed", message: detail, status: status)',
    );
    expect(pd).toContain('404 -> Logger.warning("not_found", event: "not_found", status: status)');
    expect(pd).toContain(
      '_ when status >= 500 -> Logger.error("internal_error", event: "internal_error", error: detail, status: status)',
    );
    expect(pd).toContain(
      '_ -> Logger.warning("domain_error", event: "domain_error", message: detail, status: status)',
    );
  });
});
