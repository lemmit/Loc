// M-T5.20 — the DOMAIN FLOOR is remappable, and the remap moves BOTH halves.
//
// `domain-denial-detail-parity.test.ts` pins the resolved DEFAULT (422 with the
// "Unprocessable Entity" title) on all five backends. This file pins the other
// half of the same mechanism: that the floor is no longer a hardcoded literal
// but a value resolved through the api's `httpStatus <Error> -> <Code>` map —
// the identical clause that already worked for `Disallowed` /
// `UniquenessConflict` / `ConcurrencyConflict` / `ReferencedInUse`.
//
// The reason this needs its own test rather than trusting the refactor: the
// runtime exception-handler arm and the declared OpenAPI `responses` map are
// built by SEPARATE code paths on every backend. A refactor that routes only the
// arm through the resolver produces exactly the runtime/declaration drift the
// override mechanism exists to prevent — the server answers 400 while the
// published contract still advertises 422. So each case asserts both.
//
// Scope note: the four non-elixir backends. The elixir leg lands separately.
//
// What "declaration" means per backend, since the four spell it differently:
//   node    — the `responses: { <status>: { description, content } }` block of
//             the emitted `createRoute({ ... })`.
//   dotnet  — `[ProducesResponseType(typeof(ProblemDetails), <status>)]`.
//   java    — the springdoc customizer's route contract (`"errors":[{"status":…}]`).
//   python  — the FastAPI `responses={<status>: {"model": ProblemDetails, …}}` kwarg.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** A single aggregate whose operation carries BOTH a `precondition` (the domain
 *  floor) and a `requires` guard (the Forbidden rung). No `unique`, no `when`,
 *  no destroy — so a 409 / 402 appearing anywhere in the output can only have
 *  come from a remapped rung, never from a structural conflict. */
const SOURCE = (platform: string, apiBody: string) => `
system Denials {
  user { id: string, level: int }
  subdomain Sales {
    context Sales {
      aggregate Order {
        total: int

        create(total: int)

        operation cancel() {
          requires currentUser.level > 2
          precondition total > 0
          total := 0
        }
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales ${apiBody}
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable api {
    platform: ${platform}
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 8080
    auth: required
  }
}
`;

async function emit(platform: string, apiBody: string): Promise<string> {
  const files = await generateSystemFiles(SOURCE(platform, apiBody));
  return [...files.values()].join("\n");
}

/** The RUNTIME exception-handler arm each backend answers a `DomainError` with,
 *  as a literal fragment of its emitted source: `(status, title, …)`. */
const RUNTIME_ARM: Record<string, (status: number, title: string) => string> = {
  node: (s, t) => `return problem(${s}, "${t}", err.message);`,
  dotnet: (s, t) => `Problem(context, ${s}, "${t}", de.Message, trace_id);`,
  java: (s, t) => `return respond(problem(${s}, "${t}", e.getMessage(), request), ${s});`,
  python: (s, t) => `return problem(request, ${s}, "${t}", str(err))`,
};

/** The DECLARED response for that same status, per backend spelling. */
const DECLARED: Record<string, (status: number) => RegExp> = {
  node: (s) =>
    new RegExp(`${s}: \\{ description: "[^"]+", content: \\{ "application/problem\\+json"`),
  dotnet: (s) => new RegExp(`\\[ProducesResponseType\\(typeof\\(ProblemDetails\\), ${s}\\)\\]`),
  // springdoc has no per-route response annotations; the customizer bakes the
  // declared error set as a `new int[] { … }` literal per route.
  java: (s) => new RegExp(`new int\\[\\] \\{[^}]*\\b${s}\\b`),
  python: (s) => new RegExp(`${s}: \\{"model": ProblemDetails`),
};

const PLATFORMS = ["node", "dotnet", "java", "python"] as const;

describe("M-T5.20 — the domain floor resolves through `httpStatus`", () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: with no override the floor is 422 / "Unprocessable Entity" (byte-identical default)`, async () => {
      const out = await emit(platform, "");
      expect(out).toContain(RUNTIME_ARM[platform](422, "Unprocessable Entity"));
      expect(out).toMatch(DECLARED[platform](422));
    });

    // The mission's motivating case: a client that cannot handle 422.
    it(`${platform}: \`httpStatus DomainError -> 400\` moves the runtime arm`, async () => {
      const out = await emit(platform, "{ httpStatus DomainError -> 400 }");
      expect(out).toContain(RUNTIME_ARM[platform](400, "Bad Request"));
      // …and the old literal is gone from the domain arm.
      expect(out).not.toContain(RUNTIME_ARM[platform](422, "Unprocessable Entity"));
      // 400 is already a declared response on the create/operation routes
      // (malformed body), so the contract stays consistent by construction.
      expect(out).toMatch(DECLARED[platform](400));
    });

    // A code NOTHING else in this system declares, so its appearance in the
    // `responses` map can only be the declaration side reading the resolved
    // value. This is the assertion that would fail if only the runtime arm had
    // been converted.
    it(`${platform}: \`httpStatus DomainError -> 402\` moves the runtime arm AND the declared response`, async () => {
      const base = await emit(platform, "");
      expect(base, "402 must not appear without the override").not.toMatch(DECLARED[platform](402));

      const out = await emit(platform, "{ httpStatus DomainError -> 402 }");
      expect(out).toContain(RUNTIME_ARM[platform](402, "Payment Required"));
      expect(out, "the declared responses did not follow the runtime arm").toMatch(
        DECLARED[platform](402),
      );
    });
  }
});

describe("M-T5.20 — the `Forbidden` rung resolves the same way", () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: \`httpStatus Forbidden -> 402\` moves the runtime arm AND the declaration`, async () => {
      const out = await emit(platform, "{ httpStatus Forbidden -> 402 }");
      const arm: Record<string, string> = {
        node: 'return problem(402, "Payment Required", err.message);',
        dotnet: 'Problem(context, 402, "Payment Required", fe.Message, trace_id);',
        java: 'return respond(problem(402, "Payment Required", e.getMessage(), request), 402);',
        python: 'return problem(request, 402, "Payment Required", str(err))',
      };
      expect(out).toContain(arm[platform]);
      // The `requires`-guarded operation declares the authorization outcome at
      // the remapped code, not a stale 403.
      expect(out).toMatch(DECLARED[platform](402));
    });
  }
});
