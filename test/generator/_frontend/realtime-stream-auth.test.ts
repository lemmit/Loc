import { describe, expect, it } from "vitest";
import { realtimeStreamCredential } from "../../../src/ir/util/realtime-rooms.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Realtime stream authentication — the cross-frontend contract (M-T4.12,
// the 08-24 generator review §F4 / follow-up register row 20).
//
// Every backend's SSE route sits behind its auth middleware (node's
// `authMiddleware`, python's `AuthMiddleware`, elixir's `:sse` pipeline + Auth
// plug since #2667's A4 fix, .NET and Java likewise) — the route is on NO
// backend's bypass list.  The shared frontend client used to emit a BARE
// `new EventSource(`${API_BASE_URL}/realtime/events`)`: no `withCredentials`,
// no token, and `EventSource` cannot set an `Authorization` header by
// construction.  The generated compose points the bundle at the backend's own
// port (`VITE_API_BASE_URL: http://localhost:8080/api`), so the stream is
// CROSS-ORIGIN, the browser omits the session cookie, and every generated SPA
// 401s on an `auth: required` deployable.
//
// The contract (`realtimeStreamCredential`, src/ir/util/realtime-rooms.ts
// RULE 2): the stream carries the SAME credential as an ordinary API call —
// the HttpOnly `session` cookie, via `withCredentials: true`, under exactly the
// gate that puts `credentials: "include"` on the api client.  `auth: none`
// stays byte-identical.
// ---------------------------------------------------------------------------

/** One system per frontend framework: an `auth: required` Hono backend with an
 *  `auth { oidc }` block and a broadcast channel, plus an `auth: ui` SPA that
 *  handles the carried event (so the realtime client is emitted). */
function authedSystem(framework: string): string {
  return `
system RealtimeAuth {
  user {
    id: string
    role: string
  }
  auth {
    provider: keycloak
    oidc {
      issuer: env("OIDC_ISSUER")
      clientId: env("OIDC_CLIENT_ID")
    }
    claims: { role: "realm_access.roles" }
  }
  subdomain Shipping {
  context Fulfillment {
    aggregate Order { customerId: string  status: string }
    repository Orders for Order { }
    event OrderPlaced { order: Order id, at: datetime }
    channel Lifecycle {
      carries: OrderPlaced
      delivery: broadcast
      retention: ephemeral
    }
  }
  }
  api FulfillmentApi from Shipping
  ui WebApp {
    api Fulfillment: FulfillmentApi
    channel Live: Fulfillment.Lifecycle
    on Live.OrderPlaced(e) { toast("Order placed") }
    page Home { route: "/" body: Heading { "hi" } }
  }
  storage loomDb { type: postgres }
  resource fulfillmentState { for: Fulfillment, kind: state, use: loomDb }
  deployable backend {
    platform: node
    contexts: [Fulfillment] dataSources: [fulfillmentState]
    serves: FulfillmentApi
    port: 3000
    auth: required
  }
  deployable webApp {
    platform: ${framework}
    targets: backend
    ui: WebApp { Fulfillment: backend }
    port: 3001
    auth: ui
  }
}
`;
}

/** The same system with NO auth anywhere — the byte-identical control. */
function anonSystem(framework: string): string {
  return authedSystem(framework)
    .replace(/\n {2}auth: required/, "")
    .replace(/\n {4}auth: ui/, "");
}

/** Files emitted under the `webApp` deployable's own directory. */
async function frontendFiles(src: string): Promise<Map<string, string>> {
  const all = await generateSystemFiles(src);
  const out = new Map<string, string>();
  for (const [p, c] of all) {
    if (p.startsWith("web_app/")) out.set(p.slice("web_app/".length), c);
  }
  return out;
}

/** Per-framework path of the emitted realtime client module. */
const CLIENT_PATH: Record<string, string> = {
  react: "src/api/realtime.ts",
  vue: "src/api/realtime.ts",
  angular: "src/api/realtime.ts",
  svelte: "src/lib/api/realtime.ts",
};

describe("realtime SSE stream carries the api client's credential (M-T4.12)", () => {
  for (const framework of ["react", "vue", "svelte", "angular"]) {
    it(`${framework}: an auth: ui SPA opens the stream with withCredentials`, async () => {
      const out = await frontendFiles(authedSystem(framework));
      const client = out.get(CLIENT_PATH[framework] ?? "") ?? "";
      expect(client).not.toBe("");

      // THE assertion this test exists for.  A bare `new EventSource(url)` here
      // is the 401 — the cross-origin stream carries no session cookie.
      expect(client).toContain(
        "new EventSource(`${API_BASE_URL}/realtime/events`, { withCredentials: true })",
      );

      // …and it is the SAME credential the ordinary api client uses, which is
      // what makes "the stream authenticates like any other call" true rather
      // than a second, parallel auth channel.
      const apiClient = out.get("src/api/client.ts") ?? out.get("src/lib/api/client.ts") ?? "";
      expect(apiClient).toContain('credentials: "include"');
    });

    it(`${framework}: an auth: none SPA keeps the bare v1 constructor`, async () => {
      const out = await frontendFiles(anonSystem(framework));
      const client = out.get(CLIENT_PATH[framework] ?? "") ?? "";
      expect(client).toContain("new EventSource(`${API_BASE_URL}/realtime/events`);");
      expect(client).not.toContain("withCredentials");
    });
  }

  it("feliz: an auth: ui app opens the stream with withCredentials", async () => {
    // Feliz emits an F# `[<Emit>]` shim around the browser constructor rather
    // than a `realtime.ts` module, and its routes are relative + same-origin
    // (`/api/...`), where a cookie flows either way.  It states the credential
    // anyway so the contract does not silently depend on that.
    const all = await generateSystemFiles(authedSystem("feliz"));
    const app = all.get("web_app/src/App.fs") ?? "";
    expect(app).not.toBe("");
    expect(app).toContain('[<Fable.Core.Emit("new EventSource($0, { withCredentials: true })")>]');
  });

  it("feliz: an auth: none app keeps the bare v1 shim", async () => {
    const all = await generateSystemFiles(anonSystem("feliz"));
    const app = all.get("web_app/src/App.fs") ?? "";
    expect(app).toContain('[<Fable.Core.Emit("new EventSource($0)")>]');
    expect(app).not.toContain("withCredentials");
  });

  it("node's OIDC verifier accepts the session cookie the stream presents", async () => {
    // `EventSource` cannot set an `Authorization` header, so a header-only
    // verifier 401s the stream even WITH `withCredentials`.  Four backends
    // already read this cookie; node was the outlier.
    const all = await generateSystemFiles(authedSystem("react"));
    const oidc = all.get("backend/auth/oidc.ts") ?? "";
    expect(oidc).not.toBe("");
    expect(oidc).toContain('const cookies = req.headers.get("cookie");');
    expect(oidc).toContain('if (pair.slice(0, eq).trim() !== "session") continue;');
  });
});

describe("realtimeStreamCredential — the plan-level gate (M-T4.12 RULE 2)", () => {
  const user = { fields: [] };

  it("is the session cookie only when auth: ui meets an auth: required target", () => {
    expect(
      realtimeStreamCredential({ auth: { ui: true } }, { auth: { required: true } }, user),
    ).toBe("session-cookie");
  });

  it("is none when the frontend did not opt into auth: ui", () => {
    expect(
      realtimeStreamCredential({ auth: { ui: false } }, { auth: { required: true } }, user),
    ).toBe("none");
  });

  it("is none when the target backend does not require auth", () => {
    expect(
      realtimeStreamCredential({ auth: { ui: true } }, { auth: { required: false } }, user),
    ).toBe("none");
  });

  it("is none when the system declares no principal shape", () => {
    expect(
      realtimeStreamCredential({ auth: { ui: true } }, { auth: { required: true } }, undefined),
    ).toBe("none");
  });

  it("is none when the target deployable does not resolve", () => {
    expect(realtimeStreamCredential({ auth: { ui: true } }, undefined, user)).toBe("none");
  });
});
