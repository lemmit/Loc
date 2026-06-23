// Cross-backend parity: operation `requires` authorization lives at the
// APPLICATION/HANDLER boundary, never inside the pure domain method.
//
// This pins the invariant the authz-relocation slice established
// (docs/proposals/authorization.md §1/§11 phase 3): for an *authz-only*
// operation (`requires currentUser…` with no currentUser-as-data use), the
// generated DOMAIN method/action carries no authorization throw and no ambient
// principal param — the 403 gate is emitted in the handler (route / Mediator
// command / Spring service / FastAPI route), before the domain dispatch.  The
// domain `precondition` (400) stays in the body.
//
// Elixir/Ash was already the target shape (the gate is an Ash policy reading
// `actor`; the action body is pure) — it's asserted here as the reference so a
// future regression on any backend trips this fast (no-docker) gate.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

function system(platform: string, slug: string): string {
  return `
system Shop {
  user { id: guid  role: string }
  subdomain Sales {
    context Orders {
      aggregate Order ids guid with crudish {
        status: string = "open"
        operation cancel() {
          requires currentUser.role == "admin"
          precondition status == "open"
          status := "cancelled"
        }
      }
      repository Orders for Order { }
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable ${slug} {
    platform: ${platform}
    contexts: [Orders]
    dataSources: [s]
    serves: A
    auth: required
    port: 4000
  }
}`;
}

interface Case {
  readonly platform: string;
  readonly slug: string;
  /** The pure-domain method/action file for the Order aggregate. */
  readonly domain: RegExp;
  /** The application/handler file the 403 gate must relocate to. */
  readonly handler: RegExp;
}

const CASES: readonly Case[] = [
  {
    platform: "node",
    slug: "nodeApi",
    domain: /node_api\/domain\/order\.ts$/,
    handler: /node_api\/http\/order\.routes\.ts$/,
  },
  {
    platform: "dotnet",
    slug: "dotnetApi",
    domain: /dotnet_api\/Domain\/Orders\/Order\.cs$/,
    handler: /dotnet_api\/Application\/Orders\/Commands\/CancelHandler\.cs$/,
  },
  {
    platform: "java",
    slug: "javaApi",
    domain: /java_api\/.*\/orders\/Order\.java$/,
    handler: /java_api\/.*\/orders\/OrderService\.java$/,
  },
  {
    platform: "python",
    slug: "pyApi",
    domain: /py_api\/app\/domain\/order\.py$/,
    handler: /py_api\/.*order_routes\.py$/,
  },
];

function find(files: Map<string, string>, re: RegExp): [string, string] {
  for (const [k, v] of files) if (re.test(k)) return [k, v];
  throw new Error(`no file matched ${re}; have:\n${[...files.keys()].join("\n")}`);
}

const FORBIDDEN = /forbidden/i; // ForbiddenError / ForbiddenException / :forbidden

describe("operation `requires` authz lives at the handler boundary (cross-backend parity)", () => {
  for (const { platform, slug, domain, handler } of CASES) {
    it(`${platform}: pure domain method, 403 gate in the handler`, async () => {
      const files = await generateSystemFiles(system(platform, slug));
      const [dPath, dSrc] = find(files, domain);
      const [hPath, hSrc] = find(files, handler);

      // Authorization is NOT woven into the domain method.
      expect(FORBIDDEN.test(dSrc), `${platform}: authz throw leaked into ${dPath}`).toBe(false);
      // The domain precondition (400 / domain rule) stays in the body.
      expect(dSrc.includes('"open"'), `${platform}: precondition dropped from ${dPath}`).toBe(true);
      // The 403 gate relocated to the application handler.
      expect(FORBIDDEN.test(hSrc), `${platform}: 403 gate missing from ${hPath}`).toBe(true);
    });
  }

  // Elixir/Ash — the reference end-state: the action body is pure (no inline
  // authorization raise); the gate is an Ash `policies` block reading the actor.
  it("elixir-ash: pure action body, authz via an Ash policy (already the target)", async () => {
    const files = await generateSystemFiles(system("elixir { foundation: ash }", "ashApi"));
    const [path, src] = find(files, /ash_api\/lib\/ash_api\/orders\/order\.ex$/);
    expect(src.includes("policies do"), `ash: expected an Ash policies block in ${path}`).toBe(
      true,
    );
  });
});
