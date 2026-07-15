// AST-level `unique (...)` validation (uniqueness-and-indexes.md §8).
// Fast editor feedback that needs no type resolution:
//   - unknown column                 → loom.unique-unknown-field
//   - duplicate column within a key  → loom.unique-duplicate-column
//   - a collection (`[]`) column     → loom.unique-collection-field
//   - event-sourced / non-relational → loom.unique-on-event-sourced
// The value-object-column rejection and tenant-scope warning need the merged
// IR and live in `test/ir/unique-checks.test.ts`.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const wrap = (agg: string) => `
  system Shop {
    subdomain Sales {
      context Ordering {
        ${agg}
        repository Customers for Customer { }
      }
    }
  }
`;

describe("unique (...) — AST validation", () => {
  it("flags an unknown column (loom.unique-unknown-field)", async () => {
    const { errors } = await parseString(
      wrap(`aggregate Customer { email: string  unique (emial) }`),
    );
    expect(errors.some((e) => /references unknown field 'emial'/.test(e))).toBe(true);
    // The known-field list is surfaced to help the fix.
    expect(errors.some((e) => /Known fields: email/.test(e))).toBe(true);
  });

  it("flags a duplicate column within one key (loom.unique-duplicate-column)", async () => {
    const { errors } = await parseString(
      wrap(`aggregate Customer { email: string  unique (email, email) }`),
    );
    expect(errors.some((e) => /lists column 'email' twice/.test(e))).toBe(true);
  });

  it("flags a collection column (loom.unique-collection-field)", async () => {
    const { errors } = await parseString(
      wrap(`aggregate Customer { tags: string[]  unique (tags) }`),
    );
    expect(errors.some((e) => /is a collection/.test(e))).toBe(true);
  });

  it("gates `unique` off an event-sourced aggregate (loom.unique-on-event-sourced)", async () => {
    const { errors } = await parseString(
      wrap(`aggregate Customer persistedAs: eventLog { email: string  unique (email) }`),
    );
    expect(errors.some((e) => /event-sourced aggregate 'Customer' is not supported/.test(e))).toBe(
      true,
    );
  });

  it("gates `unique` off a document-shaped aggregate (loom.unique-on-event-sourced)", async () => {
    const { errors } = await parseString(
      wrap(`aggregate Customer shape: document { email: string  unique (email) }`),
    );
    expect(
      errors.some((e) => /document-shaped aggregate 'Customer' is not supported/.test(e)),
    ).toBe(true);
  });

  it("accepts a well-formed single- and composite-column key", async () => {
    const { errors } = await parseString(
      wrap(
        `aggregate Customer { tenantId: string  email: string  unique (email)  unique (tenantId, email) }`,
      ),
    );
    expect(errors).toEqual([]);
  });
});
