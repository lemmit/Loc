// The TITLE half of the `httpStatus <Rung> -> <Code>` census.
//
// `override-status-census.test.ts` sweeps every 4xx emission site and asserts
// the STATUS each answers with, under an override and at the default.  It says
// nothing about the RFC 7807 `title` sitting next to that status — and a title
// is the other half of the body an ACL parses.
//
// That blind spot hid a real divergence.  `problemTitle(status)`
// (`src/ir/util/openapi-errors.ts`) maps a status to its IANA reason phrase and
// four backends title the `Forbidden` / `NotFound` rungs through it, so
// `httpStatus NotFound -> 410` reads:
//
//     { "type": "about:blank", "title": "Gone", "status": 410, … }
//
// Elixir titled the same body from the ERROR NAME — `errorTitle("NotFound")` →
// `"Not Found"` — so one backend answered a 410 called "Not Found" while its
// four peers called it "Gone".  Invisible at the defaults (the name and the
// reason phrase coincide: "Forbidden"/403, "Not Found"/404), which is exactly
// why only a NON-DEFAULT override can falsify the rule — the same fixture-design
// rule the status census is built on (`docs/conformance-semantics.md`
// § "Make the fixture able to falsify the rule").
//
// TWO rungs are censused here and they resolve DIFFERENTLY, deliberately:
//
//   * `Forbidden` / `NotFound` → the RESOLVED STATUS's reason phrase.
//   * `Disallowed`             → the ERROR NAME, `"Disallowed"`, on all five
//     backends regardless of status (RS-17; python's emitter says so in a
//     comment).  It is censused as the CONTROL: a "just use problemTitle
//     everywhere" repair would move it, and this suite refuses that.
//
// Method, inherited from the status census: every assertion reads REAL emitted
// output, per FILE, with the regex anchored on the site's own discriminator
// (the exception class) rather than on the status — so a regex that stops
// reaching its site fails as "no-match" instead of passing vacuously.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** The overrides this suite declares.  `451` is chosen for `Forbidden`
 *  precisely because `problemTitle` has NO entry for it — it falls to the
 *  generic `"Error"`, which is the strongest possible signal that the title
 *  followed the status and not the name (`errorTitle("Forbidden")` would still
 *  read "Forbidden"). `410 → "Gone"` is the canonical NotFound remap. */
const OVERRIDE = { Forbidden: 451, NotFound: 410, Disallowed: 423 } as const;

/** The title each rung must carry, per mode.  DEFAULT is what the same site
 *  must emit with NO `httpStatus` clause — asserted first, so a broken regex
 *  reports as "the census stopped covering this site". */
const TITLE = {
  Forbidden: { overridden: "Error", default: "Forbidden" },
  NotFound: { overridden: "Gone", default: "Not Found" },
  // The control: the name, both ways.
  Disallowed: { overridden: "Disallowed", default: "Disallowed" },
} as const;

type Rung = keyof typeof OVERRIDE;

const API_BODY = `{ ${Object.entries(OVERRIDE)
  .map(([name, code]) => `httpStatus ${name} -> ${code}`)
  .join("  ")} }`;

/** The status census's fixture, trimmed to the three rungs this suite reads:
 *  a gated find (`Forbidden` on a READ), a `when` state gate (`Disallowed`),
 *  and an optional find (`NotFound`). */
const SOURCE = (platform: string, apiBody: string) => `
system TitleCensus {
  user { id: string  level: int }
  subdomain S {
    context S {
      aggregate Item {
        name: string
        qty: int
        status: string
        create(name: string, qty: int, status: string) { }
        operation bump() when status == "open" {
          qty := qty + 1
        }
      }
      repository Items for Item {
        find all(): Item[] requires currentUser.level > 2
        find byName(n: string): Item? where this.name == n
      }
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

/** One title site: the file it lives in and a regex whose capture group 1 is
 *  the emitted 7807 `title` literal. */
type Site = { rung: Rung; what: string; file: string; at: RegExp };

const SITES: Record<Platform, Site[]> = {
  node: [
    {
      rung: "Forbidden",
      what: "the ForbiddenError arm of the router's onError",
      file: "http/item.routes.ts",
      at: /err instanceof ForbiddenError\)[\s\S]{0,700}?return problem\(\d+, "([^"]*)"/,
    },
    {
      rung: "Disallowed",
      what: "the DisallowedError arm of the router's onError",
      file: "http/item.routes.ts",
      at: /err instanceof DisallowedError\)[\s\S]{0,700}?return problem\(\d+, "([^"]*)"/,
    },
    {
      rung: "NotFound",
      what: "the AggregateNotFoundError arm of the router's onError",
      file: "http/item.routes.ts",
      at: /err instanceof AggregateNotFoundError\)[\s\S]{0,700}?return problem\(\d+, "([^"]*)"/,
    },
  ],
  dotnet: [
    {
      rung: "Forbidden",
      what: "the ForbiddenException arm of DomainExceptionFilter",
      file: "Api/DomainExceptionFilter.cs",
      at: /is ForbiddenException[\s\S]{0,700}?Problem\(context, \d+, "([^"]*)"/,
    },
    {
      rung: "Disallowed",
      what: "the DisallowedException arm of DomainExceptionFilter",
      file: "Api/DomainExceptionFilter.cs",
      at: /is DisallowedException[\s\S]{0,700}?Problem\(context, \d+, "([^"]*)"/,
    },
    {
      rung: "NotFound",
      what: "the AggregateNotFoundException arm of DomainExceptionFilter",
      file: "Api/DomainExceptionFilter.cs",
      at: /is AggregateNotFoundException[\s\S]{0,700}?Problem\(context, \d+, "([^"]*)"/,
    },
  ],
  java: [
    {
      rung: "Forbidden",
      what: "@ExceptionHandler(ForbiddenException) in ApiExceptionAdvice",
      file: "api/ApiExceptionAdvice.java",
      at: /ExceptionHandler\(ForbiddenException\.class\)[\s\S]{0,700}?problem\(\d+, "([^"]*)"/,
    },
    {
      rung: "Disallowed",
      what: "@ExceptionHandler(DisallowedException) in ApiExceptionAdvice",
      file: "api/ApiExceptionAdvice.java",
      at: /ExceptionHandler\(DisallowedException\.class\)[\s\S]{0,700}?problem\(\d+, "([^"]*)"/,
    },
    {
      rung: "NotFound",
      what: "@ExceptionHandler(AggregateNotFoundException) in ApiExceptionAdvice",
      file: "api/ApiExceptionAdvice.java",
      at: /ExceptionHandler\(AggregateNotFoundException\.class\)[\s\S]{0,700}?problem\(\d+, "([^"]*)"/,
    },
  ],
  python: [
    {
      rung: "Forbidden",
      what: "the ForbiddenError exception handler",
      file: "app/http/problem.py",
      at: /exception_handler\(ForbiddenError\)[\s\S]{0,700}?problem\(request, \d+, "([^"]*)"/,
    },
    {
      rung: "Disallowed",
      what: "the DisallowedError exception handler",
      file: "app/http/problem.py",
      at: /exception_handler\(DisallowedError\)[\s\S]{0,700}?problem\(request, \d+, "([^"]*)"/,
    },
    {
      rung: "NotFound",
      what: "the AggregateNotFoundError exception handler",
      file: "app/http/problem.py",
      at: /exception_handler\(AggregateNotFoundError\)[\s\S]{0,700}?problem\(request, \d+, "([^"]*)"/,
    },
  ],
  elixir: [
    {
      rung: "Forbidden",
      what: "the `requires` gate refusal on the gated list read",
      file: "controllers/item_controller.ex",
      at: /problem_response\(conn, \d+, "([^"]*)", "Forbidden: find all"\)/,
    },
    {
      rung: "Disallowed",
      what: "the `when` state-gate refusal on the named operation",
      file: "controllers/item_controller.ex",
      at: /\{:error, \{:disallowed, detail\}\}[\s\S]{0,300}?problem_response\(conn, \d+, "([^"]*)"/,
    },
    {
      rung: "NotFound",
      what: "the optional find's absence arm",
      file: "controllers/item_controller.ex",
      at: /problem_response\(conn, \d+, "([^"]*)", "not_found"\)/,
    },
    {
      rung: "NotFound",
      what: "the SHARED not_found_response/3 every controller delegates to",
      // `api_web/problem_details.ex`, not the OpenAPI schema module of the
      // same basename under `api_web/api/schemas/`.
      file: "api_web/problem_details.ex",
      at: /def not_found_response[\s\S]{0,300}?problem_response\(conn, \d+, "([^"]*)"/,
    },
  ],
};

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

/** The ONE emitted file whose path ends with `suffix` — throws on a miss or an
 *  ambiguous match, so a site whose file moved fails rather than skips. */
async function fileOf(platform: Platform, overridden: boolean, suffix: string): Promise<string> {
  const files = await emit(platform, overridden);
  const keys = [...files.keys()].filter((k) => k.endsWith(suffix));
  expect(keys, `${platform}: expected exactly one emitted file ending "${suffix}"`).toHaveLength(1);
  return files.get(keys[0]!)!;
}

async function titleAt(platform: Platform, overridden: boolean, s: Site): Promise<string> {
  const m = s.at.exec(await fileOf(platform, overridden, s.file));
  return m ? m[1]! : "no-match";
}

describe("RFC 7807 titles resolve the api's `httpStatus` override, identically on all five", () => {
  for (const platform of PLATFORMS) {
    describe(platform, () => {
      it("every censused site is real: with NO override it answers the default title", async () => {
        const got: Record<string, string> = {};
        const want: Record<string, string> = {};
        for (const s of SITES[platform]) {
          const key = `${s.rung} — ${s.what}`;
          got[key] = await titleAt(platform, false, s);
          want[key] = TITLE[s.rung].default;
        }
        expect(
          got,
          "a site's regex no longer reaches its emission site (or its default title moved) — " +
            "the override assertion below would pass vacuously",
        ).toEqual(want);
      });

      it("under `httpStatus <Rung> -> <Code>`, the TITLE follows the resolved status", async () => {
        const got: Record<string, string> = {};
        const want: Record<string, string> = {};
        for (const s of SITES[platform]) {
          const key = `${s.rung} — ${s.what}`;
          got[key] = await titleAt(platform, true, s);
          want[key] = TITLE[s.rung].overridden;
        }
        expect(
          got,
          "site(s) titled the 7807 body from the ERROR NAME instead of the RESOLVED status " +
            "(or moved `Disallowed`, whose title is the name on every backend)",
        ).toEqual(want);
      });
    });
  }

  it("the fixture can falsify the rule: the override titles never appear at the default", async () => {
    // "Gone" / "Error" must be absent from DEFAULT emission, or "the output says
    // Gone" proves nothing.  Read off the same censused files only — the wider
    // tree legitimately carries the word "Error" (log helpers, error types).
    for (const platform of PLATFORMS) {
      for (const s of SITES[platform]) {
        const src = await fileOf(platform, false, s.file);
        for (const rung of ["Forbidden", "NotFound"] as const) {
          const sentinel = `"${TITLE[rung].overridden}"`;
          if (platform === "node" && sentinel === '"Error"') continue; // the `problem(...)` closure's own param type
          expect(
            src.includes(sentinel),
            `${platform}/${s.file}: ${sentinel} already appears with NO override declared — ` +
              "this rung's title assertion is void",
          ).toBe(false);
        }
      }
    }
  });
});
