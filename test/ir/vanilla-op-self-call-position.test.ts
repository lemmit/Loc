// Vanilla (plain Ecto) operation→operation self-call position gate
// (`loom.vanilla-op-call-position`).  An aggregate operation compiles to a
// context function `<op>_<agg>(record, params)` returning a tagged
// `{:ok,_} | {:error,_}` tuple, so a sibling-op self-call can only be PASSED
// THROUGH as the whole `return` value — it cannot be composed into a larger
// expression or bound with `let`, because an Elixir tuple has no implicit
// unwrap.  The tail form is allowed; every other position is rejected.  The
// other backends model an operation as a plain value-returning method, so the
// same `.ddd` is accepted there (platform-scoped gate, elixir only).

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function positionErrors(
  source: string,
  code = "loom.vanilla-op-call-position",
): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === code)
    .map((d) => d.message);
}

/** A Catalog context whose Item aggregate calls a sibling op `reserve` from a
 *  `summarize` op in the given body position, hosted on `platform`. */
function sys(platform: string, body: string): string {
  return `
system S {
  subdomain D {
    context C {
      aggregate A ids guid {
        code: string
        operation reserve(): string { return code }
        operation summarize(): string {
${body}
        }
      }
      repository As for A { }
    }
  }
  api X from D
  storage pg { type: postgres }
  resource r { for: C, kind: state, use: pg }
  deployable d { platform: ${platform}  contexts: [C]  dataSources: [r]  serves: X  port: 4000 }
}`;
}

describe("loom.vanilla-op-call-position", () => {
  it("allows an op self-call in `return` tail position", async () => {
    expect(await positionErrors(sys("elixir", "          return reserve()"))).toEqual([]);
  });

  it("rejects an op self-call bound with `let`", async () => {
    const errs = await positionErrors(
      sys("elixir", "          let x = reserve()\n          return x"),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("summarize");
    expect(errs[0]).toContain("reserve");
    expect(errs[0]).toContain("return");
  });

  it("rejects an op self-call nested in a larger expression", async () => {
    const errs = await positionErrors(sys("elixir", '          return reserve() + "!"'));
    expect(errs).toHaveLength(1);
  });

  it("does not fire on node / python (operations are value-returning methods there)", async () => {
    expect(
      await positionErrors(sys("node", "          let x = reserve()\n          return x")),
    ).toEqual([]);
    expect(
      await positionErrors(sys("python", "          let x = reserve()\n          return x")),
    ).toEqual([]);
  });
});
