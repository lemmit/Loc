// RS-28 — the unmodelled-fault arm is a sanitized 500 with the literal detail
// `"internal"`, on all five backends.
//
// This is a STATIC gate on purpose, and the reason is the interesting part: no
// system in the shared behavioural corpus reaches this arm.  Every error those
// fixtures produce is MODELLED — a declared `error` variant, a wire-validation
// failure, or a denial rung — so the M-T9.11 wire golden runs all five legs green
// with a divergence sitting right here.  An arm no fixture reaches is exactly the
// arm that drifts, which is why it needs a named rule and a cheap gate rather
// than waiting for behavioural coverage that may never arrive.
//
// Two independent regressions are pinned:
//
//   1. STATUS — elixir answered `400` here.  An error the server did not model
//      is a SERVER fault; 4xx tells the caller to fix a request that was never
//      the problem.  (It survived RS-15's 400 → 422 sweep precisely because it
//      is not the domain floor: RS-15 moved the rejections the domain MAKES,
//      and this is the rejection nobody made.)
//   2. DETAIL — elixir `inspect/1`'d the raw term into the body, leaking struct
//      names and module paths to an unauthenticated caller; python sent its own
//      prose sentence, which leaked nothing but was not byte-identical.  Both
//      now send the fixed literal.
//
// The negative assertions matter as much as the positive one: a backend that
// starts rendering the fault into `detail` still emits the 500, so only the
// absence check catches it.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

// Carries a WORKFLOW deliberately.  On vanilla Phoenix the sanitized arm lives
// in the `respond/2` dispatcher that `workflow-execution-emit` /
// `explicit-handlers-emit` render — a plain CRUD system emits no such arm at all
// (see the "app-global gap" note at the bottom of this file).  The other four
// backends install an app-global handler and would pass either way, so the
// fixture is shaped to the narrowest backend.
const SOURCE = (platform: string) => `
system Faults {
  subdomain Ops {
    context Ops {
      aggregate Job {
        label: string
        create(label: string) { }
        operation finish() { label := "done" }
      }
      repository Jobs for Job { }
      workflow RunJob {
        create(label: string) {
          let j = Job.create({ label: label })
          j.finish()
        }
      }
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

/** The emitted catch-all arm per backend — status, reason phrase, and the
 *  sanitized detail, as each language spells the same three values. */
const SANITIZED_ARM: Record<string, RegExp> = {
  node: /problem\(500, "Internal Server Error", "internal"\)/,
  dotnet: /Problem\(context, 500, "Internal Server Error", "internal"/,
  java: /problem\(500, "Internal Server Error", "internal"/,
  python: /problem\(request, 500, "Internal Server Error", "internal"\)/,
  elixir: /problem_response\(conn, 500, "Internal Server Error", "internal"\)/,
};

/** Shapes that mean the fault itself reached the wire. `inspect(reason)` is the
 *  elixir form; the others would render a message or a stringified error. */
const LEAK_SHAPES: Record<string, RegExp[]> = {
  node: [/problem\(\d+, "[^"]*", (err|e)\.message\)[^;]*catch-all/],
  dotnet: [],
  java: [],
  python: [/problem\(request, 500, "Internal Server Error", "An unexpected error occurred\."\)/],
  elixir: [/problem_response\(conn, \d+, "[^"]*", inspect\(reason\)\)/],
};

const PLATFORMS = ["node", "dotnet", "java", "python", "elixir"] as const;

async function emit(platform: string): Promise<string> {
  const files = await generateSystemFiles(SOURCE(platform));
  return [...files.values()].join("\n");
}

describe("RS-28 — an unmodelled fault is a sanitized 500 on every backend", () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: emits 500 "Internal Server Error" with detail "internal"`, async () => {
      expect(await emit(platform)).toMatch(SANITIZED_ARM[platform]!);
    });

    it(`${platform}: does not render the fault into the response body`, async () => {
      const out = await emit(platform);
      for (const leak of LEAK_SHAPES[platform] ?? []) {
        expect(out, "the unmodelled fault is reaching the wire").not.toMatch(leak);
      }
    });
  }

  it("the detail literal is identical on all five — the byte the golden would pin", async () => {
    // Stated as one cross-backend assertion rather than five per-backend ones so
    // a future change that moves four backends to a new wording fails here, not
    // silently four-fifths of the way through.
    const details = await Promise.all(
      PLATFORMS.map(async (p) => {
        const out = await emit(p);
        const m = /"Internal Server Error",\s*"([^"]*)"/.exec(out);
        return [p, m?.[1] ?? "<no sanitized 500 arm found>"] as const;
      }),
    );
    expect(Object.fromEntries(details)).toEqual({
      node: "internal",
      dotnet: "internal",
      java: "internal",
      python: "internal",
      elixir: "internal",
    });
  });

  it("the EXTERN-handler 500 is sanitized too — RS-28's own named trigger", async () => {
    // The assertion that was missing, and the reason RS-28's `conforms` list was
    // wrong for a second time.
    //
    // The gate above checks the arm each backend FALLS THROUGH to. RS-28's
    // `trigger` names a different path first: "a hand-written `extern` handler
    // returning an unmodelled error". Node and .NET wrap that throw in an
    // `ExternHandlerError` / `ExternHandlerException` whose `message`
    // interpolates the INNER exception, and sent the whole thing as `detail`:
    //
    //   "Extern handler 'settle' on 'Invoice' threw: <whatever user code threw>"
    //
    // In practice that inner message is a driver or HTTP-client exception
    // carrying SQL text, URLs, host names or connection strings — the exact leak
    // RS-28's DETAIL claim forbids, on the exact trigger it names. Java, python
    // and elixir emit no such arm and were always correct.
    //
    // The generalizable lesson: a rule's `trigger` enumerates the paths that
    // must be checked. Checking the default fall-through arm is not checking the
    // trigger.
    const src = `
system Ext {
  subdomain Ops {
    context Ops {
      aggregate Invoice {
        state: string
      }
      repository Invoices for Invoice { }
      extern commandHandler Settle(invoiceId: string): Invoice id;
    }
  }
  api OpsApi from Ops {
    route POST "/invoices/settle" -> Ops.Settle
  }
  storage primary { type: postgres }
  resource opsState { for: Ops, kind: state, use: primary }
  deployable api {
    platform: __P__
    contexts: [Ops]
    dataSources: [opsState]
    serves: OpsApi
    port: 8080
  }
}
`;
    for (const p of PLATFORMS) {
      const out = [...(await generateSystemFiles(src.replace("__P__", p))).values()].join("\n");
      // Whether the backend WRAPS the extern throw is a per-backend choice and
      // not what this pins. What it pins is that if a wrapper exists, its
      // message never becomes the body.
      expect(
        out,
        `${p}: the extern-handler 500 sends the wrapper's message — which carries ` +
          "the inner exception the user handler threw — as a public RFC 7807 detail",
      ).not.toMatch(/"Internal Server Error",\s*(err|e|xh)\.[Mm]essage/);
    }
  });
});

// ---------------------------------------------------------------------------
// FINDING, not covered by RS-28 — vanilla Phoenix has no app-global 7807 arm.
//
// Writing the gate above surfaced a divergence larger than the one the rule was
// minted for, and it is recorded here rather than quietly designed around.
//
// The four non-elixir backends install an APP-GLOBAL unhandled-exception handler
// (`app.onError`, `DomainExceptionFilter`, `ApiExceptionAdvice`,
// `install_error_handlers`), so ANY unmodelled fault — on any route, in any
// system — answers the RFC 7807 envelope.  Vanilla Phoenix's sanitized arm lives
// only in the `respond/2` dispatchers rendered for workflows and extern
// handlers.  A plain CRUD system emits none, and an unhandled exception falls
// through to Phoenix's `ErrorJSON`:
//
//     %{errors: %{detail: Phoenix.Controller.status_message_from_template(t)}}
//
// which is a DIFFERENT SHAPE, not merely a different detail — `{"errors":
// {"detail":"Internal Server Error"}}` against the other four's `{"type",
// "title","status","detail","instance"}`.  A client parsing 7807 gets nothing it
// can read.
//
// Left open deliberately: closing it means giving the generated Phoenix app a
// 7807-shaped error view + content-type at the shell level (`shell-emit.ts`),
// which is a different unit from M-T6.24's denial-protocol edges and is not
// something to bolt onto a test file.  The M-T9.11 golden cannot see it either —
// no shared fixture reaches an unmodelled fault.  Tracked in
// docs/new-plan/T6-backend-parity.md.
// ---------------------------------------------------------------------------
