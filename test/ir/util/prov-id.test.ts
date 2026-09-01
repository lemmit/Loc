import { describe, expect, it } from "vitest";
import type { StmtIR, SystemIR } from "../../../src/ir/types/loom-ir.js";
import {
  contextsHaveProvenancedField,
  hasAnyProvSite,
  opHasProvSite,
  snapshotIdFor,
  stmtHasProv,
} from "../../../src/ir/util/prov-id.js";

// Provenance identity + presence.  M-T9.17 slice 4: no test calls any of these.
//
// Two things live here, and the module's own header insists they are NOT the
// same question:
//
//   • `stmtHasProv` / `opHasProvSite` / `hasAnyProvSite` — is there an
//     instrumented WRITE-SITE?  Drives the per-write machinery (trace buffer,
//     history flush, snapshot capture, the `.loomsnap.json` artefact).
//   • `contextsHaveProvenancedField` — does any aggregate DECLARE a
//     `provenanced` field?  Drives the persistence machinery (lineage types,
//     `<field>_provenance` columns, repo projections, the wire DTO), which
//     follows the field's existence whether or not it is ever written.
//
// A declared-but-never-written field is exactly where the two must disagree,
// and it is the shape a single merged predicate would get wrong: fold them into
// one and you either emit a lineage column with no writer, or a writer with no
// column.  That case gets its own test below.
//
// `snapshotIdFor` is the identity half: a rule that changes gets a new id, an
// unchanged rule keeps its id ACROSS BUILDS — which is what makes a snapshot
// diff mean "the rule changed" rather than "the compiler ran again".

const provSite = (over: Record<string, unknown> = {}) =>
  ({ file: "a.ddd", line: 1, snapshotId: "deadbeef", ...over }) as never;

const stmt = (kind: string, prov?: unknown): StmtIR =>
  ({ kind, target: "status", prov }) as unknown as StmtIR;

describe("snapshotIdFor — a stable, commit-independent content address", () => {
  const base = { type: "Order", field: "status", exprText: 'this.qty > 0 ? "open" : "closed"' };

  it("is 8 lowercase hex characters", () => {
    expect(snapshotIdFor(base)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is DETERMINISTIC — the same rule hashes the same across calls", () => {
    // The property the whole scheme rests on: an unchanged rule must keep its
    // id across builds, or every rebuild looks like a rule change in the
    // snapshot diff.
    expect(snapshotIdFor(base)).toBe(snapshotIdFor({ ...base }));
  });

  it("changes when the EXPRESSION changes", () => {
    expect(snapshotIdFor({ ...base, exprText: '"open"' })).not.toBe(snapshotIdFor(base));
  });

  it("changes when the FIELD changes, same type and expression", () => {
    // Each of the three inputs asserted alone: a key built from only the
    // expression would give two different write-sites one id, and the second
    // capture would silently overwrite the first.
    expect(snapshotIdFor({ ...base, field: "state" })).not.toBe(snapshotIdFor(base));
  });

  it("changes when the TYPE changes, same field and expression", () => {
    expect(snapshotIdFor({ ...base, type: "Invoice" })).not.toBe(snapshotIdFor(base));
  });

  it("does not collide across the `.`/`::` key boundaries", () => {
    // The key is `${type}.${field}::${exprText}`.  These pairs are chosen so
    // they CONCATENATE identically — `"A"+"b"+"c"` === `"Ab"+"c"+""` — and are
    // separated only by the delimiters.  Drop the `.`/`::` from the key and
    // both pairs collide, silently merging two distinct write-sites into one
    // snapshot; keep them and each pair differs.
    //
    // (The first version of this test picked pairs that differed under BOTH
    // spellings, so it passed with the delimiters removed. It proved nothing
    // until the mutation caught it.)
    const ref = snapshotIdFor({ type: "A", field: "b", exprText: "c" });
    expect(ref).not.toBe(snapshotIdFor({ type: "Ab", field: "c", exprText: "" }));
    expect(ref).not.toBe(snapshotIdFor({ type: "A", field: "bc", exprText: "" }));
    expect(ref).not.toBe(snapshotIdFor({ type: "", field: "Ab", exprText: "c" }));
  });

  it("hashes an empty key without throwing, still 8 hex", () => {
    expect(snapshotIdFor({ type: "", field: "", exprText: "" })).toMatch(/^[0-9a-f]{8}$/);
  });

  it("pads a short hash to the full width", () => {
    // `toString(16).padStart(8, "0")` — an unpadded id would sort and compare
    // differently from its siblings and break a fixed-width artefact key.
    for (const t of ["a", "b", "c", "d", "e", "f", "g", "h", "zzz", "Order"]) {
      expect(snapshotIdFor({ type: t, field: "f", exprText: "x" }), t).toHaveLength(8);
    }
  });
});

describe("stmtHasProv — a write-site is one of THREE statement kinds", () => {
  it("is true for an instrumented `assign`", () => {
    expect(stmtHasProv(stmt("assign", provSite()))).toBe(true);
  });

  it("is true for an instrumented `add` — the arm a scalar-only copy would drop", () => {
    expect(stmtHasProv(stmt("add", provSite()))).toBe(true);
  });

  it("is true for an instrumented `remove`", () => {
    // Each kind asserted alone: `add`/`remove` are collection mutations, and a
    // predicate that only matched `assign` would leave every collection write
    // un-traced while the aggregate still emitted the machinery.
    expect(stmtHasProv(stmt("remove", provSite()))).toBe(true);
  });

  it("is FALSE for the same kinds with no provenance attached", () => {
    for (const k of ["assign", "add", "remove"]) {
      expect(stmtHasProv(stmt(k, undefined)), k).toBe(false);
    }
  });

  it("is FALSE for a non-write statement, even carrying a `prov` field", () => {
    // Both halves of the conjunction matter: the kind gate AND the presence
    // gate.  A `let` with a stray `prov` is not a write-site.
    expect(stmtHasProv(stmt("let", provSite()))).toBe(false);
    expect(stmtHasProv(stmt("return", provSite()))).toBe(false);
  });
});

describe("opHasProvSite / hasAnyProvSite — the presence roll-ups", () => {
  it("opHasProvSite is a `some`, not an `every`", () => {
    const op = { statements: [stmt("assign"), stmt("let"), stmt("add", provSite())] };
    expect(opHasProvSite(op)).toBe(true);
  });

  it("opHasProvSite is false for an empty body and an uninstrumented one", () => {
    expect(opHasProvSite({ statements: [] })).toBe(false);
    expect(opHasProvSite({ statements: [stmt("assign"), stmt("remove")] })).toBe(false);
  });

  const sys = (statements: StmtIR[]): SystemIR =>
    ({
      subdomains: [{ contexts: [{ aggregates: [{ operations: [{ statements }] }] }] }],
    }) as unknown as SystemIR;

  it("hasAnyProvSite reaches through subdomain → context → aggregate → operation", () => {
    // Four nested loops; a roll-up that stopped one level short would report
    // "no provenance" for a whole system and skip the runtime SDK entirely.
    expect(hasAnyProvSite(sys([stmt("assign", provSite())]))).toBe(true);
  });

  it("hasAnyProvSite is false for a system with no instrumented write", () => {
    expect(hasAnyProvSite(sys([stmt("assign")]))).toBe(false);
    expect(hasAnyProvSite({ subdomains: [] } as unknown as SystemIR)).toBe(false);
  });

  it("hasAnyProvSite finds a site in a LATER subdomain, not just the first", () => {
    const many = {
      subdomains: [
        { contexts: [{ aggregates: [{ operations: [{ statements: [stmt("assign")] }] }] }] },
        {
          contexts: [{ aggregates: [{ operations: [{ statements: [stmt("add", provSite())] }] }] }],
        },
      ],
    } as unknown as SystemIR;
    expect(hasAnyProvSite(many)).toBe(true);
  });
});

describe("contextsHaveProvenancedField — the OTHER question", () => {
  const ctx = (aggregates: unknown[]) => ({ aggregates }) as never;
  const agg = (fields: { provenanced?: boolean }[], parts: unknown[] = []) => ({ fields, parts });

  it("is false when nothing is declared provenanced", () => {
    expect(contextsHaveProvenancedField([ctx([agg([{}, {}])])])).toBe(false);
    expect(contextsHaveProvenancedField([])).toBe(false);
  });

  it("is true on a ROOT aggregate field", () => {
    expect(contextsHaveProvenancedField([ctx([agg([{ provenanced: true }])])])).toBe(true);
  });

  it("is true on an ENTITY PART field — the arm a root-only scan would drop", () => {
    // A part's `<field>_provenance` column lives on the part's own table, so
    // missing this arm emits a lineage type with nowhere to store it.  Asserted
    // with the root fields explicitly NOT provenanced, so it cannot pass on the
    // strength of the first arm.
    expect(
      contextsHaveProvenancedField([ctx([agg([{}], [{ fields: [{ provenanced: true }] }])])]),
    ).toBe(true);
  });

  it("scans every context and every aggregate, not just the first", () => {
    expect(
      contextsHaveProvenancedField([
        ctx([agg([{}])]),
        ctx([agg([{}]), agg([{ provenanced: true }])]),
      ]),
    ).toBe(true);
  });

  it("DISAGREES with the write-site predicates for a declared-but-never-written field", () => {
    // The distinction the module header draws, made observable.  The field
    // exists, so the persistence machinery must be emitted; no statement writes
    // it, so the per-write instrumentation must not be.  A single merged
    // predicate gets one of the two wrong.
    const declaredOnly = [ctx([agg([{ provenanced: true }])])];
    expect(contextsHaveProvenancedField(declaredOnly)).toBe(true);
    expect(hasAnyProvSite(sysWith([stmt("assign")]))).toBe(false);
  });

  it("and the converse: an instrumented write with no declared field", () => {
    expect(contextsHaveProvenancedField([ctx([agg([{}])])])).toBe(false);
    expect(hasAnyProvSite(sysWith([stmt("assign", provSite())]))).toBe(true);
  });
});

function sysWith(statements: StmtIR[]): SystemIR {
  return {
    subdomains: [{ contexts: [{ aggregates: [{ operations: [{ statements }] }] }] }],
  } as unknown as SystemIR;
}
