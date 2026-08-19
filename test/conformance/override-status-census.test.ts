// M-T9.25 round 2, probe 1 — the 4xx census UNDER AN OVERRIDE.
//
// Sweeps 1–4 of this mission (`problem-arm-census`, `not-found-by-id-detail-
// parity`, `denial-ladder-override-parity`'s cross-backend leg) all read
// DEFAULT emission.  Default emission structurally **cannot** distinguish
//
//     problem(${resolveErrorStatus("Disallowed", overrides)}, …)   // resolved
//     problem(409, …)                                              // hardcoded
//
// because with nothing declared the first renders exactly the second.  Both
// sibling suites document falling into that trap once, and
// `docs/conformance-semantics.md` § "Make the fixture able to falsify the rule"
// names it as a fixture-design rule: *an override being honoured needs a
// NON-DEFAULT override in the fixture.*
//
// So this suite declares one, on every remappable rung at once:
//
//     api A from S {
//       httpStatus ConcurrencyConflict -> 429   httpStatus Disallowed     -> 423
//       httpStatus UniquenessConflict  -> 422   httpStatus ReferencedInUse -> 428
//       httpStatus Forbidden           -> 451   httpStatus NotFound        -> 410
//     }
//
// and then enumerates, PER BACKEND and PER FILE, every emitted site that
// answers one of those rungs.  Each site is a (file, regex-capturing-the-status)
// pair read off real generated output — never off an emitter, the method note
// this mission has earned four times (grepping emitters is what made an
// all-five `conforms` claim wrong on RS-18 ×2, RS-19 and RS-27).
//
// Two assertions per site, and BOTH are load-bearing:
//
//   1. under the override, the site emits the OVERRIDE status;
//   2. with NO override, the same regex still matches and yields the STDLIB
//      DEFAULT.
//
// (2) is what stops (1) from passing vacuously against a regex that stopped
// reaching its site — the failure shape `not-found-by-id-detail-parity` and
// `problem-arm-census` each document.  And the assertions are per FILE, never
// against the joined output: a whole-output `toContain` goes green as soon as
// ONE router resolves while a sibling stays hardcoded, which is the exact state
// node was in when the first version of `denial-ladder-override-parity` passed
// against the unfixed code.
//
// WHAT THE SWEEP FOUND (fixed in the same PR, all byte-identical at default):
//   * `errorStatuses` (`src/ir/util/openapi-errors.ts`) — the ONE function all
//     five backends read for a route's declared error set — resolved `Forbidden`
//     for `operation`/`workflow` and hardcoded `403` for `findOptional`/
//     `findList`/`findSingle`.  A gated operation's declaration moved; a gated
//     find's did not.  Intra-FUNCTION split, five backends downstream.
//   * elixir's find controller and audit-history controller spelled
//     `problem_response(conn, 403, "Forbidden", …)` / `(conn, 404, "Not Found",
//     …)` as literals, while the projection controller next door already went
//     through `denialResponse(…, denialOverrides(ctx))`.  Three converted, two
//     missed — the mission's founding bug shape, relocated.
//   * elixir's `problem_response/4` picked its observability CATALOG EVENT from
//     the status (`case status do … 409 -> "disallowed"`), so a remapped rung
//     answered the right wire status and logged `domain_error`.  The other four
//     backends choose the event at the THROW site (by exception class) and are
//     immune by construction.
//
// The sweep also found ONE divergence it did not fix — `httpStatus NotFound ->
// N` honoured by elixir alone — and parked it as four ratcheting waivers.  The
// follow-up slice closed that gap on the remaining four backends, so those
// waivers are gone and their sites live in `SITES` below; see the note at the
// bottom of this file for what deliberately stays literal on all five.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** Every rung an `httpStatus` clause can retarget that this fixture reaches,
 *  mapped to a NON-DEFAULT code.  Each value is chosen to be unreachable by
 *  accident: none of the six is any rung's stdlib default, and none is a status
 *  the framework tiers (400 wire-parse, 422 wire-validation, 500) emit — except
 *  `UniquenessConflict -> 422`, which is deliberate: it is the one remap that
 *  COLLIDES with a sibling rung's default, and the elixir catalog classifier
 *  below has to stay deterministic under it. */
const OVERRIDE = {
  ConcurrencyConflict: 429,
  Disallowed: 423,
  UniquenessConflict: 422,
  ReferencedInUse: 428,
  Forbidden: 451,
  NotFound: 410,
} as const;

/** The stdlib defaults the same rungs resolve to with no clause — from
 *  `src/util/error-defaults.ts`.  Asserted as the second half of every site so a
 *  regex that stopped reaching its site fails loudly instead of passing. */
const DEFAULT: Record<Rung, number> = {
  ConcurrencyConflict: 409,
  Disallowed: 409,
  UniquenessConflict: 409,
  ReferencedInUse: 409,
  Forbidden: 403,
  NotFound: 404,
};

type Rung = keyof typeof OVERRIDE;

const API_BODY = `{ ${Object.entries(OVERRIDE)
  .map(([name, code]) => `httpStatus ${name} -> ${code}`)
  .join("\n    ")} }`;

/** One aggregate carrying EVERY structural-conflict producer at once, because
 *  the point of the sweep is that these rungs live in different emitters that
 *  can disagree:
 *
 *    `unique (name)`            → UniquenessConflict (23505 / unique_constraint)
 *    `with versioned`           → ConcurrencyConflict (optimistic lock lost)
 *    `operation … when …`       → Disallowed (state gate)
 *    `destroy` + a referencing  → ReferencedInUse (23503, FK RESTRICT) — `Line`
 *      aggregate                  exists ONLY to make the FK real
 *    `find … requires …`        → Forbidden on a READ (the arm whose declared
 *                                 status was hardcoded while the operation
 *                                 arm's was resolved)
 *    `operation … audited`      → the audit-history read, a SECOND gated read
 *                                 controller, gated because it inherits the
 *                                 `find all` gate
 *    getById                    → NotFound
 *
 *  Dropping any one of them silently shrinks the census, so the per-site
 *  "matches under default emission too" assertion doubles as a fixture guard. */
const SOURCE = (platform: string, apiBody: string) => `
system Census {
  user { id: string  level: int }
  subdomain S {
    context S {
      aggregate Item audited with versioned {
        name: string
        qty: int
        status: string
        unique (name)
        create(name: string, qty: int) { status := "open" }
        operation bump() audited when status == "open" {
          qty := qty + 1
        }
        destroy { }
      }
      repository Items for Item {
        find all(): Item[] requires currentUser.level > 2
        find openOnes(): Item[] requires currentUser.level > 2 where this.status == "open"
        find byName(n: string): Item? where this.name == n
      }
      aggregate Line {
        item: Item id
        amount: int
        create(item: Item id, amount: int) { }
      }
      repository Lines for Line { }
    }
  }
  api A from S ${apiBody}
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
type Platform = (typeof PLATFORMS)[number];

/** One emission site: the FILE it lives in and a regex whose first capture group
 *  is the HTTP status that site answers with.  Anchored on the site's own
 *  discriminator (exception class, SQLSTATE, detail sentence) rather than on the
 *  status itself — a regex that matched the status would be unable to tell a
 *  site that moved from a site that vanished. */
type Site = {
  /** What the site answers — indexes both `OVERRIDE` and `DEFAULT`. */
  rung: Rung;
  /** Human name, used in the failure message. */
  what: string;
  /** Path suffix of the ONE emitted file this site lives in. */
  file: string;
  /** Capture group 1 = the emitted status. */
  at: RegExp;
};

/** `[\s\S]{0,N}?` bridges from a rung's discriminator to the status it answers
 *  with, across the intervening log/metric lines.  Lazy + bounded so it cannot
 *  slide into the NEXT arm of the ladder and read its status instead. */
const SITES: Record<Platform, Site[]> = {
  node: [
    {
      rung: "NotFound",
      what: "the AggregateNotFound arm of the aggregate router's onError",
      file: "http/item.routes.ts",
      at: /err instanceof AggregateNotFoundError\)[\s\S]{0,700}?return problem\((\d+),/,
    },
    {
      rung: "NotFound",
      what: "getById's DECLARED OpenAPI response set",
      file: "http/item.routes.ts",
      // Skips past the 200 success entry — the error entry is the SECOND.
      at: /operationId: "getItemById",[\s\S]{0,400}?200: \{ description: "OK"[^\n]*\n\s*(\d+): \{ description:/,
    },
    {
      rung: "Disallowed",
      what: "the `when` state-gate arm of the aggregate router's onError",
      file: "http/item.routes.ts",
      at: /err instanceof DisallowedError\)[\s\S]{0,700}?return problem\((\d+),/,
    },
    {
      rung: "UniquenessConflict",
      what: "the 23505 arm of the aggregate router's onError",
      file: "http/item.routes.ts",
      at: /=== "23505"\)[\s\S]{0,900}?return problem\((\d+),/,
    },
    {
      rung: "ConcurrencyConflict",
      what: "the optimistic-lock arm of the aggregate router's onError",
      file: "http/item.routes.ts",
      at: /err instanceof ConcurrencyError\)[\s\S]{0,700}?return problem\((\d+),/,
    },
    {
      rung: "ReferencedInUse",
      what: "the FK-restrict (23503) arm inlined in the destroy route",
      file: "http/item.routes.ts",
      at: /status: (\d+), detail: "Item is still referenced and cannot be deleted\."/,
    },
    {
      rung: "Forbidden",
      what: "the `requires` arm of the aggregate router's onError",
      file: "http/item.routes.ts",
      at: /err instanceof ForbiddenError\)[\s\S]{0,700}?return problem\((\d+),/,
    },
    {
      rung: "Forbidden",
      what: "the gated find's DECLARED OpenAPI response set",
      file: "http/item.routes.ts",
      // Skips past the 200 success entry — the error entry is the SECOND.
      at: /operationId: "openOnesItem",[\s\S]{0,400}?200: \{ description: "OK"[^\n]*\n\s*(\d+): \{ description:/,
    },
  ],
  dotnet: [
    {
      rung: "NotFound",
      what: "the AggregateNotFoundException arm of the global exception filter",
      file: "Api/DomainExceptionFilter.cs",
      at: /is AggregateNotFoundException[\s\S]{0,700}?Problem\(context, (\d+),/,
    },
    {
      rung: "NotFound",
      what: "getById's DECLARED [ProducesResponseType] set",
      file: "Api/ItemsController.cs",
      at: /ProducesResponseType\(typeof\(ProblemDetails\), (\d+)\)\][\s\S]{0,200}?GetItemById\(/,
    },
    {
      rung: "Disallowed",
      what: "the DisallowedException arm of the global exception filter",
      file: "Api/DomainExceptionFilter.cs",
      at: /is DisallowedException[\s\S]{0,700}?Problem\(context, (\d+),/,
    },
    {
      rung: "UniquenessConflict",
      what: "the 23505 arm of the global exception filter",
      file: "Api/DomainExceptionFilter.cs",
      at: /SqlState: "23505"[\s\S]{0,900}?Problem\(context, (\d+),/,
    },
    {
      rung: "ConcurrencyConflict",
      what: "the DbUpdateConcurrencyException arm of the global exception filter",
      file: "Api/DomainExceptionFilter.cs",
      at: /is Microsoft\.EntityFrameworkCore\.DbUpdateConcurrencyException\)[\s\S]{0,700}?Problem\(context, (\d+),/,
    },
    {
      rung: "ReferencedInUse",
      what: "the FK-restrict arm inlined in the destroy action",
      file: "Api/ItemsController.cs",
      at: /Status = (\d+), Detail = "Item is still referenced and cannot be deleted\."/,
    },
    {
      rung: "Forbidden",
      what: "the ForbiddenException arm of the global exception filter",
      file: "Api/DomainExceptionFilter.cs",
      at: /is ForbiddenException[\s\S]{0,700}?Problem\(context, (\d+),/,
    },
    {
      rung: "Forbidden",
      what: "the gated find's DECLARED [ProducesResponseType] set",
      file: "Api/ItemsController.cs",
      at: /ProducesResponseType\(typeof\(ProblemDetails\), (\d+)\)\][\s\S]{0,400}?public async Task<[^\n]*> OpenOnes/,
    },
  ],
  java: [
    {
      rung: "NotFound",
      what: "the AggregateNotFoundException @ExceptionHandler",
      file: "api/ApiExceptionAdvice.java",
      at: /AggregateNotFoundException\.class\)[\s\S]{0,700}?problem\((\d+),/,
    },
    {
      rung: "NotFound",
      what: "getById's DECLARED response set in the OpenAPI customizer",
      file: "config/OpenApiContractCustomizer.java",
      // The array carries the wire-validation 422 alongside the rung (#2612 —
      // a malformed `{id}` is parsed and refused), so the pattern must tolerate
      // trailing entries.  Capture group 1 is the FIRST, which is the rung:
      // the emitter sorts ascending and both 404 and the override sort below
      // 422.
      at: /"\/api\/items\/\{id\}", null, new int\[\] \{(\d+)(?:, \d+)*\}/,
    },
    {
      rung: "Disallowed",
      what: "the DisallowedException @ExceptionHandler",
      file: "api/ApiExceptionAdvice.java",
      at: /DisallowedException\.class\)[\s\S]{0,700}?problem\((\d+),/,
    },
    {
      rung: "UniquenessConflict",
      what: "the 23505 arm of the DataIntegrityViolation handler",
      file: "api/ApiExceptionAdvice.java",
      at: /problem\((\d+), "[^"]*", "A resource with these values already exists\./,
    },
    {
      rung: "ConcurrencyConflict",
      what: "the optimistic-lock @ExceptionHandler",
      file: "api/ApiExceptionAdvice.java",
      at: /problem\((\d+), "[^"]*", "The resource was modified by another request/,
    },
    {
      rung: "ReferencedInUse",
      what: "the FK-restrict (23503) arm of the DataIntegrityViolation handler",
      file: "api/ApiExceptionAdvice.java",
      at: /problem\((\d+), "[^"]*", "This resource is still referenced/,
    },
    {
      rung: "Forbidden",
      what: "the ForbiddenException @ExceptionHandler",
      file: "api/ApiExceptionAdvice.java",
      at: /ForbiddenException\.class\)[\s\S]{0,700}?problem\((\d+),/,
    },
    {
      rung: "Forbidden",
      what: "the gated find's DECLARED response set in the OpenAPI customizer",
      file: "config/OpenApiContractCustomizer.java",
      at: /"\/api\/items\/open_ones", "ItemListResponse", new int\[\] \{(\d+)\}/,
    },
  ],
  python: [
    {
      rung: "NotFound",
      what: "the NotFoundError handler",
      file: "http/problem.py",
      at: /NotFoundError[\s\S]{0,700}?problem\(request, (\d+),/,
    },
    {
      rung: "NotFound",
      what: "getById's DECLARED `responses=` set",
      file: "http/item_routes.py",
      at: /operation_id="getItemById", responses=\{(\d+):/,
    },
    {
      rung: "Disallowed",
      what: "the DisallowedError handler",
      file: "http/problem.py",
      at: /DisallowedError[\s\S]{0,700}?problem\(request, (\d+),/,
    },
    {
      rung: "UniquenessConflict",
      what: "the 23505 arm of the IntegrityError handler",
      file: "http/problem.py",
      at: /request, (\d+), "[^"]*", "A resource with these values already exists\./,
    },
    {
      rung: "ConcurrencyConflict",
      what: "the ConcurrencyError handler",
      file: "http/problem.py",
      at: /request, (\d+), "[^"]*", "The resource was modified by another request/,
    },
    {
      rung: "ReferencedInUse",
      what: "the FK-restrict arm inlined in the destroy route",
      file: "http/item_routes.py",
      at: /except IntegrityError:[\s\S]{0,500}?\n\s*(\d+),\n\s*"[^"]*",\n\s*"Item is still referenced/,
    },
    {
      rung: "Forbidden",
      what: "the ForbiddenError handler",
      file: "http/problem.py",
      at: /ForbiddenError[\s\S]{0,700}?problem\(request, (\d+),/,
    },
    {
      rung: "Forbidden",
      what: "the gated find's DECLARED `responses=` set",
      file: "http/item_routes.py",
      at: /operation_id="openOnesItem", responses=\{(\d+):/,
    },
  ],
  elixir: [
    {
      rung: "NotFound",
      what: "getById's DECLARED OpenApiSpex response set",
      file: "api/a_spec.ex",
      // Skips past the 200 success entry — the error entry is the SECOND.
      at: /operationId: "getItemById",[\s\S]{0,600}?200 => %OpenApiSpex\.Response\{[\s\S]{0,400}?\n\s*(\d+) => %OpenApiSpex\.Response\{/,
    },
    {
      rung: "Disallowed",
      what: "the `{:disallowed, detail}` arm of the operation action",
      file: "controllers/item_controller.ex",
      at: /\{:error, \{:disallowed, detail\}\} ->\s*\n\s*ProblemDetails\.problem_response\(conn, (\d+),/,
    },
    {
      rung: "UniquenessConflict",
      what: "the unique-constraint branch of the shared validation responder",
      file: "api_web/problem_details.ex",
      at: /if unique_conflict\?\(changeset\) do[\s\S]{0,300}?conn,\n\s*(\d+),/,
    },
    {
      rung: "ConcurrencyConflict",
      what: "`conflict_response/1`, the shared optimistic-lock responder",
      file: "api_web/problem_details.ex",
      at: /def conflict_response\(conn\) do[\s\S]{0,1200}?send_resp\((\d+), body\)/,
    },
    {
      rung: "ReferencedInUse",
      what: "the Ecto.ConstraintError rescue in the destroy action",
      file: "controllers/item_controller.ex",
      at: /(\d+),\n\s*"[^"]*",\n\s*"Item is still referenced and cannot be deleted\."/,
    },
    {
      rung: "Forbidden",
      what: "the read gate of the FIND controller (was a literal until this PR)",
      file: "controllers/item_controller.ex",
      at: /problem_response\(conn, (\d+), "[^"]*", "Forbidden: find openOnes"\)/,
    },
    {
      rung: "Forbidden",
      what: "the read gate of the AUDIT-HISTORY controller (was a literal until this PR)",
      file: "controllers/item_controller.ex",
      at: /problem_response\(conn, (\d+), "[^"]*", "Forbidden: history Item"\)/,
    },
    {
      rung: "NotFound",
      what: "`not_found_response/3`, the shared by-id 404 responder",
      file: "api_web/problem_details.ex",
      at: /def not_found_response\(conn, kind, id\) do\s*\n\s*problem_response\(conn, (\d+),/,
    },
    {
      rung: "NotFound",
      what: "the absent-row arm of an optional find (was a literal until this PR)",
      file: "controllers/item_controller.ex",
      at: /problem_response\(conn, (\d+), "[^"]*", "not_found"\)/,
    },
    {
      rung: "Forbidden",
      what: "the gated find's DECLARED OpenApiSpex response set",
      file: "api/a_spec.ex",
      // Skips past the 200 success entry — the error entry is the SECOND.
      at: /operationId: "openOnesItem",[\s\S]{0,600}?200 => %OpenApiSpex\.Response\{[\s\S]{0,400}?\n\s*(\d+) => %OpenApiSpex\.Response\{/,
    },
  ],
};

/** Generated once per (platform, mode) — the suite runs ten full system
 *  emissions, not one per assertion. */
const emitted = new Map<string, Promise<Map<string, string>>>();
function emit(platform: Platform, overridden: boolean): Promise<Map<string, string>> {
  const key = `${platform}:${overridden}`;
  let p = emitted.get(key);
  if (!p) {
    p = generateSystemFiles(SOURCE(platform, overridden ? API_BODY : ""));
    emitted.set(key, p);
  }
  return p;
}

/** The ONE emitted file whose path ends with `suffix`.  Throws on a miss or an
 *  ambiguous match rather than returning undefined: a site whose file moved is a
 *  census that stopped covering it, which must fail, not silently skip. */
async function fileOf(platform: Platform, overridden: boolean, suffix: string): Promise<string> {
  const files = await emit(platform, overridden);
  const keys = [...files.keys()].filter((k) => k.endsWith(suffix));
  expect(keys, `${platform}: expected exactly one emitted file ending "${suffix}"`).toHaveLength(1);
  return files.get(keys[0]!)!;
}

/** The status one site answers with, or `undefined` when its regex no longer
 *  reaches it. */
async function statusAt(
  platform: Platform,
  overridden: boolean,
  s: Site,
): Promise<number | "no-match"> {
  const m = s.at.exec(await fileOf(platform, overridden, s.file));
  return m ? Number(m[1]) : "no-match";
}

describe("M-T9.25 round 2, probe 1 — every 4xx site resolves a declared override", () => {
  for (const platform of PLATFORMS) {
    describe(platform, () => {
      // (2) FIRST, so a broken regex is reported as "the census stopped
      // covering this site" rather than as an override failure.
      it("every censused site is real: with NO override it answers the stdlib default", async () => {
        const got: Record<string, number | "no-match"> = {};
        const want: Record<string, number> = {};
        for (const s of SITES[platform]) {
          const key = `${s.rung} — ${s.what}`;
          got[key] = await statusAt(platform, false, s);
          want[key] = DEFAULT[s.rung];
        }
        expect(
          got,
          "a site's regex no longer reaches its emission site (or the site's default moved) — " +
            "the override assertion below would pass vacuously",
        ).toEqual(want);
      });

      it("under `httpStatus <Rung> -> <Code>`, EVERY site answers the override", async () => {
        const got: Record<string, number | "no-match"> = {};
        const want: Record<string, number> = {};
        for (const s of SITES[platform]) {
          const key = `${s.rung} — ${s.what}`;
          got[key] = await statusAt(platform, true, s);
          want[key] = OVERRIDE[s.rung];
        }
        expect(
          got,
          "site(s) ignored the api's `httpStatus` clause — the override moves their siblings " +
            "and silently not these",
        ).toEqual(want);
      });
    });
  }

  it("the fixture can falsify the rule: no override code appears in DEFAULT emission", async () => {
    // Without this, "the output contains 429" proves nothing.  Checked against
    // the joined DEFAULT output of all five, with generated secrets redacted —
    // `docker-compose.yml` carries a random 128-hex `SECRET_KEY_BASE` for the
    // Phoenix service, and a hex run containing "429" is a ~3%/run flake the
    // sibling denial-ladder suite already had to fix once.
    for (const platform of PLATFORMS) {
      const joined = [...(await emit(platform, false)).values()]
        .join("\n")
        .replace(/[0-9a-f]{32,}/g, "<secret>");
      for (const [rung, code] of Object.entries(OVERRIDE)) {
        if (code === 422) continue; // 422 is the wire-validation tier's own status
        expect(
          joined.includes(String(code)),
          `${platform}: ${code} (the ${rung} override) already appears with NO override declared — ` +
            "pick a different sentinel, this rung's assertion is void",
        ).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// No ratcheting waivers.
//
// This suite shipped with four — one per non-elixir backend — all recording the
// SAME divergence: `httpStatus NotFound -> N` was honoured by elixir alone.  The
// follow-up slice closed it (`errorStatuses` resolves the `NotFound` rung, and
// each backend's exception-handler arm plus its hand-rolled declared sets read
// the resolved value), so the four sites moved up into `SITES` above and their
// waivers were deleted in the same PR — the no-stale-allowlist rule.
//
// Two 404s stay literal ON ALL FIVE and are deliberately NOT censused, because
// neither is the domain `NotFound` rung: the FRAMEWORK routing 404 (`no route
// for <verb> <path>`) and the objectStore blob-absence 404 on a
// `kind: objectStore` download route.  Elixir does not resolve them either, so
// leaving them literal keeps the five in lockstep instead of making one diverge
// from the reference.
// ---------------------------------------------------------------------------
