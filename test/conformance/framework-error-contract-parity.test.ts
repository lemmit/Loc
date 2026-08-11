// RS-9 — a fault the FRAMEWORK raises answers in the same RFC 7807 envelope a
// DOMAIN error does, on all five backends.
//
// This is the arm no fixture reaches, in the same sense as RS-28's: every error
// the behavioural corpus produces is one the emitted code RAISES, so the
// M-T9.11 wire golden ran five legs green while a wrong verb, an unknown path
// or an unreadable body answered five different shapes.  Measured on booted
// backends before this gate existed (`PUT /api/items` against a POST-only
// route):
//
//   node    404  text/plain          "404 Not Found"
//   python  405  application/json    {"detail":"Method Not Allowed"}
//   dotnet  405  (no body at all)
//   java    500  application/problem+json  detail "internal"
//   elixir  404  application/json    {"errors":{"detail":…}}
//
// Five shapes, three statuses, and java calling a client's typo a SERVER fault.
// A client cannot parse two error contracts, and RS-9's `type` member (present,
// `about:blank`) held on exactly none of them.
//
// The gate is STATIC because the runtime tier cannot see it: the emitted test
// suites only make requests the API serves.  It pins the SEAM each backend
// installs — the handler that catches a framework fault and routes it through
// the same responder the domain arms use.  Deleting any one of those seams (the
// mutation each assertion is proved against) fails here per-PR.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const SOURCE = (platform: string) => `
system Framework {
  subdomain Ops {
    context Ops {
      aggregate Item {
        label: string
        create(label: string) { }
      }
      repository Items for Item { }
    }
  }
  api OpsApi from Ops
  storage primary { type: postgres }
  resource opsState { for: Ops, kind: state, use: primary }
  deployable api {
    platform: ${platform}
    contexts: [Ops]
    dataSources: [opsState]
    serves: OpsApi
    port: 8080
  }
}
`;

const PLATFORMS = ["node", "dotnet", "java", "python", "elixir"] as const;

/** The seam that catches a framework fault, per backend.  Each entry names one
 *  emitted construct; removing it restores the pre-gate behaviour for that
 *  backend, which is how each was mutation-proved. */
const SEAMS: Record<(typeof PLATFORMS)[number], { why: string; shape: RegExp; file?: RegExp }[]> = {
  node: [
    // Hono's default for an unmatched route is `text/plain` "404 Not Found" —
    // no router's onError ever runs, because no router was reached.
    { why: "root notFound handler", shape: /app\.notFound\(\(c\) => \{/ },
    // A miss that is really a METHOD mismatch answers 405 + Allow, not 404 —
    // the probe router is what separates the two, and skipping `ALL` is what
    // keeps middleware (`app.use("*", …)`, registered under that method and
    // matching every path) from reporting an Allow on every unknown URL.
    { why: "method-mismatch probe", shape: /methodProbe\.add\(r\.method, r\.path, r\.method\)/ },
    { why: "ALL exclusion in the probe", shape: /if \(r\.method !== "ALL"\)/ },
    // …and a fault hono raises INSIDE a router (a malformed JSON body arrives
    // as HTTPException 400) fell past every domain arm into the generic 500.
    // Scoped to the ROUTER file on purpose: http/index.ts carries the same
    // check for the root handler, so an unscoped search would stay green with
    // the router's arm deleted.
    {
      why: "HTTPException arm in the router",
      shape: /if \(err instanceof HTTPException\)/,
      file: /\.routes\.ts$/,
    },
    { why: "shared framework envelope", shape: /export function frameworkProblemBody\(/ },
  ],
  dotnet: [
    // Routing refuses 404/405/415 before any controller, so the
    // DomainExceptionFilter never sees them and the response had NO body.
    {
      why: "UseStatusCodePages problem body",
      shape: /app\.UseStatusCodePages\(async \(StatusCodeContext/,
    },
    // Model binding / DataAnnotations answer with MVC's own
    // ValidationProblemDetails — a different `type`, title, and errors shape.
    {
      why: "invalid-model-state override",
      shape: /InvalidModelStateResponseFactory = .*ValidationProblem\.FromModelState/,
    },
    // The ProblemDetails the framework builds itself (415) carries the rfc9110
    // `type` URI and a body-borne traceId.
    { why: "framework ProblemDetails normalisation", shape: /CustomizeProblemDetails/ },
  ],
  java: [
    // Spring's client-error exceptions all implement ErrorResponse; matching
    // the INTERFACE keeps this right for the ones not enumerated here.
    { why: "ErrorResponse arm", shape: /instanceof org\.springframework\.web\.ErrorResponse er/ },
  ],
  python: [
    // Starlette answers `{"detail": …}` as plain application/json.
    {
      why: "StarletteHTTPException handler",
      shape: /@app\.exception_handler\(StarletteHTTPException\)/,
    },
    // FastAPI funnels an unreadable body into RequestValidationError, so python
    // was the one backend answering 422 (with a byte-offset pointer) where the
    // others answer 400.
    { why: "json_invalid → 400 split", shape: /== "json_invalid" for e in err\.errors\(\)/ },
  ],
  elixir: [
    // The ErrorJSON view renders the 7807 BODY, but phoenix renders it through
    // the `json` format — `application/json`.  A controller is the only place
    // the content type can be set, hence the catch-all route.
    { why: "catch-all route", shape: /match :\*, "\/\*path", NotFoundController, :not_found/ },
    // Same 405 split as node, through phoenix's own router lookup.  The
    // `%{plug: __MODULE__}` arm is load-bearing: this controller IS the
    // catch-all, registered for `:*`, so route_info matches it for every method
    // on every path — counting those would answer 405 for a URL serving nothing.
    //
    // Both are scoped to the CONTROLLER file.  `Phoenix.Router.route_info(`
    // already appears in `request_context.ex` and `telemetry.ex`, which call it
    // to recover the route template for a log line — an unscoped search finds
    // those and stays green with this probe deleted.  (Mutation caught it; the
    // identical trap took the node arm in #2472.)
    {
      why: "method-mismatch probe",
      shape: /Phoenix\.Router\.route_info\(/,
      file: /not_found_controller\.ex$/,
    },
    {
      why: "catch-all self-exclusion",
      shape: /%\{plug: __MODULE__\} -> false/,
      file: /not_found_controller\.ex$/,
    },
    {
      why: "problem+json content type",
      shape: /put_resp_content_type\("application\/problem\+json"\)\n {4}\|> send_resp\(status/,
    },
    { why: "RFC 7807 ErrorJSON view", shape: /type: "about:blank",\n {6}title: title,/ },
  ],
};

async function emit(platform: string): Promise<Map<string, string>> {
  return await generateSystemFiles(SOURCE(platform));
}

/** Concatenate the emitted files a seam applies to — all of them by default,
 *  or only the paths matching its `file` scope. */
function scope(files: Map<string, string>, file?: RegExp): string {
  return [...files]
    .filter(([rel]) => (file ? file.test(rel) : true))
    .map(([, content]) => content)
    .join("\n");
}

describe("RS-9 — a framework fault answers the same RFC 7807 envelope (all five)", () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: installs every framework-fault seam`, async () => {
      const files = await emit(platform);
      for (const { why, shape, file } of SEAMS[platform]) {
        const out = scope(files, file);
        expect(
          out,
          `${platform} is missing its ${why} — a framework fault bypasses the contract`,
        ).toMatch(shape);
      }
    });
  }

  it("no backend answers a framework fault outside application/problem+json", async () => {
    // The shapes each backend used to send.  Stated as absences because a
    // backend that regresses still emits SOMETHING for the fault — only the
    // old shape's return distinguishes the regression from the fix.
    const OLD_SHAPES: Record<string, RegExp[]> = {
      // phoenix's scaffold ErrorJSON: `%{errors: %{detail: …}}`.
      elixir: [/%\{errors: %\{detail:/],
      // python passing starlette's `{"detail": …}` straight through.
      python: [/JSONResponse\(\{"detail":/],
      node: [],
      dotnet: [],
      java: [],
    };
    for (const platform of PLATFORMS) {
      const out = scope(await emit(platform));
      for (const old of OLD_SHAPES[platform] ?? []) {
        expect(out, `${platform} still emits its pre-RS-9 framework-error body`).not.toMatch(old);
      }
    }
  });

  it("every backend's framework envelope carries `type: about:blank` (RS-9's own member)", async () => {
    // RS-9 names `type` specifically: it was the member absent from four of the
    // five framework bodies, and the one that tells a client the response is a
    // problem document at all.
    for (const platform of PLATFORMS) {
      const out = scope(await emit(platform));
      expect(out, `${platform} framework envelope has no about:blank type`).toMatch(/about:blank/);
    }
  });
});
