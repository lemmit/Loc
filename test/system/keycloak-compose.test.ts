// Bundled dev Keycloak (D-AUTH-OIDC §4.2 — the zero-config quick-start).
// When a system declares a self-hosted OIDC `auth { … }` block, the generated
// docker-compose.yml adds a Keycloak service with a pre-provisioned realm +
// seeded demo user, and points the `auth: required` backend at it.  A hosted
// preset (e.g. google) uses its own IdP and gets no bundled service.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";

const services = createDddServices(NodeFileSystem);
const parse = parseHelper<Model>(services.Ddd);

async function filesFor(src: string): Promise<Map<string, string>> {
  const doc = await parse(src, { validation: false });
  return generateSystems(doc.parseResult.value).files;
}

function system(authBlock: string): string {
  return `
system Helpdesk {
  user { id: string role: string }
  ${authBlock}
  subdomain Support {
    context Tickets {
      aggregate Ticket { open: bool  operation close() { requires currentUser.role == "agent"  open := false } }
      repository Tickets for Ticket { }
    }
  }
  storage primary { type: postgres }
  resource st { for: Tickets, kind: state, use: primary }
  api SApi from Support
  deployable api { platform: node contexts: [Tickets] serves: SApi dataSources: [st] port: 8080 auth: required }
}`;
}

const KEYCLOAK = `auth { provider: keycloak  oidc { issuer: env("OIDC_ISSUER")  clientId: env("OIDC_CLIENT_ID") } }`;

describe("bundled dev Keycloak compose", () => {
  it("adds the Keycloak service + realm import + OIDC env under a self-hosted auth block", async () => {
    const files = await filesFor(system(KEYCLOAK));
    const compose = files.get("docker-compose.yml")!;
    expect(compose).toContain("keycloak:");
    expect(compose).toContain("quay.io/keycloak/keycloak");
    expect(compose).toContain("--import-realm");
    // backend points at the bundled IdP via the host-reachable issuer
    expect(compose).toContain('OIDC_ISSUER: "http://host.docker.internal:8081/realms/helpdesk"');
    expect(compose).toContain('OIDC_CLIENT_ID: "helpdesk-app"');
    expect(compose).toContain("host.docker.internal:host-gateway");
    // realm import: a client + a seeded demo user
    const realm = JSON.parse(files.get("keycloak/realm.json")!) as {
      realm: string;
      clients: { clientId: string }[];
      users: { username: string }[];
    };
    expect(realm.realm).toBe("helpdesk");
    expect(realm.clients[0]!.clientId).toBe("helpdesk-app");
    expect(realm.users[0]!.username).toBe("demo");
  });

  it("does not bundle Keycloak for a hosted provider (google)", async () => {
    const files = await filesFor(
      system(`auth { provider: google  oidc { clientId: env("OIDC_CLIENT_ID") } }`),
    );
    expect(files.get("docker-compose.yml")!).not.toContain("keycloak:");
    expect(files.has("keycloak/realm.json")).toBe(false);
  });

  it("does not bundle Keycloak without an auth block", async () => {
    const files = await filesFor(system(""));
    expect(files.get("docker-compose.yml")!).not.toContain("keycloak:");
    expect(files.has("keycloak/realm.json")).toBe(false);
  });
});
