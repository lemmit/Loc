import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// `auth { … }` block (D-AUTH-OIDC) — grammar + provider-preset lowering +
// the auth validator rules.  Covers the raw-issuer (keycloak) path, a
// hosted preset (google) resolving its issuer, claim mapping, and every
// negative diagnostic the validator emits.
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem);
const parse = parseHelper<Model>(services.Ddd);

async function parseModel(src: string): Promise<{ model: Model; errors: string[] }> {
  const doc = await parse(src, { validation: true });
  const diags = doc.diagnostics ?? [];
  return {
    model: doc.parseResult.value,
    errors: diags.filter((d) => d.severity === 1).map((d) => d.message),
  };
}

const USER = `user {
    id: string
    role: string
    email: string
  }`;

function system(body: string): string {
  return `system Acme {\n  ${USER}\n  ${body}\n}`;
}

describe("auth block — parsing & lowering", () => {
  it("resolves a raw keycloak issuer + claims into AuthIR", async () => {
    const { model, errors } = await parseModel(
      system(`auth {
        provider: keycloak
        oidc {
          issuer: env("OIDC_ISSUER")
          clientId: env("OIDC_CLIENT_ID")
        }
        sessions: cookie
        claims: { role: "realm_access.roles", email: "email" }
        enforcement: denyByDefault
      }`),
    );
    expect(errors).toEqual([]);
    const sys = lowerModel(model).systems[0]!;
    expect(sys.auth).toBeDefined();
    const auth = sys.auth!;
    expect(auth.provider).toBe("keycloak");
    expect(auth.oidc.issuer).toEqual({ kind: "env", env: "OIDC_ISSUER" });
    expect(auth.oidc.clientId).toEqual({ kind: "env", env: "OIDC_CLIENT_ID" });
    expect(auth.sessions).toBe("cookie");
    expect(auth.enforcement).toBe("denyByDefault");
    expect(auth.claims).toEqual([
      { field: "role", path: "realm_access.roles" },
      { field: "email", path: "email" },
    ]);
    // keycloak preset carries default scopes.
    expect(auth.oidc.scopes).toContain("openid");
  });

  it("resolves a hosted preset's fixed issuer (google)", async () => {
    const { model, errors } = await parseModel(
      system(`auth {
        provider: google
        oidc { clientId: env("CLIENT_ID") }
      }`),
    );
    expect(errors).toEqual([]);
    const auth = lowerModel(model).systems[0]!.auth!;
    expect(auth.oidc.issuer).toEqual({ kind: "literal", value: "https://accounts.google.com" });
    // defaults: sessions=cookie, enforcement=opt
    expect(auth.sessions).toBe("cookie");
    expect(auth.enforcement).toBe("opt");
  });

  it("an explicit oidc.issuer overrides the preset", async () => {
    const { model, errors } = await parseModel(
      system(`auth {
        provider: google
        oidc { issuer: "https://idp.internal", clientId: env("CLIENT_ID") }
      }`),
    );
    expect(errors).toEqual([]);
    const auth = lowerModel(model).systems[0]!.auth!;
    expect(auth.oidc.issuer).toEqual({ kind: "literal", value: "https://idp.internal" });
  });

  it("lowers `auth: ui` on a deployable to ui mode", async () => {
    // (React `ui:`/`targets:` diagnostics are orthogonal — lowering runs
    // regardless; this asserts the `auth: ui` mode itself lowers.)
    const { model } = await parseModel(
      system(`auth { provider: google, oidc { clientId: env("CID") } }
      deployable web { platform: react, auth: ui }`),
    );
    const dep = lowerModel(model).systems[0]!.deployables.find((d) => d.name === "web")!;
    expect(dep.auth).toEqual({ required: false, ui: true });
  });
});

describe("auth block — validation", () => {
  it("rejects an auth block without a user block", async () => {
    const { errors } = await parseModel(
      `system Acme {
        auth { provider: keycloak, oidc { issuer: "https://idp", clientId: env("C") } }
      }`,
    );
    expect(errors.some((e) => e.includes("requires a `user"))).toBe(true);
  });

  it("rejects an unknown provider", async () => {
    const { errors } = await parseModel(
      system(`auth { provider: facebook, oidc { issuer: "https://idp", clientId: env("C") } }`),
    );
    expect(errors.some((e) => e.includes("unknown auth provider 'facebook'"))).toBe(true);
  });

  it("requires an issuer for a self-hosted provider", async () => {
    const { errors } = await parseModel(
      system(`auth { provider: keycloak, oidc { clientId: env("C") } }`),
    );
    expect(errors.some((e) => e.includes("self-hosted") && e.includes("issuer"))).toBe(true);
  });

  it("requires a clientId", async () => {
    const { errors } = await parseModel(system(`auth { provider: google }`));
    expect(errors.some((e) => e.includes("clientId"))).toBe(true);
  });

  it("rejects a claim mapping onto an unknown user field", async () => {
    const { errors } = await parseModel(
      system(`auth {
        provider: google
        oidc { clientId: env("C") }
        claims: { nope: "x" }
      }`),
    );
    expect(errors.some((e) => e.includes("unknown user field 'nope'"))).toBe(true);
  });

  it("rejects two auth blocks in one system", async () => {
    const { errors } = await parseModel(
      system(`auth { provider: google, oidc { clientId: env("C") } }
      auth { provider: google, oidc { clientId: env("C") } }`),
    );
    expect(errors.some((e) => e.includes("more than one 'auth"))).toBe(true);
  });
});
