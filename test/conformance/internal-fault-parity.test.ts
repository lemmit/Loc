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

// Carries a WORKFLOW deliberately: it reaches each backend's PER-ROUTE
// sanitized arm (the `respond/2` dispatcher on elixir, the per-router ladders
// elsewhere), which is a different construct from the app-global floor the
// second describe block below pins on a plain-CRUD fixture.  Both matter — the
// route arms are refinements that answer FIRST, the floor is what everything
// else inherits — so both are gated, on the fixture that reaches each.
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
// M-T6.30 — the APP-GLOBAL floor, on the system shape that has nothing else.
//
// The block above reaches each backend's per-ROUTE sanitized arm, and it needed
// a workflow to do it.  That is precisely what hid this: vanilla Phoenix's arm
// lived ONLY in the `respond/2` dispatchers `workflow-execution-emit` /
// `explicit-handlers-emit` render, so a plain CRUD system — the most common
// shape there is — emitted no such arm at all.  A controller raise fell through
// to phoenix's own machinery: an HTML debug page in dev (`debug_errors: true`),
// and in prod a body rendered by `Phoenix.Endpoint.RenderErrors` under
// `application/json` with the exception's own message as `detail`.  The other
// four install an app-global handler and pass either way, which is why a
// fixture shaped to them proves nothing here.
//
// So this block drops the workflow, and asserts PER FILE.  Both halves are
// load-bearing:
//
//   THE FIXTURE — a system whose only fault path is the floor.  With a workflow
//   present, elixir's `respond/2` satisfies a search for the sanitized arm and
//   the floor can be missing entirely.
//
//   PER-FILE — a joined-output `toMatch` over all emitted files is satisfied by
//   ANY sibling that happens to carry the shape, so it cannot tell "the floor
//   is installed" from "some route has a ladder".  That is the exact trap
//   `framework-error-contract-parity` documents twice (the node arm in #2472,
//   the elixir `route_info` probe), and the reason each assertion below names
//   the ONE file the construct must live in and reads only that file.
// ---------------------------------------------------------------------------

/** Same system as `SOURCE`, with the workflow removed — nothing in it maps an
 *  unmodelled fault, so the ONLY thing that can answer one is the floor. */
const CRUD_SOURCE = (platform: string) => `
system Faults {
  subdomain Ops {
    context Ops {
      aggregate Job {
        label: string
        create(label: string) { }
        operation finish() { label := "done" }
      }
      repository Jobs for Job { }
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

type FileAssertion = {
  /** What the construct is, and what its absence costs — the failure message. */
  why: string;
  /** The ONE emitted file the construct must live in. */
  file: RegExp;
  shape: RegExp;
  /** When set, the file must NOT match — the pre-fix shape. */
  absent?: boolean;
};

/** Each backend's app-global floor: the handler that answers a fault nothing
 *  else mapped, and the line that installs it for the WHOLE app.  Both are
 *  needed — a handler nothing mounts is not a floor. */
const FLOOR: Record<(typeof PLATFORMS)[number], FileAssertion[]> = {
  node: [
    {
      why: "the root app's onError — the floor every mounted sub-app inherits",
      file: /(^|\/)http\/index\.ts$/,
      shape: /app\.onError\(\(err, c\) => \{/,
    },
    {
      why: "the sanitized 500 tail on the ROOT handler (not a sub-router's)",
      file: /(^|\/)http\/index\.ts$/,
      shape: /frameworkProblem\(c, 500, "internal"\)/,
    },
  ],
  dotnet: [
    {
      why: "DomainExceptionFilter's unhandled-exception tail",
      file: /DomainExceptionFilter\.cs$/,
      shape: /Problem\(context, 500, "Internal Server Error", "internal"/,
    },
    {
      why: "the filter registered app-globally in the MVC pipeline",
      file: /(^|\/)Program\.cs$/,
      shape: /Filters\.Add<DomainExceptionFilter>\(\)/,
    },
  ],
  java: [
    {
      why: "ApiExceptionAdvice's Exception.class tail",
      file: /ApiExceptionAdvice\.java$/,
      shape: /@ExceptionHandler\(Exception\.class\)/,
    },
    {
      why: "the advice applied app-globally",
      file: /ApiExceptionAdvice\.java$/,
      shape: /@RestControllerAdvice/,
    },
    {
      why: "the sanitized 500 the tail sends",
      file: /ApiExceptionAdvice\.java$/,
      shape: /problem\(500, "Internal Server Error", "internal", request\)/,
    },
  ],
  python: [
    {
      why: "the catch-all Exception handler",
      file: /app\/http\/problem\.py$/,
      shape: /@app\.exception_handler\(Exception\)/,
    },
    {
      why: "the sanitized 500 it sends",
      file: /app\/http\/problem\.py$/,
      shape: /problem\(request, 500, "Internal Server Error", "internal"\)/,
    },
    {
      why: "the handlers installed onto the app",
      file: /app\/main\.py$/,
      shape: /^install_error_handlers\(app\)$/m,
    },
  ],
  elixir: [
    // The floor itself.  M-T6.30: before it, this file did not exist and NO
    // file in a plain-CRUD emission carried the literal.
    {
      why: "the FaultHandler's sanitized 500 — the arm a plain CRUD system had none of",
      file: /fault_handler\.ex$/,
      shape: /problem_response\(conn, 500, "Internal Server Error", "internal"\)/,
    },
    {
      why: "the floor rescuing what the router raises (a controller raise arrives wrapped)",
      file: /fault_handler\.ex$/,
      shape: /e in Plug\.Conn\.WrapperError ->/,
    },
    // A `WrapperError` also wraps a THROW or an EXIT (`kind: :throw | :exit`),
    // and the handler used to pass a hardcoded `:error` on.  That kind is
    // load-bearing twice: `Exception.format(kind, …)` formats a thrown term as
    // an exception (a garbled operator log line — the ONE place the fault is
    // recorded in full), and the already-sent path re-raises with
    // `:erlang.raise(kind, …)`, which would turn an exit into an error.
    {
      why: "the wrapped fault's own KIND is forwarded, not collapsed to `:error`",
      file: /fault_handler\.ex$/,
      shape: /handle\(e\.conn \|\| conn, e\.kind, e\.reason, e\.stack\)/,
    },
    {
      why: "the router mounted THROUGH the floor — a handler nothing mounts is not a floor",
      file: /endpoint\.ex$/,
      shape: /^ {2}plug \w+Web\.FaultHandler$/m,
    },
    // The mutation this pins is the one that reads as harmless: putting the
    // router back in the endpoint directly.  Every other assertion here can
    // stay green while the floor is bypassed.
    {
      why: "the router is NOT ALSO mounted directly, which would bypass the floor",
      file: /endpoint\.ex$/,
      shape: /^ {2}plug \w+Web\.Router$/m,
      absent: true,
    },
    // `ErrorJSON` still renders for a fault raised by an endpoint plug ABOVE
    // the floor (nothing in a plug pipeline can wrap what runs before it), so
    // the sanitization must hold on that path too — the leak must not depend on
    // which of the two paths a request happened to take.
    {
      why: "ErrorJSON sanitizes its own >= 500 detail",
      file: /error_json\.ex$/,
      shape: /defp detail_for\(status, _assigns, _title\) when status >= 500, do: "internal"/,
    },
    {
      why: "…and does so BEFORE the reason.message clause, or the message wins",
      file: /error_json\.ex$/,
      shape: /when status >= 500, do: "internal"[\s\S]*%\{reason: %\{message: message\}\}/,
    },
  ],
};

describe("M-T6.30 — a plain CRUD system has an app-global 7807 floor (all five)", () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: installs the floor, in the file that owns it`, async () => {
      const files = await generateSystemFiles(CRUD_SOURCE(platform));
      for (const { why, file, shape, absent } of FLOOR[platform]) {
        const matched = [...files].filter(([rel]) => file.test(rel));
        expect(
          matched.map(([rel]) => rel),
          `${platform}: no emitted file matches ${file} — the file that must carry ${why}`,
        ).not.toHaveLength(0);
        // Read each candidate's OWN content.  Never a join: a sibling file
        // carrying the same shape would satisfy a concatenation and the
        // assertion would stop naming the construct it claims to gate.
        const hit = matched.some(([, content]) => shape.test(content));
        if (absent) {
          expect(
            matched.filter(([, content]) => shape.test(content)).map(([rel]) => rel),
            `${platform}: ${why}`,
          ).toHaveLength(0);
        } else {
          expect(hit, `${platform} is missing ${why} (searched ${matched.length} file(s))`).toBe(
            true,
          );
        }
      }
    });
  }

  it("elixir's floor does not put the fault itself on the wire", async () => {
    // The floor is the one place that sees the raw exception, so it is the one
    // place that can leak it.  RS-28's DETAIL claim, asserted where the fault
    // actually arrives rather than on the arm it falls through to.
    const files = await generateSystemFiles(CRUD_SOURCE("elixir"));
    const [, floor] = [...files].find(([rel]) => /fault_handler\.ex$/.test(rel)) ?? [];
    expect(floor, "no fault_handler.ex emitted").toBeDefined();
    for (const leak of [
      /problem_response\([^)]*inspect\(/,
      /problem_response\([^)]*Exception\.message\(/,
      /problem_response\([^)]*reason\.message/,
    ]) {
      expect(floor, "the unmodelled fault is reaching the wire from the floor").not.toMatch(leak);
    }
  });
});
