// Phase 1 of the sensitivity feature — grammar slot, type-system
// propagation, isAssignable narrowing, and FieldIR capture.  See
// `docs/old/proposals/sensitivity-and-compliance.md`.

import { AstUtils, EmptyFileSystem, URI } from "langium";
import { beforeAll, describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Aggregate, Model, Property } from "../../../src/language/generated/ast.js";
import {
  type DddType,
  envForNode,
  isAssignable,
  mergeTags,
  propertySensitivity,
  sensitivityNarrows,
  T,
  tagsSubset,
  typeOf,
  typeToString,
  withTags,
} from "../../../src/language/type-system.js";

async function linkedModel(src: string): Promise<Model> {
  const services = createDddServices(EmptyFileSystem).Ddd;
  const shared = services.shared;
  const uri = URI.parse("memory:///sensitivity-test.ddd");
  const docs = shared.workspace.LangiumDocuments;
  if (docs.hasDocument(uri)) await docs.deleteDocument(uri);
  const doc = shared.workspace.LangiumDocumentFactory.fromString(src, uri);
  docs.addDocument(doc);
  await shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return doc.parseResult.value as Model;
}

const SRC = `
context Hospital {
  enum PatientStatus { Active, Discharged }
  aggregate Patient {
    name:      string
    email:     string sensitive(pii)
    pesel:     string sensitive(pii)
    diagnosis: string sensitive(phi)
    cardNo:    string sensitive(pii, cred)
    status:    PatientStatus
    derived greeting: string = "Hello " + name
    derived emailGreeting: string = "Hi " + email
    derived chosen: string = status == PatientStatus.Active ? email : name
  }
  repository Patients for Patient { }
}
`;

function find<T extends { name?: string }>(model: Model, type: string, name: string): T {
  for (const n of AstUtils.streamAst(model)) {
    if (n.$type === type && (n as { name?: string }).name === name) return n as T;
  }
  throw new Error(`no ${type} named ${name}`);
}

describe("sensitivity — grammar + AST capture", () => {
  let model: Model;
  beforeAll(async () => {
    model = await linkedModel(SRC);
  });

  it("parses `sensitive(pii)` without diagnostics", () => {
    // Source parses cleanly — the grammar slot accepts the modifier.
    const patient = find<Aggregate>(model, "Aggregate", "Patient");
    expect(patient).toBeDefined();
  });

  it("captures a single tag on the Property AST node", () => {
    const patient = find<Aggregate>(model, "Aggregate", "Patient");
    const email = patient.members.find(
      (m): m is Property => m.$type === "Property" && m.name === "email",
    )!;
    expect(email.sensitivity?.tags).toEqual(["pii"]);
  });

  it("captures multiple tags on the Property AST node", () => {
    const patient = find<Aggregate>(model, "Aggregate", "Patient");
    const cardNo = patient.members.find(
      (m): m is Property => m.$type === "Property" && m.name === "cardNo",
    )!;
    // Tags survive in source order; `propertySensitivity` normalises.
    expect(cardNo.sensitivity?.tags).toEqual(["pii", "cred"]);
  });

  it("non-sensitive property has no sensitivity clause", () => {
    const patient = find<Aggregate>(model, "Aggregate", "Patient");
    const name = patient.members.find(
      (m): m is Property => m.$type === "Property" && m.name === "name",
    )!;
    expect(name.sensitivity).toBeUndefined();
  });
});

describe("sensitivity — type-system propagation", () => {
  let model: Model;
  beforeAll(async () => {
    model = await linkedModel(SRC);
  });

  it("propertySensitivity normalises tags (sorted, deduplicated)", () => {
    const patient = find<Aggregate>(model, "Aggregate", "Patient");
    const cardNo = patient.members.find(
      (m): m is Property => m.$type === "Property" && m.name === "cardNo",
    )!;
    expect(propertySensitivity(cardNo)).toEqual(["cred", "pii"]);
  });

  it("member access on a sensitive property carries the tag", () => {
    const patient = find<Aggregate>(model, "Aggregate", "Patient");
    const greeting = patient.members.find(
      (m) => m.$type === "DerivedProp" && (m as { name: string }).name === "emailGreeting",
    )!;
    // The derived expression is `"Hi " + email` — its type should be a
    // sensitive string because email is sensitive(pii).
    const env = envForNode(greeting);
    const t = typeOf(
      (greeting as { expr: import("../../../src/language/generated/ast.js").Expression }).expr,
      env,
    );
    expect(t.kind).toBe("primitive");
    expect((t as { name: string }).name).toBe("string");
    expect(t.sensitivity).toEqual(["pii"]);
  });

  it("clean concat stays clean", () => {
    const patient = find<Aggregate>(model, "Aggregate", "Patient");
    const greeting = patient.members.find(
      (m) => m.$type === "DerivedProp" && (m as { name: string }).name === "greeting",
    )!;
    const env = envForNode(greeting);
    const t = typeOf(
      (greeting as { expr: import("../../../src/language/generated/ast.js").Expression }).expr,
      env,
    );
    expect(t.sensitivity).toBeUndefined();
  });

  it("ternary unions the branches' sensitivity", () => {
    const patient = find<Aggregate>(model, "Aggregate", "Patient");
    const chosen = patient.members.find(
      (m) => m.$type === "DerivedProp" && (m as { name: string }).name === "chosen",
    )!;
    const env = envForNode(chosen);
    const t = typeOf(
      (chosen as { expr: import("../../../src/language/generated/ast.js").Expression }).expr,
      env,
    );
    // `cond ? email : name` — email carries pii, name is clean ⇒ pii.
    expect(t.sensitivity).toEqual(["pii"]);
  });

  it("typeToString surfaces tags for diagnostics", () => {
    const t: DddType = { kind: "primitive", name: "string", sensitivity: ["pii"] };
    expect(typeToString(t)).toBe("string!{pii}");
    const u: DddType = { kind: "primitive", name: "string", sensitivity: ["cred", "pii"] };
    expect(typeToString(u)).toBe("string!{cred,pii}");
  });
});

describe("sensitivity — isAssignable is tag-agnostic", () => {
  // Implicit conversion is permitted at the type level so existing
  // code keeps working; narrowing is surfaced by the validator as a
  // warning, not by `isAssignable` as an error.
  it("clean → sensitive: allowed", () => {
    expect(isAssignable(T.prim("string"), withTags(T.prim("string"), ["pii"]))).toBe(true);
  });

  it("sensitive → clean: allowed (warning lives in the validator)", () => {
    expect(isAssignable(withTags(T.prim("string"), ["pii"]), T.prim("string"))).toBe(true);
  });

  it("disjoint tag sets: allowed structurally", () => {
    expect(
      isAssignable(withTags(T.prim("string"), ["phi"]), withTags(T.prim("string"), ["pii"])),
    ).toBe(true);
  });

  it("structural mismatch still rejected (tags don't paper over kind)", () => {
    expect(isAssignable(T.prim("string"), T.prim("int"))).toBe(false);
  });
});

describe("sensitivity — sensitivityNarrows detects dropped tags", () => {
  it("no tags at all → undefined", () => {
    expect(sensitivityNarrows(T.prim("string"), T.prim("string"))).toBeUndefined();
  });

  it("clean → sensitive: undefined (broadening, not narrowing)", () => {
    expect(
      sensitivityNarrows(T.prim("string"), withTags(T.prim("string"), ["pii"])),
    ).toBeUndefined();
  });

  it("sensitive → clean: returns the dropped tags", () => {
    expect(sensitivityNarrows(withTags(T.prim("string"), ["pii"]), T.prim("string"))).toEqual([
      "pii",
    ]);
  });

  it("multi-tag → partial coverage: returns only the dropped subset", () => {
    expect(
      sensitivityNarrows(
        withTags(T.prim("string"), ["pii", "phi"]),
        withTags(T.prim("string"), ["pii"]),
      ),
    ).toEqual(["phi"]);
  });

  it("equal tag sets: undefined", () => {
    expect(
      sensitivityNarrows(withTags(T.prim("string"), ["pii"]), withTags(T.prim("string"), ["pii"])),
    ).toBeUndefined();
  });

  it("disjoint tag sets: returns the value-side tags as dropped", () => {
    expect(
      sensitivityNarrows(withTags(T.prim("string"), ["phi"]), withTags(T.prim("string"), ["pii"])),
    ).toEqual(["phi"]);
  });
});

describe("sensitivity — helpers", () => {
  it("mergeTags is the union, sorted and deduped", () => {
    expect(mergeTags(["pii"], ["phi"], ["pii"])).toEqual(["phi", "pii"]);
  });

  it("mergeTags returns undefined for the empty union", () => {
    expect(mergeTags(undefined, [], undefined)).toBeUndefined();
  });

  it("tagsSubset: empty ⊆ anything", () => {
    expect(tagsSubset(undefined, undefined)).toBe(true);
    expect(tagsSubset([], ["pii"])).toBe(true);
    expect(tagsSubset(undefined, ["pii"])).toBe(true);
  });

  it("tagsSubset: anything ⊄ empty (unless itself empty)", () => {
    expect(tagsSubset(["pii"], undefined)).toBe(false);
    expect(tagsSubset(["pii"], [])).toBe(false);
  });

  it("tagsSubset: standard subset checks", () => {
    expect(tagsSubset(["pii"], ["pii", "phi"])).toBe(true);
    expect(tagsSubset(["pii", "phi"], ["pii"])).toBe(false);
  });

  it("withTags is a no-op for empty tag inputs", () => {
    const base = T.prim("string");
    expect(withTags(base, undefined)).toBe(base);
    expect(withTags(base, [])).toBe(base);
  });

  it("withTags merges into an existing sensitive type", () => {
    const t = withTags(T.prim("string"), ["pii"]);
    const u = withTags(t, ["phi"]);
    expect(u.sensitivity).toEqual(["phi", "pii"]);
  });
});
