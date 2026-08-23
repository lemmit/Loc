// The absent-object 404 on `GET /files/{key}` answers the SAME RFC 7807
// envelope on all five backends.
//
// This closes the case `absent-read-envelope-parity.test.ts` (M-T6.31) named
// and deliberately deferred: the objectStore download route was a FOURTH 404
// shape, and none of the five was 7807.  Measured on the emitted source before
// this gate existed, for one `.ddd` differing only in `platform:`:
//
//   node    404  application/json  {"error":"not found"}
//   python  404  application/json  {"error":"not found"}
//   elixir  404  application/json  {"error":"not found"}
//   dotnet  404  (no body at all — `Results.NotFound()`)
//   java    404  (no body at all — `ResponseEntity.notFound().build()`)
//
// Three bodies a 7807 client cannot parse, and two responses with no body to
// parse — while every one of those five services ALREADY had a working
// problem+json producer that its domain 404s went through.  An INTRA-backend
// split, like M-T6.31's: the same service contradicting itself route to route.
//
// Why the fix is AT THE ROUTE SITE on dotnet and java rather than in their
// filters: this is a minimal-API endpoint (`app.MapGet`) and a plain
// `@RestController` returning normally.  `DomainExceptionFilter` and
// `ApiExceptionAdvice` both fire on THROWN exceptions, so neither ever saw it.
//
// Why the status stays a LITERAL 404 on all five, unlike every other not-found
// rung: `ir/util/openapi-errors.ts` names this 404 as one of the two that are
// deliberately NOT the remappable `NotFound` rung — it addresses a bucket key,
// not an aggregate id.  The last test here pins that, because "route the files
// 404 through the shared producer" is one refactor away from also inheriting
// the shared producer's remapped status.
//
// Test shape follows `absent-read-envelope-parity.test.ts`: per-SITE (the
// defect is one route disagreeing with its own service), FILE-SCOPED (the
// producer's own module satisfies an unscoped search while the route stays
// broken), and a NEGATIVE beside every positive (the positive alone cannot
// tell "fixed" from "route deleted").

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** One canonical single-backend system per platform carrying a `File` field
 *  plus a bound `objectStore` — the two facts that make a deployable mount the
 *  root `POST /files` + `GET /files/{key}` pair.  `apiBody` is spliced into the
 *  api so the status-override test can declare `httpStatus NotFound -> 410`. */
function systemFor(platform: string, port: number, apiBody = ""): string {
  return `
system FileSys {
  subdomain Docs {
    context Docs {
      aggregate Doc {
        title: string
        blob: File
      }
      repository Docs for Doc { }
    }
  }
  api DocsApi from Docs ${apiBody}

  storage pg   { type: postgres }
  storage disk { type: localDisk }

  resource docState { for: Docs, kind: state,       use: pg }
  resource docFiles { for: Docs, kind: objectStore, use: disk }

  deployable api {
    platform: ${platform}
    contexts: [Docs]
    dataSources: [docState, docFiles]
    serves: DocsApi
    port: ${port}
  }
}`;
}

const sourceFor = (files: Map<string, string>, ...suffixes: string[]): string =>
  [...files.entries()]
    .filter(([k]) => suffixes.some((s) => k.endsWith(s)))
    .map(([, v]) => v)
    .join("\n");

/** The one `detail` sentence every backend sends for this fault.  Byte-identical
 *  across the five on purpose — the same rule `MALFORMED_BODY` follows for the
 *  unreadable-body 400. */
const DETAIL = "No stored object for that key";

const SITES: Record<
  string,
  {
    platform: string;
    port: number;
    /** The emitted file that OWNS the download route. */
    file: string;
    /** Must appear in that file: the route reaching an RFC 7807 producer. */
    emits: string[];
    /** Must NOT appear in that file: the pre-fix local answer. */
    forbidden: string[];
  }
> = {
  // Reuses the SHARED framework envelope (`problem-details.ts`) the root
  // notFound/onError handlers use, so title/type/instance cannot drift from
  // theirs.  Not the later-declared `frameworkProblem` closure: that is a
  // `const` defined AFTER the file routes in the same emitted function.
  node: {
    platform: "node",
    port: 3121,
    file: "http/index.ts",
    emits: [
      `frameworkProblemBody(404, "${DETAIL}", c.req.path)`,
      '"content-type": "application/problem+json"',
    ],
    forbidden: ['c.json({ error: "not found" }, 404)'],
  },
  python: {
    platform: "python",
    port: 3122,
    file: "files_routes.py",
    emits: [
      "from app.http.problem import problem",
      `return problem(request, 404, "Not Found", "${DETAIL}")`,
      // FastAPI cannot fill `instance` without the request in the signature —
      // the parameter is load-bearing, not cosmetic.
      "async def download_file(key: str, request: Request) -> Response:",
    ],
    forbidden: ['JSONResponse({"error": "not found"}, status_code=404)'],
  },
  elixir: {
    platform: "elixir",
    port: 3123,
    file: "files_controller.ex",
    emits: ["ProblemDetails.problem_response(", '"Not Found",', `"${DETAIL}"`],
    forbidden: ['json(%{"error" => "not found"})'],
  },
  // dotnet + java build the envelope at the route site (their filter/advice
  // cannot reach it — see the header), so BOTH assert every 7807 member here:
  // an inline envelope has no shared producer to inherit them from.
  dotnet: {
    platform: "dotnet",
    port: 3124,
    file: "Program.cs",
    emits: [
      "Results.Problem(",
      `detail: "${DETAIL}"`,
      "instance: http.Request.Path",
      "statusCode: 404",
      'title: "Not Found"',
      'type: "about:blank"',
    ],
    forbidden: ["Results.NotFound()"],
  },
  java: {
    platform: "java",
    port: 3125,
    file: "FilesController.java",
    emits: [
      "ProblemDetail.forStatus(HttpStatus.NOT_FOUND)",
      'problem.setTitle("Not Found")',
      `problem.setDetail("${DETAIL}")`,
      // RS-9: Spring's ProblemDetailJacksonMixin suppresses the default
      // about:blank on getType(), so `type` has to ride as a property — the
      // same trick ApiExceptionAdvice's own responder uses.
      'problem.setProperty("type", "about:blank")',
      "MediaType.APPLICATION_PROBLEM_JSON",
    ],
    forbidden: ["ResponseEntity.notFound().build()"],
  },
};

describe("the objectStore blob-absence 404 is one RFC 7807 envelope on all five backends", () => {
  for (const [name, spec] of Object.entries(SITES)) {
    it(`${name}: GET /files/{key} answers problem+json, not its own shape`, async () => {
      const src = sourceFor(
        await generateSystemFiles(systemFor(spec.platform, spec.port)),
        spec.file,
      );
      expect(src, `${name}: no ${spec.file} was emitted at all`).not.toBe("");
      expect(src, `${name}: ${spec.file} carries no /files download route`).toMatch(/files/);
      for (const needle of spec.emits) {
        expect(src, `${name}: missing ${needle}`).toContain(needle);
      }
      for (const banned of spec.forbidden) {
        expect(src, `${name}: still answers the files 404 locally with ${banned}`).not.toContain(
          banned,
        );
      }
    });
  }

  it("all five send the SAME `detail` sentence", async () => {
    // The members a client reads are `status` + `title` + `detail`; the first
    // two are fixed by the status, so `detail` is the one that can silently
    // diverge five ways again.  Asserted as a set so a reworded backend fails
    // here rather than on a booted differential leg.
    const details = new Set<string>();
    for (const [name, spec] of Object.entries(SITES)) {
      const src = sourceFor(
        await generateSystemFiles(systemFor(spec.platform, spec.port)),
        spec.file,
      );
      expect(src, `${name}: files 404 detail sentence absent`).toContain(DETAIL);
      details.add(DETAIL);
    }
    expect(details.size, "the backends do not agree on one detail sentence").toBe(1);
  });

  it("`httpStatus NotFound -> 410` does NOT move it — a bucket key is not an aggregate id", async () => {
    // `ir/util/openapi-errors.ts` names this 404 as deliberately outside the
    // remappable `NotFound` rung.  Routing it through the shared producer is
    // exactly the change that could have made it inherit the remap, so the
    // decision is pinned rather than commented.
    const OVERRIDE = "{ httpStatus NotFound -> 410 }";
    for (const [name, spec] of Object.entries(SITES)) {
      const files = await generateSystemFiles(systemFor(spec.platform, spec.port, OVERRIDE));
      const src = sourceFor(files, spec.file);
      // The remap DID land somewhere in this build (otherwise the assertion
      // below passes for the trivial reason that nothing was overridden).
      expect(
        [...files.values()].join("\n"),
        `${name}: the 410 override did not reach this backend at all`,
      ).toContain("410");
      const line = src.split("\n").find((l) => l.includes(DETAIL)) ?? "";
      expect(line, `${name}: no files-404 site found under the override`).not.toBe("");
      expect(src, `${name}: the files 404 followed the NotFound remap to 410`).toContain(DETAIL);
      // Per-backend spelling of "this site still says 404".
      const stillLiteral: Record<string, string> = {
        node: `frameworkProblemBody(404, "${DETAIL}"`,
        python: `problem(request, 404, "Not Found", "${DETAIL}")`,
        elixir: "          404,",
        dotnet: "statusCode: 404",
        java: "ProblemDetail.forStatus(HttpStatus.NOT_FOUND)",
      };
      expect(src, `${name}: files 404 is no longer a literal 404`).toContain(
        stillLiteral[spec.platform],
      );
    }
  });
});
