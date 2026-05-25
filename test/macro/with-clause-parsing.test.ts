import { describe, expect, it } from "vitest";
import { parseRawOk, parseString } from "../_helpers/parse.js";

const wrap = (body: string) => `system Demo { ${body} }`;

// Grammar-level smoke tests for the `with` clause.  Validation
// errors (unknown macro etc.) are covered in `expansion.test.ts`.

describe("with-clause grammar", () => {
  it("parses `with auditable` on an aggregate", () => {
    expect(
      parseRawOk(
        wrap(`
          module M {
            context C {
              aggregate Order with auditable {
                subject: string
              }
            }
          }
        `),
      ),
    ).toBe(true);
  });

  it("parses multiple comma-separated macros", () => {
    expect(
      parseRawOk(
        wrap(`
          module M {
            context C {
              aggregate Order with auditable, softDeletable {
                subject: string
              }
            }
          }
        `),
      ),
    ).toBe(true);
  });

  it("parses named args of various kinds", () => {
    expect(
      parseRawOk(
        wrap(`
          module M {
            context C {
              aggregate Order with softDeletable(field: "archivedAt", timestamp: "archivedOn") {
                subject: string
              }
            }
          }
        `),
      ),
    ).toBe(true);
  });

  it("parses `with` on a ui block", () => {
    expect(
      parseRawOk(
        wrap(`
          ui App with someMacro {
            page Home { route: "/" body: List { of: x } }
          }
        `),
      ),
    ).toBe(true);
  });

  it("parses an empty arg list", () => {
    expect(
      parseRawOk(
        wrap(`
          module M {
            context C {
              aggregate Order with auditable() {
                subject: string
              }
            }
          }
        `),
      ),
    ).toBe(true);
  });
});

describe("with-clause is optional", () => {
  it("aggregates without `with` still parse cleanly", async () => {
    const { errors } = await parseString(
      wrap(`
        module M {
          context C {
            aggregate Order {
              subject: string
            }
          }
        }
      `),
    );
    expect(errors).toEqual([]);
  });
});
