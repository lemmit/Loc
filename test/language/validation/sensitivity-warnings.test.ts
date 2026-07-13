// Phase 2-lite: implicit conversion of sensitive values is permitted at
// the type level (so existing code keeps working), but the validator
// emits a warning at each flow boundary where sensitivity tags are
// dropped.  See `docs/old/proposals/sensitivity-and-compliance.md`.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/index.js";

const parse = (source: string) => parseString(source);

const droppedRe = /Implicit conversion drops sensitivity tag\(s\)/;

describe("sensitivity narrowing warnings", () => {
  it("warns when assigning a sensitive value into a non-sensitive field", async () => {
    const { errors, warnings } = await parse(`
      context T {
        aggregate Patient {
          name:  string
          email: string sensitive(pii)
          operation rename() {
            name := email
          }
        }
        repository Patients for Patient { }
      }
    `);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => droppedRe.test(w) && /pii/.test(w))).toBe(true);
  });

  it("warns on derived property whose expression introduces tags the declared type lacks", async () => {
    const { errors, warnings } = await parse(`
      context T {
        aggregate Patient {
          name:  string
          email: string sensitive(pii)
          derived label: string = email
        }
        repository Patients for Patient { }
      }
    `);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => droppedRe.test(w) && /pii/.test(w))).toBe(true);
  });

  it("warns on a function whose body introduces tags the return type lacks", async () => {
    const { errors, warnings } = await parse(`
      context T {
        aggregate Patient {
          name:  string
          email: string sensitive(pii)
          function nickname(): string = "Mr. " + email
        }
        repository Patients for Patient { }
      }
    `);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => droppedRe.test(w) && /pii/.test(w))).toBe(true);
  });

  it("warns when emitting an event field with a sensitive value into a non-sensitive field", async () => {
    const { errors, warnings } = await parse(`
      context T {
        event PatientRenamed { patientId: Patient id, newName: string }
        aggregate Patient {
          name:  string
          email: string sensitive(pii)
          operation publish() {
            emit PatientRenamed {
              patientId: id,
              newName:   email
            }
          }
        }
        repository Patients for Patient { }
      }
    `);
    expect(errors).toEqual([]);
    // The warning describes the type flow (string!{pii} → string).  The
    // affected event field is pinned via the diagnostic's location
    // (`property: "value"`), not interpolated into the message body.
    expect(warnings.some((w) => droppedRe.test(w) && /pii/.test(w))).toBe(true);
  });

  it("does NOT warn when the target carries the same tag (no narrowing)", async () => {
    const { errors, warnings } = await parse(`
      context T {
        aggregate Patient {
          email:    string sensitive(pii)
          contact:  string sensitive(pii)
          operation copy() {
            contact := email
          }
        }
        repository Patients for Patient { }
      }
    `);
    expect(errors).toEqual([]);
    expect(warnings.filter((w) => droppedRe.test(w))).toEqual([]);
  });

  it("does NOT warn when a clean value flows into a sensitive field (broadening)", async () => {
    const { errors, warnings } = await parse(`
      context T {
        aggregate Patient {
          name:    string
          contact: string sensitive(pii)
          operation prime() {
            contact := name
          }
        }
        repository Patients for Patient { }
      }
    `);
    expect(errors).toEqual([]);
    expect(warnings.filter((w) => droppedRe.test(w))).toEqual([]);
  });

  it("includes the dropped tag name and both types in the warning text", async () => {
    const { warnings } = await parse(`
      context T {
        aggregate Patient {
          name:  string
          email: string sensitive(pii)
          operation rename() {
            name := email
          }
        }
        repository Patients for Patient { }
      }
    `);
    const w = warnings.find((m) => droppedRe.test(m))!;
    expect(w).toBeDefined();
    // The dropped tag, the source type, and the target type all appear
    // in the diagnostic so reviewers see the leak shape at a glance.
    expect(w).toMatch(/pii/);
    expect(w).toMatch(/string!\{pii\}/);
    expect(w).toMatch(/'string'/);
  });
});
