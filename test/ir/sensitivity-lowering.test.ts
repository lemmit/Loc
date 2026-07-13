// Phase 1 IR side — `lowerField` captures `sensitive(<tag>, ...)` from
// the AST into `FieldIR.sensitivity` (normalised: sorted, deduped) and
// mirrors the same tag set onto the field's `TypeIR.sensitivity`.
// See `docs/old/proposals/sensitivity-and-compliance.md`.

import { describe, expect, it } from "vitest";
import { allAggregates } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../_helpers/index.js";

const SRC = `
  context Hospital {
    enum PatientStatus { Active, Discharged }
    aggregate Patient {
      name:      string
      email:     string sensitive(pii)
      diagnosis: string sensitive(phi)
      cardNo:    string sensitive(pii, cred)
      status:    PatientStatus
    }
    repository Patients for Patient { }
  }
`;

describe("lowering — sensitivity capture on FieldIR", () => {
  it("non-sensitive fields have no `sensitivity` property", async () => {
    const loom = await buildLoomModel(SRC);
    const patient = allAggregates(loom).find((a) => a.name === "Patient")!;
    const name = patient.fields.find((f) => f.name === "name")!;
    expect(name.sensitivity).toBeUndefined();
    expect(name.type.sensitivity).toBeUndefined();
  });

  it("single-tag field carries the tag on both FieldIR and TypeIR", async () => {
    const loom = await buildLoomModel(SRC);
    const patient = allAggregates(loom).find((a) => a.name === "Patient")!;
    const email = patient.fields.find((f) => f.name === "email")!;
    expect(email.sensitivity).toEqual(["pii"]);
    expect(email.type.sensitivity).toEqual(["pii"]);
  });

  it("multi-tag field is normalised (sorted, deduplicated)", async () => {
    const loom = await buildLoomModel(SRC);
    const patient = allAggregates(loom).find((a) => a.name === "Patient")!;
    const cardNo = patient.fields.find((f) => f.name === "cardNo")!;
    expect(cardNo.sensitivity).toEqual(["cred", "pii"]);
    expect(cardNo.type.sensitivity).toEqual(["cred", "pii"]);
  });

  it("each declared tag is preserved exactly once", async () => {
    const loom = await buildLoomModel(SRC);
    const patient = allAggregates(loom).find((a) => a.name === "Patient")!;
    const diagnosis = patient.fields.find((f) => f.name === "diagnosis")!;
    expect(diagnosis.sensitivity).toEqual(["phi"]);
  });
});
