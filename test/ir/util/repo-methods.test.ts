import { describe, expect, it } from "vitest";
import { isReadMethod, isWriteMethod } from "../../../src/ir/util/repo-methods.js";

// `isReadMethod`/`isWriteMethod` classify repository verbs and drive both the
// phase-⑤ repo-read matcher and the phase-⑦ `loom.domain-service-no-repo-write`
// gate.  A misclassification silently routes a call to the wrong CQRS side (or
// lets a write through the domain-service purity gate), and the shared
// predicate had no direct test — M-T9.17 slice 1.

const WRITE_VERBS = ["save", "insert", "update", "delete", "add", "remove", "commit"];
const READ_VERBS = ["getById", "find", "findAll", "findByEmail", "query", "count", "load"];

describe("repository verb classification", () => {
  it("treats the known persistence verbs as writes", () => {
    for (const verb of WRITE_VERBS) {
      expect(isWriteMethod(verb), `${verb} is a write`).toBe(true);
      expect(isReadMethod(verb), `${verb} is not a read`).toBe(false);
    }
  });

  it("treats every other named method as a read", () => {
    for (const verb of READ_VERBS) {
      expect(isReadMethod(verb), `${verb} is a read`).toBe(true);
      expect(isWriteMethod(verb), `${verb} is not a write`).toBe(false);
    }
  });

  it("is exactly complementary — never both, never neither", () => {
    for (const verb of [...WRITE_VERBS, ...READ_VERBS, "", "SAVE", "saveAll"]) {
      expect(isReadMethod(verb)).toBe(!isWriteMethod(verb));
    }
  });

  it("is case-sensitive — `Save`/`SAVE` are reads, not the `save` write verb", () => {
    // The verb set is matched exactly; a differently-cased name is a read.
    expect(isWriteMethod("Save")).toBe(false);
    expect(isReadMethod("Save")).toBe(true);
    expect(isWriteMethod("SAVE")).toBe(false);
  });

  it("does not treat write-verb prefixes/suffixes as writes", () => {
    // `saveAll`, `updated`, `deletion` are read-classified — only the exact
    // verb is a write.  (Guards against a naive substring check creeping in.)
    for (const near of ["saveAll", "updated", "deletion", "addable", "removeMany"]) {
      expect(isWriteMethod(near), `${near} is not the exact write verb`).toBe(false);
    }
  });
});
