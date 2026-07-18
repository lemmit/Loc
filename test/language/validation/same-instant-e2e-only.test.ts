import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// `toBeSameInstant` is temporal WIRE-format equality — a concept that only
// exists once a value has crossed the HTTP boundary.  In a domain (in-memory)
// test there is nothing to forgive, so `checkExpectMatcher` restricts it to
// `test e2e` bodies, mirroring the `toThrow(<status>)` e2e-only rule.
// ---------------------------------------------------------------------------

const UNIT_MISUSE = `
  system S {
    subdomain D {
      context C {
        aggregate Entry {
          at: datetime
          test "misuse in a unit test" {
            let e = Entry.create({ at: "2024-01-01T00:00:00Z" })
            expect(e.at).toBeSameInstant("2024-01-01T00:00:00Z")
          }
        }
        repository Entries for Entry { }
      }
    }
  }
`;

const E2E_OK = `
  system S {
    subdomain D {
      context C {
        aggregate Entry with crudish {
          at: datetime
        }
        repository Entries for Entry { }
      }
    }
    deployable api { platform: node, contexts: [C], port: 3000 }

    test e2e "instant round-trips" against api {
      let e = api.entries.create({ at: "2024-01-01T00:00:00Z" })
      let read = api.entries.getById(e)
      expect(read.at).toBeSameInstant("2024-01-01T00:00:00Z")
    }
  }
`;

describe("toBeSameInstant — e2e-only", () => {
  it("is rejected in a domain (unit) test body", async () => {
    const { errors } = await parseString(UNIT_MISUSE);
    expect(errors.some((e) => e.includes("toBeSameInstant"))).toBe(true);
  });

  it("is accepted in a test e2e body", async () => {
    const { errors } = await parseString(E2E_OK);
    expect(errors.some((e) => e.includes("toBeSameInstant"))).toBe(false);
  });
});
