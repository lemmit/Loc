// A `requires` gate that reads `currentUser`, on a deployable with no auth.
//
// The third sibling of a rule that already existed twice — a principal-reading
// `filter` is refused (`loom.context-filter-unsupported#no-auth-user`), and so
// is a principal-reading `stamp` (`loom.stamp-principal-without-auth`) — for
// the same reason: with no auth there is no request-scoped principal, so the
// clause is unimplementABLE, not merely unimplemented.  The guard was the
// missing one, and it is the one that emits.
//
// Measured on `main` before this check, from ordinary Loom: `ddd parse` said
// `0 error(s), 0 warning(s)`, and the emitted node project failed to compile
// with `error TS2304: Cannot find name 'currentUser'` — the gate was rendered
// with a free identifier.  Python, .NET and Java emit the structurally
// identical unbound read.
//
// The two variants below are NOT redundant.  With no auth anywhere, lowering
// has nothing to resolve `currentUser` against and the ref lands as
// `refKind: "unknown"`; with a system `user {}` present but the deployable
// opting out, it resolves to `current-user`.  A check written against
// `exprUsesCurrentUser` (which tests the refKind) sees only the second — i.e.
// it reports the harmless variant and misses the one that does not compile.

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/index.js";

const CODE = "loom.guard-principal-without-auth";

const AGG = `
      aggregate Doc {
        title: string
        create(title: string) { title := title }
        operation publish() {
          requires currentUser.role == "editor"
          title := title
        }
      }`;

const sys = (opts: { authBlock?: boolean; depAuth?: boolean; agg?: string }): string => `
system P {
  ${opts.authBlock ? `user { role: string }\n  auth { oidc { issuer: "https://idp.example.com"  clientId: "app" } }` : ""}
  subdomain D {
    context C {
${opts.agg ?? AGG}
      repository Docs for Doc { }
    }
  }
  api A from D
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable d { platform: node contexts: [C] dataSources: [st] serves: A ${opts.depAuth ? "auth: required" : ""} port: 3000 }
}
`;

async function codesFor(src: string): Promise<string[]> {
  return validateLoomModel(await buildLoomModel(src))
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
}

describe("validator — a principal guard on a deployable with no auth", () => {
  it("rejects it when the system declares no auth at all (the unresolved-ref variant)", async () => {
    expect(await codesFor(sys({}))).toContain(CODE);
  });

  it("rejects it when the system HAS auth but this deployable opts out", async () => {
    expect(await codesFor(sys({ authBlock: true }))).toContain(CODE);
  });

  it("names the consequence — the emitted gate does not compile", async () => {
    const [diag] = validateLoomModel(await buildLoomModel(sys({}))).filter(
      (d) => d.severity === "error",
    );
    expect(diag.code).toBe(CODE);
    expect(diag.message).toContain("does not compile");
    expect(diag.message).toContain("auth: required");
    // The site, so a multi-aggregate system says WHICH gate.
    expect(diag.message).toContain("Doc.publish");
  });

  it("covers a find gate, not just an operation", async () => {
    const codes = await codesFor(`
system P {
  subdomain D {
    context C {
      aggregate Doc { title: string }
      repository Docs for Doc {
        find byTitle(t: string): Doc[] requires currentUser.role == "editor" where title == t
      }
    }
  }
  api A from D
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable d { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
}
`);
    expect(codes).toContain(CODE);
  });

  // The third of the plan's three sites.  A lifecycle guard ALSO draws
  // `loom.lifecycle-body-dropped` today (the body reaches no emitter at all),
  // so this asserts membership rather than sole occupancy — the two are
  // independent facts about the same clause, and this one outlives the other.
  it("covers a lifecycle gate", async () => {
    const codes = await codesFor(
      sys({
        agg: `
      aggregate Doc {
        title: string
        destroy {
          requires currentUser.role == "editor"
        }
      }`,
      }),
    );
    expect(codes).toContain(CODE);
  });

  // ---- negatives ---------------------------------------------------------

  it("allows the gate on a deployable that HAS auth", async () => {
    expect(await codesFor(sys({ authBlock: true, depAuth: true }))).not.toContain(CODE);
  });

  it("says nothing about a gate that reads no principal", async () => {
    const codes = await codesFor(
      sys({
        agg: `
      aggregate Doc {
        title: string
        published: bool = false
        create(title: string) { title := title }
        operation publish() {
          requires published == false
          published := true
        }
      }`,
      }),
    );
    expect(codes).not.toContain(CODE);
  });
});
