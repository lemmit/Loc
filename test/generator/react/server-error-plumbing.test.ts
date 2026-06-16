// Regression: the generated React form server-error decoder must read the
// shape the generated API client actually throws.
//
// `applyServerErrors` decoded `(error as { response?: { status, data } })` — an
// axios-style envelope — but the generated `rawFetch` throws an `ApiError` that
// carries only `.status` + `.message` and *discards* the parsed ProblemDetails
// body.  So `r` was always `undefined`, every 422 fell through to
// `{ kind: "unhandled" }`, and per-field validation errors never reached the
// form.  The whole frontend-acl 422 path (validation-error-extension.md) was
// dormant in production.
//
// Fix: `ApiError` carries the parsed body; `applyServerErrors` reads
// `.status` / `.body` off the thrown error.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Acme {
  subdomain People {
    context P {
      aggregate Engineer {
        handle: string
        check handle.length > 0
      }
      repository Engineers for Engineer { }
    }
  }
  api PeopleApi from People
  ui WebApp with scaffold(subdomains: [People]) { api People: PeopleApi }
  storage primarySql { type: postgres }
  resource pState { for: P, kind: state, use: primarySql }
  deployable api {
    platform: hono
    contexts: [P]
    dataSources: [pState]
    serves: PeopleApi
    port: 3001
  }
  deployable web_app {
    platform: static
    targets: api
    ui: WebApp { People: api }
    port: 5173
  }
}
`;

describe("react — server-error plumbing matches the API client", () => {
  it("ApiError carries the parsed body, and rawFetch passes it through", async () => {
    const files = await generateSystemFiles(SRC);
    const client = files.get("web_app/src/api/client.ts");
    expect(client, "api/client.ts").toBeDefined();
    // ApiError must retain the parsed response body (the ProblemDetails),
    // not just status + message.
    expect(client).toMatch(/class ApiError[\s\S]*body/);
    // rawFetch must pass the parsed body into the thrown ApiError.
    expect(client).toMatch(/throw new ApiError\(r\.status, message, body\)/);
  });

  it("applyServerErrors reads the thrown error's status/body, not a .response envelope", async () => {
    const files = await generateSystemFiles(SRC);
    const ase = files.get("web_app/src/lib/apply-server-errors.ts");
    expect(ase, "lib/apply-server-errors.ts").toBeDefined();
    // The axios-style `.response` envelope was the bug — the client never sets it.
    expect(ase).not.toContain(".response");
    // It reads the ApiError's own fields.
    expect(ase).toContain("status");
    expect(ase).toContain("body");
  });
});
