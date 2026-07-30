// `ui: <Ui> { <param>: <deployable> }` must accept a trailing comma, like every
// other deployable member.
//
// It didn't: `UiComposeBinding` was the one member rule without a trailing
// `','?`, so `ui: WebApp { Sales: api }, port: 3001` was a PARSE ERROR.  The
// damage was hidden rather than loud — Langium error-recovers into a usable
// AST, so callers that don't inspect diagnostics (the `generateSystemFiles`
// test helper, the playground) accepted it silently, while `ddd parse` and
// `parseValid` rejected the same source.  ~30 fixtures in this repo were
// parsing with that hidden error.

import { describe, expect, it } from "vitest";
import { parseString } from "../_helpers/parse.js";

const sys = (deployableBody: string): string => `
system S {
  subdomain Sales { context Orders {
    aggregate Customer { name: string }
    repository Customers for Customer { } } }
  api SalesApi from Sales
  storage pg { type: postgres }
  ui WebApp { api Sales: SalesApi  page X { route: "/x"  body: Text { "hi" } } }
  deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
  deployable web { platform: static, targets: api, ${deployableBody} }
}
`;

describe("UiComposeBinding trailing comma", () => {
  it("parses with the compose block followed by another member", async () => {
    const { errors } = await parseString(sys("ui: WebApp { Sales: api }, port: 3001"), {
      validate: true,
    });
    expect(errors, `unexpected: ${errors.join("\n")}`).toEqual([]);
  });

  it("still parses with the compose block last", async () => {
    const { errors } = await parseString(sys("port: 3001, ui: WebApp { Sales: api }"), {
      validate: true,
    });
    expect(errors, `unexpected: ${errors.join("\n")}`).toEqual([]);
  });

  it("parses the sugar binding in either position (unchanged)", async () => {
    for (const body of ["ui: WebApp, port: 3001", "port: 3001, ui: WebApp"]) {
      const { errors } = await parseString(sys(body), { validate: true });
      // The sugar form binds no api params, so the ui's `api Sales:` parameter
      // is unbound — that's a VALIDATION complaint, not a parse failure.  Assert
      // only that no parse error ("Expecting token") is reported.
      expect(errors.filter((e) => e.includes("Expecting token"))).toEqual([]);
    }
  });
});
