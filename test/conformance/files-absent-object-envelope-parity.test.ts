// M-T6.39 — `GET /files/{key}`'s ABSENT-OBJECT 404 comes out of the service's
// one 404 producer, on all five backends.
//
// The sibling of `absent-read-envelope-parity.test.ts` (M-T6.31), at the one
// absent-read site that mission deliberately left open. M-T6.31 unified three
// envelope shapes across the aggregate by-id / projection-show /
// workflow-instance-show reads; the root file-download route was a FOURTH shape
// and — unlike those — *no* backend answered RFC 7807 on it:
//
//   node, python, elixir : `{"error":"not found"}` as plain application/json
//   dotnet, java         : an EMPTY 404 body
//
// The two bodiless ones are the subtler half. Neither stays empty on the wire:
// .NET's `UseStatusCodePages` and the servlet container fill a bodiless 4xx with
// the FRAMEWORK-miss problem, whose detail reads "no route for GET /files/<key>"
// — a sentence that is simply false. The route exists; the OBJECT does not.
// A client cannot tell a mistyped URL from a deleted upload.
//
// THE THREE PROPERTIES THIS TEST INHERITS from its M-T6.31 sibling, each learned
// from a way an earlier pin of this rule shipped broken:
//
//  1. **Per-SITE, not per-backend.** The defect is "one route of a service
//     answers differently from the rest of the same service", so each assertion
//     names the emitted file that OWNS the route.
//  2. **File-scoped.** A backend-wide `toContain` is satisfied by whichever
//     sibling route is already correct — the trap that let java's controller
//     answer an empty body while "java emits the sentence" was true.
//  3. **A NEGATIVE beside every positive.** The positive alone cannot tell "the
//     arm raises" from "the arm was renamed"; the negative alone cannot tell "it
//     raises" from "the route was deleted".
//
// The runtime companion is the behavioral tier's absent-file probe
// (`test/behavioral/wire-differential.mjs`, fired on any case whose deployable
// mounts the pair — `file-download.ddd` is that case), which diffs the recorded
// 404 body against the committed wire golden on all five booted legs. This file
// is the fast static half: it fails in the unit suite rather than a boot.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** One canonical single-backend system per platform carrying the route: a
 *  `File`-typed field (which is what makes a backend emit `/files`) plus a bound
 *  `objectStore` (which is what it stores through). Both halves are required —
 *  an objectStore with no `File` field emits no route at all. */
function systemFor(platform: string, port: number): string {
  return `
system FS {
  subdomain D {
    context Docs {
      aggregate Attachment with crudish {
        title: string
        doc: File?
      }
    }
  }
  api A from D
  storage primary { type: postgres }
  storage uploads { type: localDisk }
  resource docsState { for: Docs, kind: state, use: primary }
  resource docsFiles { for: Docs, kind: objectStore, use: uploads }
  deployable d {
    platform: ${platform}
    contexts: [Docs]
    dataSources: [docsState, docsFiles]
    serves: A
    port: ${port}
  }
}`;
}

const sourceFor = (files: Map<string, string>, ...suffixes: string[]): string =>
  [...files.entries()]
    .filter(([k]) => suffixes.some((s) => k.endsWith(s)))
    .map(([, v]) => v)
    .join("\n");

const SITES: Record<
  string,
  {
    platform: string;
    port: number;
    /** The emitted file that owns the download route. */
    file: string;
    /** Must appear: the reach for the service's one 404 producer. */
    raises: string[];
    /** Must NOT appear in that file: the local, non-7807 answer. */
    forbidden: string[];
  }
> = {
  // The root app carries the domain ladder (M-T6.28), so a throw from a route
  // mounted on it renders as the shared envelope with no per-route handler.
  node: {
    platform: "node",
    port: 3140,
    file: "http/index.ts",
    raises: ["if (!obj) throw new AggregateNotFoundError(`File ${key} not found`);"],
    forbidden: ['c.json({ error: "not found" }, 404)'],
  },
  python: {
    platform: "python",
    port: 3141,
    file: "files_routes.py",
    raises: ['raise AggregateNotFoundError(f"File {key} not found")'],
    forbidden: ['JSONResponse({"error": "not found"}, status_code=404)'],
  },
  elixir: {
    platform: "elixir",
    port: 3142,
    file: "files_controller.ex",
    raises: ['ProblemDetails.not_found_response(conn, "File", key)'],
    forbidden: ['json(%{"error" => "not found"})'],
  },
  // An ordinary `@RestController`, so the global `@RestControllerAdvice`
  // (ApiExceptionAdvice.onNotFound) renders the carrier — the same producer the
  // aggregate reads use.
  java: {
    platform: "java",
    port: 3143,
    file: "FilesController.java",
    raises: ['throw new AggregateNotFoundException("File " + key + " not found");'],
    forbidden: ["ResponseEntity.notFound().build()"],
  },
  // .NET is the one backend where "raise the carrier" is not available: the
  // route is a MINIMAL API, and DomainExceptionFilter is an `IExceptionFilter`,
  // so a throw here never reaches it. It calls that filter's own static
  // responder instead — still one construction site, not two.
  dotnet: {
    platform: "dotnet",
    port: 3144,
    file: "Program.cs",
    raises: ['DomainExceptionFilter.NotFoundProblem(http, log, $"File {key} not found")'],
    forbidden: ["Results.NotFound()"],
  },
};

describe("M-T6.39 — an absent /files object answers the service's one 404 envelope, all five backends", () => {
  for (const [name, spec] of Object.entries(SITES)) {
    it(`${name} reaches the shared envelope`, async () => {
      const src = sourceFor(
        await generateSystemFiles(systemFor(spec.platform, spec.port)),
        spec.file,
      );
      expect(src, `${name}: no ${spec.file} was emitted at all`).not.toBe("");
      // Guard against the file-scoped needle matching a file that no longer
      // carries the route: property 2 above only holds if the route is here.
      expect(src, `${name}: ${spec.file} carries no /files download route`).toMatch(
        /\/files\/[:{]key/,
      );
      for (const needle of spec.raises) {
        expect(src, `${name}: missing ${needle}`).toContain(needle);
      }
      for (const banned of spec.forbidden) {
        expect(src, `${name}: still answers locally with ${banned}`).not.toContain(banned);
      }
    });
  }

  // The PRODUCER half — reading only the route cannot tell whether the thing it
  // reaches actually renders as 7807. Every member of the envelope is named, so
  // a producer that drops `instance` (the .NET ProblemDetailsFactory divergence
  // M-T6.31 documented) fails here rather than on a booted leg.
  it("dotnet's minimal-API responder builds the same 7807 body the filter does", async () => {
    const filter = sourceFor(
      await generateSystemFiles(systemFor("dotnet", 3145)),
      "DomainExceptionFilter.cs",
    );
    expect(filter).toContain("public static Microsoft.AspNetCore.Http.IResult NotFoundProblem(");
    expect(filter).toContain('Type = "about:blank",');
    expect(filter).toContain('Title = "Not Found",');
    expect(filter).toContain("Status = 404,");
    expect(filter).toContain("Instance = http.Request.Path,");
    expect(filter).toContain('contentType: "application/problem+json"');
    // The header + the catalog/metric pair the MVC arms emit, so an operator
    // sees the same correlation and the fault counters cannot under-report.
    expect(filter).toContain('http.Response.Headers["x-request-id"] = trace_id;');
    expect(filter).toContain('RecordDomainFault("not_found");');
    // `Results.Problem` is the trap this responder exists to avoid: it applies
    // ProblemDetailsDefaults (rfc9110 `type`, null `instance`).
    expect(filter).not.toContain("Results.Problem(");
  });

  // The `httpStatus NotFound -> <Code>` override (M-T5.20) used to move every
  // 404 in the app EXCEPT this one, because the route hardcoded its own answer.
  // Joining the shared producer is what makes it move — asserted, not assumed.
  //
  // THIS IS ALSO THE CONTRACT ASSERTION FOR F2-W-13.  That ledger row read the
  // override reaching the blob-absence 404 as a DEFECT, on the strength of a
  // (now corrected) comment in `src/ir/util/openapi-errors.ts` claiming the blob
  // miss "stays literal on all five backends".  It does not, and must not: the
  // remap is the deliberate consequence of M-T6.39 routing every backend's blob
  // miss through its ONE not-found producer.  Giving the blob path a literal
  // carrier of its own — F2-W-13's proposed fix — fails the cases below.
  //
  // The title said "on all five" while the body checked TWO.  It now checks
  // five: the three the original left out are exactly the ones whose producer is
  // a shared HELPER, where a regression would look like the helper still
  // existing but the route no longer reaching it.
  const overridden = (platform: string, port: number) =>
    systemFor(platform, port).replace(
      "  api A from D",
      "  api A from D { httpStatus NotFound -> 410 }",
    );

  it("an httpStatus NotFound override retargets the files 404 too — dotnet + elixir", async () => {
    // .NET is the one backend that bakes the literal into the route's own
    // responder, so the resolved status has to appear in the responder itself.
    const dotnet = sourceFor(
      await generateSystemFiles(overridden("dotnet", 3146)),
      "DomainExceptionFilter.cs",
    );
    expect(dotnet).toContain("Status = 410,");
    expect(dotnet).toContain("statusCode: 410");

    const elixir = sourceFor(
      await generateSystemFiles(overridden("elixir", 3147)),
      "problem_details.ex",
    );
    expect(elixir).toContain("problem_response(conn, 410,");
  });

  // node / python / java resolve the status once, inside the shared producer.
  // The property to pin is therefore TWO-part and per-SITE (property 1 above):
  // the producer answers the OVERRIDDEN status, AND the files route still
  // reaches that producer rather than answering 404 itself.
  const SHARED_PRODUCER: Record<
    string,
    { port: number; producerFile: string; resolved: string[]; routeFile: string }
  > = {
    node: {
      port: 3148,
      producerFile: "http/index.ts",
      // The `onError` not-found arm, not merely the digit somewhere in the file
      // — a bare "410" would also match the `problem(status: … | 410 | …)`
      // signature, which is present whether or not the arm resolves.
      resolved: [
        'baseLogger.warn({ event: "not_found", status: 410 });',
        'return problem(410, "Gone", err.message);',
      ],
      routeFile: "http/index.ts",
    },
    python: {
      port: 3149,
      producerFile: "http/problem.py",
      resolved: [
        'log("warn", "not_found", message=str(err), status=410)',
        'return problem(request, 410, "Gone", str(err))',
      ],
      routeFile: "files_routes.py",
    },
    java: {
      port: 3150,
      producerFile: "ApiExceptionAdvice.java",
      resolved: [
        'CatalogLog.event("not_found", "warn", "status", 410);',
        'return respond(problem(410, "Gone", e.getMessage(), request), 410);',
      ],
      routeFile: "FilesController.java",
    },
  };

  for (const [platform, spec] of Object.entries(SHARED_PRODUCER)) {
    it(`an httpStatus NotFound override retargets the files 404 too — ${platform}`, async () => {
      const files = await generateSystemFiles(overridden(platform, spec.port));
      const producer = sourceFor(files, spec.producerFile);
      for (const needle of spec.resolved) {
        expect(
          producer,
          `${platform}: ${spec.producerFile} must carry the resolved status`,
        ).toContain(needle);
      }
      // The route must still REACH that producer — the half a status-only
      // assertion cannot see.  `SITES[platform].raises` is the same reach the
      // per-site cases above pin, re-asserted under the override so a fix that
      // gave the blob path its own literal carrier fails here too.
      const route = sourceFor(files, spec.routeFile);
      for (const needle of SITES[platform]!.raises) expect(route).toContain(needle);
      for (const needle of SITES[platform]!.forbidden) expect(route).not.toContain(needle);
    });
  }
});
