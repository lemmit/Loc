// `loom.shape-on-event-sourced` — `shape: document` / `shape: embedded` on a
// `persistedAs: eventLog` aggregate is INERT, so it may not be spelled.
//
// Every backend's schema emitter short-circuits on `persistedAs === "eventLog"`
// BEFORE it reads `effectiveSavingShape(...)` (the Hono one at
// `src/generator/typescript/emit/schema.ts`), so the knob is read nowhere: the
// same source with and without `shape: document` produced byte-identical
// generated output, and `ddd parse --json` reported `errors: 0, warnings: 0`.
//
// Snapshot rehydration in a document/embedded shape is a deferred feature
// (docs/new-plan/T2-data-evolution.md) — but a deferral that ACCEPTS the syntax
// and silently persists the OTHER shape is a silent gap, which is exactly what
// the sibling `loom.unique-on-event-sourced` gate already refuses.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const wrap = (agg: string) => `
  system Bank {
    subdomain Ledger {
      context Accounts {
        event Opened { account: Account id, owner: string }
        ${agg}
        repository Accounts for Account { }
      }
    }
  }
`;

const esBody = `
          owner: string
          create open(owner: string) { emit Opened { account: id, owner: owner } }
          apply(e: Opened) { owner := e.owner }`;

const CODE = "loom.shape-on-event-sourced";

async function codes(agg: string): Promise<string[]> {
  const { diagnostics } = await parseString(wrap(agg), { validate: true });
  return diagnostics.map((d) => d.code).filter((c): c is string => c !== undefined);
}

describe("shape: on an event-sourced aggregate", () => {
  it("rejects `shape: document` on `persistedAs: eventLog`", async () => {
    expect(
      await codes(`aggregate Account persistedAs: eventLog shape: document {${esBody}
        }`),
    ).toContain(CODE);
  });

  it("rejects `shape: embedded` on `persistedAs: eventLog`", async () => {
    expect(
      await codes(`aggregate Account persistedAs: eventLog shape: embedded {${esBody}
        }`),
    ).toContain(CODE);
  });

  it("names the shape and the aggregate", async () => {
    const { diagnostics } = await parseString(
      wrap(`aggregate Account persistedAs: eventLog shape: document {${esBody}
        }`),
      { validate: true },
    );
    const d = diagnostics.find((x) => x.code === CODE)!;
    expect(d).toBeDefined();
    expect(d.message).toContain("shape: document");
    expect(d.message).toContain("'Account'");
  });

  // POSITIVE CONTROLS — the gate must not widen into the two shapes that DO
  // mean something: an event-sourced aggregate with no `shape:` at all, and a
  // document-shaped aggregate that is not event-sourced.
  it("is CLEAN for `persistedAs: eventLog` with no `shape:`", async () => {
    expect(
      await codes(`aggregate Account persistedAs: eventLog {${esBody}
        }`),
    ).not.toContain(CODE);
  });

  it("is CLEAN for `shape: document` on a state-persisted aggregate", async () => {
    expect(await codes(`aggregate Account shape: document { owner: string }`)).not.toContain(CODE);
  });
});
