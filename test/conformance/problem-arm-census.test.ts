// M-T9.25 probe 1 — the RFC 7807 arm census.
//
// Every gate this repo owns compares one backend to something ELSE:
// `conformance-parity` to another backend, the M-T9.11 wire golden to the node
// oracle, an RS-rule to a named contract.  **Nothing enumerates the places a
// single backend emits the same wire concept and checks they agree with each
// other.**  So a backend that disagrees with ITSELF passes everything — and when
// all five drift the same way, the oracle drifts too and the golden is green.
//
// This is the cheap structural answer for the richest such concept: the 7807
// error arm.  Five of the twenty-six RS-rules (RS-16, 17, 19, 21, 22) were found
// on an error response, while only FOUR of the 31 wire goldens record an error
// body at all (404 x2, 409, 422) — so this surface has the worst
// coverage-to-yield ratio in the toolchain.
//
// Two claims, and they are different in kind:
//
//   1. INTRA-backend — every arm a backend emits for one rung agrees with its
//      own siblings.  This is the claim no other gate makes.  It caught node
//      emitting FOUR independent `app.onError` handlers of which one was
//      unconverted, so `httpStatus DomainError -> N` moved three routers and
//      silently not the fourth.
//   2. CROSS-backend — the five agree with each other on the rung's title and
//      detail.  This is byte-identity, the premise of the wire golden, asserted
//      statically for the arms no fixture reaches.
//
// The RUNGS are deliberately distinguished, because collapsing them is itself
// the bug class:
//   * wire validation (a malformed BODY)      → 422 "Validation failed"
//   * the domain floor (a rejected OPERATION) → 422 "Unprocessable Entity"
// Both are 422.  A client seeing only status + reason phrase cannot tell them
// apart; `title` plus the `errors[]` pointer array is what distinguishes them.
// Python collapsed the two until RS-27 — it answered the *reason phrase* for a
// validation failure, which reads as a domain rejection.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** Carries an INVARIANT (so the wire-validation arm is emitted — .NET only
 *  renders its FluentValidation handler when a rule exists) and an operation
 *  with both guard rungs. */
const SOURCE = (platform: string) => `
system Census {
  user { id: string, level: int }
  subdomain S {
    context S {
      aggregate Item with crudish {
        name: string
        qty: int
        invariant qty >= 0
        operation bump() {
          requires currentUser.level > 2
          precondition qty < 100
          qty := qty + 1
        }
      }
      repository Items for Item { }
    }
  }
  api A from S
  storage pg { type: postgres }
  resource st { for: S, kind: state, use: pg }
  deployable api {
    platform: ${platform}
    contexts: [S]
    dataSources: [st]
    serves: A
    port: 8080
    auth: required
  }
}
`;

const PLATFORMS = ["node", "dotnet", "java", "python", "elixir"] as const;

/** The wire-validation arm's (title, detail) as each language spells it. One
 *  regex per backend rather than a shared one, because the call shapes genuinely
 *  differ — a single pattern loose enough to match all five would be loose
 *  enough to match the domain-floor arm too, which is the distinction under
 *  test. */
const VALIDATION_ARM: Record<string, RegExp> = {
  node: /title: "([^"]*)",\s*\n\s*status: 422,\s*\n\s*detail: "([^"]*)"/,
  dotnet: /Title = "([^"]*)",\s*\n\s*Status = 422,\s*\n\s*Detail = "([^"]*)"/,
  java: /problem\(422, "([^"]*)", "([^"]*)", request\)/,
  python: /problem\(request, 422, "([^"]*)", "([^"]*)", errors\)/,
  elixir: /title: "([^"]*)",\s*\n\s*status: 422,\s*\n\s*detail: "([^"]*)"/,
};

async function emit(platform: string): Promise<Map<string, string>> {
  return generateSystemFiles(SOURCE(platform));
}

async function joined(platform: string): Promise<string> {
  return [...(await emit(platform)).values()].join("\n");
}

describe("M-T9.25 — the 7807 arm census", () => {
  it("cross-backend: the wire-validation rung is identical on all five", async () => {
    // RS-27.  Python answered `"Unprocessable Entity"` / `"Request validation
    // failed."` where the other four say `"Validation failed"` / `"One or more
    // fields are invalid."` — the highest-traffic error path in any API, and
    // invisible to every gate: the only 422 any golden records is
    // `wire-contract`'s DOMAIN FLOOR, which is the other rung.
    const arms = await Promise.all(
      PLATFORMS.map(async (p) => {
        const m = VALIDATION_ARM[p]!.exec(await joined(p));
        return [p, m ? `${m[1]} | ${m[2]}` : "<no validation arm emitted>"] as const;
      }),
    );
    const expected = "Validation failed | One or more fields are invalid.";
    expect(Object.fromEntries(arms)).toEqual({
      node: expected,
      dotnet: expected,
      java: expected,
      python: expected,
      elixir: expected,
    });
  });

  it("the two 422 rungs stay distinguishable — validation is not the reason phrase", async () => {
    // The rung-collapse guard.  Both the malformed-body and rejected-operation
    // paths answer 422; if the validation arm ever adopts the status reason
    // phrase, a client can no longer tell "your JSON is wrong" from "your
    // request was understood and refused". That is what python did.
    for (const p of PLATFORMS) {
      const m = VALIDATION_ARM[p]!.exec(await joined(p));
      expect(
        m,
        `${p}: no wire-validation arm found — the fixture stopped covering it`,
      ).not.toBeNull();
      expect(
        m![1],
        `${p}: the validation rung is titled with the 422 reason phrase, collapsing it into the domain floor`,
      ).not.toBe("Unprocessable Entity");
    }
  });

  it("intra-backend: EVERY node router honours one override, not just some", async () => {
    // The claim no other gate makes.  node emits an independent `app.onError`
    // per router family; each carries its own copy of the ladder, so one can be
    // converted while a sibling stays hardcoded — and the joined output looks
    // correct because SOME router resolved.  Asserted per FILE for that reason.
    //
    // It MUST be asserted under an override.  The first version of this test
    // checked the DEFAULT emission for a literal `problem(422, "Unprocessable
    // Entity"` and flagged a correct router: `routes-builder` emits
    // `problem(${domainStatus}, …)`, which *resolves* to exactly that text when
    // nothing is overridden.  Default emission cannot distinguish "resolved to
    // the default" from "hardcoded" — only a non-default override can, which is
    // the same trap the sibling denial-ladder suite documents.
    const files = await generateSystemFiles(
      SOURCE("node").replace("api A from S", "api A from S { httpStatus DomainError -> 418 }"),
    );
    const routers = [...files.keys()].filter(
      (k) => /http\/.*\.ts$/.test(k) && !k.endsWith("index.ts"),
    );
    expect(
      routers.length,
      "no http routers emitted — fixture no longer covers this",
    ).toBeGreaterThan(0);

    // A router that answers the domain floor must now say 418.  One still
    // saying 422 did not read the override.
    const offenders = routers.filter((k) =>
      /problem\(422, "Unprocessable Entity"/.test(files.get(k)!),
    );
    expect(
      offenders,
      "router(s) ignored `httpStatus DomainError -> 418` — the override moves their " +
        "siblings and silently not these",
    ).toEqual([]);
  });
});
