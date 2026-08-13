// M-T9.25 round 2, probe 2 — the 401/403 AUTHORIZATION-status arm census.
//
// Sweeps 1–4 of this mission censused the 4xx/5xx *domain* arms (422, 404, 409,
// the override ladder).  They all deferred the two AUTHENTICATION/AUTHORIZATION
// rungs — 401 (no credentials) and 403 (authenticated but unauthorized) —
// because a RUNTIME probe of the 403 arm needs an authenticated-but-unauthorized
// principal the behavioural harness could not express (one `DEV_CLAIMS` identity
// authenticates as authorized).  That harness gap closed with M-T9.28 slice 1
// (#2515), which unblocks the runtime goldens; but the SOURCE-LEVEL emission
// census this file is does not need runtime at all — it reads the two arms out
// of generated output and asserts the five backends agree, the same shape as the
// sibling suites.
//
// The METHOD is the one this mission has earned four times: read GENERATED
// OUTPUT, never grep emitters, and assert PER FILE (a whole-output `toContain`
// went green against half-broken code in every sibling suite's history).  Every
// site below is a (file, regex-capturing-the-status-or-string) pair read off a
// real `generate system` emission.
//
// WHAT THE CENSUS FOUND — the arm family had never been censused, and it split:
//
//   * The 403 arm AGREES five-way — status 403, title "Forbidden", type
//     "about:blank", `application/problem+json`, and (for an OPERATION `requires`
//     gate) the identical detail "Forbidden: currentUser.level > 2".  This is the
//     positive census below (SITES_403 + OP_DETAIL).
//
//   * The 401 arm is a PROBLEM DOCUMENT ON NONE of the five, and diverges in two
//     shapes — JSON `{"error":"unauthorized"}` (node/python/elixir) vs plain-text
//     `unauthorized` (java/dotnet) — with `WWW-Authenticate` (an RFC 9110 §15.5.2
//     MUST) emitted NOWHERE.  This is the worst-shaped divergence a census can
//     find: the arm has no envelope to agree ON.  It is the subject of in-flight
//     #2500 (the runtime-boot fix), so it is pinned here as a RATCHETING WAIVER
//     rather than re-fixed — closing it must delete the waiver and move the arm
//     into SITES, the repo's no-stale-allowlist rule (WAIVER_401 below).
//
//   * The 403 DETAIL on a declared-FIND `requires` gate diverges: node emits a
//     bare "Forbidden" where dotnet/java/python/elixir emit the descriptive
//     "Forbidden: find <name>".  node's find-guard emitter (routes-builder.ts:
//     1820) hardcodes the bare string while its OPERATION-guard emitter threads
//     the predicate — the exact intra-backend split this mission exists to name.
//     Unifying the detail convention across every guard site (finds, projections,
//     audit-history — where even the descriptive backends disagree: java "find
//     history" vs elixir "history Item") is mission-sized, so this is a reasoned
//     ratchet + a filed finding, not a one-line fix that would only trade node's
//     outlier for a fresh intra-node split (WAIVER_FIND_DETAIL below).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** One aggregate with BOTH an operation `requires` gate and a declared-find
 *  `requires` gate, under `auth: required`, so all three authz arms are emitted:
 *
 *    operation bump() requires …  → the 403 arm on a WRITE  (detail agrees)
 *    find openOnes() requires …   → the 403 arm on a READ   (detail diverges)
 *    auth: required               → the 401 arm on every route (no envelope)
 *
 *  The context is fixed to `S` so elixir's domain module is a stable `s.ex`.
 *  `find all()` is deliberately NOT declared: its name collides with the
 *  auto-`findAll` enrichment, and on four backends the unguarded auto-find wins,
 *  which would confound the read-gate census with a name-resolution artefact. */
const SOURCE = (platform: string) => `
system Census {
  user { id: string  level: int }
  subdomain S {
    context S {
      aggregate Item with crudish {
        name: string
        qty: int
        operation bump() requires currentUser.level > 2 {
          qty := qty + 1
        }
      }
      repository Items for Item {
        find openOnes(): Item[] requires currentUser.level > 2 where this.qty > 0
      }
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
type Platform = (typeof PLATFORMS)[number];

/** Generated once per platform — the whole suite runs five system emissions. */
const emitted = new Map<Platform, Promise<Map<string, string>>>();
function emit(platform: Platform): Promise<Map<string, string>> {
  let p = emitted.get(platform);
  if (!p) {
    p = generateSystemFiles(SOURCE(platform));
    emitted.set(platform, p);
  }
  return p;
}

/** The ONE emitted file whose path ends with `suffix`.  Throws on a miss or an
 *  ambiguous match rather than returning undefined: a site whose file moved is a
 *  census that stopped covering it, which must FAIL, not silently skip. */
async function fileOf(platform: Platform, suffix: string): Promise<string> {
  const files = await emit(platform);
  const keys = [...files.keys()].filter((k) => k.endsWith(suffix));
  expect(keys, `${platform}: expected exactly one emitted file ending "${suffix}"`).toHaveLength(1);
  return files.get(keys[0]!)!;
}

// ---------------------------------------------------------------------------
// POSITIVE — the 403 arm.  It agrees on all five, and this is the census that
// asserts it: status + title read off the Forbidden→problem producer arm, plus
// the envelope markers (`about:blank`, `application/problem+json`) that make it
// an RFC 7807 document and not a bare 403.
// ---------------------------------------------------------------------------

type Producer403 = {
  /** The file the Forbidden→problem producer arm lives in. */
  file: string;
  /** Capture group 1 = the emitted status.  Anchored on the Forbidden
   *  discriminator (exception class / handler) so a regex that matched the bare
   *  number could not tell a moved arm from a vanished one. */
  statusAt: RegExp;
  /** The file carrying the shared 7807 envelope (may be the same file). */
  envelopeFile: string;
  /** Substrings that must appear in `envelopeFile` — the `type` and the
   *  content type that make the 403 a problem document. */
  envelope: string[];
};

const SITES_403: Record<Platform, Producer403> = {
  node: {
    file: "http/item.routes.ts",
    statusAt: /err instanceof ForbiddenError\)[\s\S]{0,400}?return problem\((\d+), "Forbidden"/,
    envelopeFile: "http/item.routes.ts",
    envelope: ['type: "about:blank"', '"content-type": "application/problem+json"'],
  },
  python: {
    file: "http/problem.py",
    statusAt:
      /exception_handler\(ForbiddenError\)[\s\S]{0,300}?problem\(request, (\d+), "Forbidden"/,
    envelopeFile: "http/problem.py",
    envelope: ['"type": "about:blank"', 'media_type="application/problem+json"'],
  },
  dotnet: {
    file: "Api/DomainExceptionFilter.cs",
    statusAt: /is ForbiddenException[\s\S]{0,300}?Problem\(context, (\d+), "Forbidden"/,
    envelopeFile: "Api/DomainExceptionFilter.cs",
    envelope: ['Type = "about:blank"', 'ContentTypes = { "application/problem+json" }'],
  },
  java: {
    file: "api/ApiExceptionAdvice.java",
    statusAt:
      /ExceptionHandler\(ForbiddenException\.class\)[\s\S]{0,300}?problem\((\d+), "Forbidden"/,
    envelopeFile: "api/ApiExceptionAdvice.java",
    envelope: ['setProperty("type", "about:blank")', "MediaType.APPLICATION_PROBLEM_JSON"],
  },
  elixir: {
    // Phoenix passes the status to the shared responder, so the 403 + title live
    // at the CALL site (the controller) and the envelope in problem_details.ex.
    file: "controllers/item_controller.ex",
    statusAt: /problem_response\(conn, (\d+), "Forbidden"/,
    envelopeFile: "api_web/problem_details.ex",
    envelope: ['type: "about:blank"', 'put_resp_content_type("application/problem+json")'],
  },
};

/** The OPERATION `requires` gate's 403 detail.  This one AGREES five-way — the
 *  detail is the guard predicate, "Forbidden: currentUser.level > 2", on every
 *  backend.  Anchored on the full literal so it cannot slide onto the FIND
 *  guard's (divergent) string, which is the whole point of asserting them apart. */
const OP_DETAIL: Record<Platform, { file: string; at: RegExp }> = {
  node: {
    file: "http/item.routes.ts",
    at: /ForbiddenError\("(Forbidden: currentUser\.level > 2)"\)/,
  },
  python: {
    file: "http/item_routes.py",
    at: /ForbiddenError\("(Forbidden: currentUser\.level > 2)"\)/,
  },
  dotnet: {
    file: "Commands/BumpHandler.cs",
    at: /ForbiddenException\("(Forbidden: currentUser\.level > 2)"\)/,
  },
  java: {
    file: "items/ItemService.java",
    at: /ForbiddenException\("(Forbidden: currentUser\.level > 2)"\)/,
  },
  // The domain context module `s.ex` carries the guard tuple.
  elixir: { file: "lib/api/s.ex", at: /\{:forbidden, "(Forbidden: currentUser\.level > 2)"\}/ },
};

describe("M-T9.25 round 2, probe 2 — the 403 arm agrees on all five backends", () => {
  for (const platform of PLATFORMS) {
    describe(platform, () => {
      it("the Forbidden→problem producer answers 403 as an RFC 7807 document", async () => {
        const spec = SITES_403[platform];
        const m = spec.statusAt.exec(await fileOf(platform, spec.file));
        expect(
          m,
          `${platform}: no Forbidden→problem arm found — the fixture stopped covering it`,
        ).not.toBeNull();
        expect(Number(m![1]), `${platform}: the Forbidden arm does not answer 403`).toBe(403);

        const env = await fileOf(platform, spec.envelopeFile);
        for (const marker of spec.envelope) {
          expect(
            env,
            `${platform}: the 403 producer is missing the 7807 marker ${marker} — it is a bare 403, not a problem document`,
          ).toContain(marker);
        }
      });
    });
  }

  it("cross-backend: the 403 title is the SAME word on all five", async () => {
    // The producer regexes above each already require `"Forbidden"` immediately
    // after the status; this asserts it as one cross-backend fact so a future
    // backend that titled it "Access Denied" would be named here, not hidden in
    // one platform's arm.
    const titles = await Promise.all(
      PLATFORMS.map(async (p) => {
        const spec = SITES_403[p];
        const src = await fileOf(p, spec.file);
        return [p, spec.statusAt.test(src) ? "Forbidden" : "<no 403 arm>"] as const;
      }),
    );
    expect(Object.fromEntries(titles)).toEqual({
      node: "Forbidden",
      dotnet: "Forbidden",
      java: "Forbidden",
      python: "Forbidden",
      elixir: "Forbidden",
    });
  });

  it("cross-backend: the OPERATION `requires` 403 detail is byte-identical on all five", async () => {
    const details = await Promise.all(
      PLATFORMS.map(async (p) => {
        const spec = OP_DETAIL[p];
        const m = spec.at.exec(await fileOf(p, spec.file));
        return [p, m ? m[1] : "<no operation-gate detail found>"] as const;
      }),
    );
    const expected = "Forbidden: currentUser.level > 2";
    expect(
      Object.fromEntries(details),
      "an operation `requires` gate's 403 detail diverged — it is the guard predicate on every backend",
    ).toEqual({
      node: expected,
      dotnet: expected,
      java: expected,
      python: expected,
      elixir: expected,
    });
  });
});

// ---------------------------------------------------------------------------
// RATCHETING WAIVERS — divergences this census FOUND and deliberately did not
// fix.  Each asserts the divergence STILL EXISTS, so closing one fails here
// until its waiver is deleted in the same PR (the no-stale-allowlist rule).  A
// waiver is a reviewed decision with a reason, never a skip.
// ---------------------------------------------------------------------------

/** The 401 arm as each backend emits it TODAY: a bare token, not a problem
 *  document, and with no `WWW-Authenticate` challenge anywhere in the file.
 *  `body` is the exact current emission (the ratchet anchor); `authFile` is the
 *  file it lives in, asserted to carry neither the 7807 content type nor the RFC
 *  9110 §15.5.2 challenge header. */
type Waiver401 = { authFile: string; body: string; why: string };

const WAIVER_401: Record<Platform, Waiver401> = {
  node: {
    authFile: "auth/middleware.ts",
    body: 'return c.json({ error: "unauthorized" }, 401);',
    why:
      "The 401 arm is a bare `{error:'unauthorized'}` JSON with no 7807 envelope and no " +
      "WWW-Authenticate (an RFC 9110 §15.5.2 MUST).  In-flight #2500 is the runtime-boot fix " +
      "that rewrites all five 401 arms into problem documents + a Bearer challenge; when it " +
      "lands, delete this waiver and move the 401 into SITES.",
  },
  python: {
    authFile: "auth/middleware.py",
    body: 'return JSONResponse({"error": "unauthorized"}, status_code=401)',
    why: "same 401 gap as node — bare JSON, no 7807, no challenge; fixed by #2500.",
  },
  elixir: {
    authFile: "api_web/auth.ex",
    body: 'send_resp(401, ~s({"error":"unauthorized"}))',
    why: "same 401 gap as node — bare JSON (content-type application/json), no 7807, no challenge; fixed by #2500.",
  },
  java: {
    authFile: "auth/UserFilter.java",
    body: 'response.getWriter().write("unauthorized");',
    why:
      "worse than node's — the 401 body is PLAIN TEXT `unauthorized` (getWriter default), so the " +
      "two backends do not even agree on JSON-vs-text; no 7807, no challenge; fixed by #2500.",
  },
  dotnet: {
    authFile: "Auth/UserMiddleware.cs",
    body: 'await ctx.Response.WriteAsync("unauthorized");',
    why: "same plain-text 401 as java (WriteAsync default), no 7807, no challenge; fixed by #2500.",
  },
};

describe("M-T9.25 round 2, probe 2 — the 401 arm is a problem document on NONE (ratchet, #2500)", () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: still emits a bare 401 with no 7807 envelope and no WWW-Authenticate`, async () => {
      const src = await fileOf(platform, WAIVER_401[platform].authFile);
      // (1) the current bare-token emission is present — the ratchet anchor.
      expect(
        src,
        `${platform}: the pinned bare-401 emission is gone — if #2500 (or equivalent) fixed it, ` +
          "delete this waiver and move the 401 into SITES_403's sibling positive census.",
      ).toContain(WAIVER_401[platform].body);
      // (2) the RFC 9110 §15.5.2 MUST is still unmet at the 401 site.
      expect(
        src,
        `${platform}: a WWW-Authenticate challenge appeared — the 401 arm was fixed; retire this waiver.`,
      ).not.toContain("WWW-Authenticate");
    });
  }

  it("every 401 waiver carries a reason", () => {
    for (const [platform, w] of Object.entries(WAIVER_401)) {
      expect(w.why.length, `${platform}: a waiver without a reason is a skip`).toBeGreaterThan(40);
    }
  });
});

/** The 403 DETAIL on a declared-find `requires` gate.  node is the outlier: it
 *  hardcodes a bare "Forbidden" where the other four thread the find name into
 *  "Forbidden: find openOnes".  Pinned as (the outlier body) + (the consensus the
 *  other four share) so the ratchet fails the moment EITHER side moves. */
const FIND_DETAIL: Record<Platform, { file: string; detail: string }> = {
  node: { file: "http/item.routes.ts", detail: 'throw new ForbiddenError("Forbidden");' },
  python: {
    file: "http/item_routes.py",
    detail: 'raise ForbiddenError("Forbidden: find openOnes")',
  },
  dotnet: {
    file: "Queries/OpenOnesHandler.cs",
    detail: 'throw new ForbiddenException("Forbidden: find openOnes");',
  },
  java: {
    file: "items/ItemsController.java",
    detail: 'throw new ForbiddenException("Forbidden: find openOnes");',
  },
  elixir: {
    file: "controllers/item_controller.ex",
    detail: 'problem_response(conn, 403, "Forbidden", "Forbidden: find openOnes")',
  },
};

describe("M-T9.25 round 2, probe 2 — the find-guard 403 detail: node is the outlier (ratchet)", () => {
  it("node's declared-find `requires` gate STILL emits a bare `Forbidden`", async () => {
    const src = await fileOf("node", FIND_DETAIL.node.file);
    expect(
      src,
      "node's find-guard detail changed.  If it now threads the find name (matching the other four), " +
        "delete this waiver and assert the find-guard detail agrees five-way like OP_DETAIL does.",
    ).toContain(FIND_DETAIL.node.detail);
  });

  it("the other four agree on the descriptive `Forbidden: find openOnes` detail node diverges from", async () => {
    const got = await Promise.all(
      (["python", "dotnet", "java", "elixir"] as const).map(async (p) => {
        const src = await fileOf(p, FIND_DETAIL[p].file);
        return [p, src.includes(FIND_DETAIL[p].detail)] as const;
      }),
    );
    expect(
      Object.fromEntries(got),
      "the descriptive find-guard consensus moved — re-census node against the new majority",
    ).toEqual({ python: true, dotnet: true, java: true, elixir: true });
  });
});
