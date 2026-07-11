import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { AggregateIR } from "../../src/ir/types/loom-ir.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// Lifecycle operations — Phase 1 (grammar + IR + validator).
// `create` / `destroy` keywords parse as aggregate members, lower to
// `OperationIR` with a `kind` tag into the new `creates` / `destroys`
// arrays (mutate-kind `operation` stays in `operations`), and the
// name-uniqueness + `this.id`-in-create validator rules fire.
// See docs/proposals/lifecycle-operations.md.
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem);
const parse = parseHelper<Model>(services.Ddd);

interface Diag {
  severity: number;
  message: string;
  code?: string | number;
}

async function parseModel(src: string): Promise<{
  model: Model;
  errors: Diag[];
  codes: (string | number | undefined)[];
  parserErrors: string[];
}> {
  const doc = await parse(src, { validation: true });
  const diags = (doc.diagnostics ?? []).map((d) => ({
    severity: d.severity ?? 0,
    message: d.message,
    code: d.code,
  }));
  return {
    model: doc.parseResult.value,
    errors: diags.filter((d) => d.severity === 1),
    codes: diags.map((d) => d.code),
    parserErrors: doc.parseResult.parserErrors.map((e) => e.message),
  };
}

function aggregateFrom(model: Model, name: string): AggregateIR {
  const raw = lowerModel(model);
  for (const ctx of raw.contexts) {
    const agg = ctx.aggregates.find((a) => a.name === name);
    if (agg) return agg;
  }
  for (const sys of raw.systems) {
    for (const sub of sys.subdomains) {
      for (const ctx of sub.contexts) {
        const agg = ctx.aggregates.find((a) => a.name === name);
        if (agg) return agg;
      }
    }
  }
  throw new Error(`Aggregate ${name} not found`);
}

const WRAP = (members: string) => `
  context C {
    aggregate Order {
      subject: string
      amount:  int
      status:  string
${members}
    }
  }
`;

describe("lifecycle operations — parsing + lowering", () => {
  it("lowers a legacy `operation` to kind 'mutate' and leaves creates/destroys empty", async () => {
    const { model, errors } = await parseModel(
      WRAP(`      operation cancel() { status := "cancelled" }`),
    );
    expect(errors).toEqual([]);
    const agg = aggregateFrom(model, "Order");
    expect(agg.operations.map((o) => o.name)).toEqual(["cancel"]);
    expect(agg.operations[0].kind ?? "mutate").toBe("mutate");
    expect(agg.creates).toEqual([]);
    expect(agg.destroys).toEqual([]);
    expect(agg.canonicalCreate).toBeNull();
    expect(agg.canonicalDestroy).toBeNull();
  });

  it("lowers a named `create` into creates[] (not operations[]) with kind 'create'", async () => {
    const { model, errors } = await parseModel(
      WRAP(`      create place(s: string, a: int) {
        subject := s
        amount := a
        status := "pending"
      }`),
    );
    expect(errors).toEqual([]);
    const agg = aggregateFrom(model, "Order");
    expect(agg.operations).toEqual([]); // mutate-only — create is parked elsewhere
    expect(agg.creates).toHaveLength(1);
    const create = agg.creates![0];
    expect(create.kind).toBe("create");
    expect(create.name).toBe("place");
    expect(create.canonical).toBe(false);
    expect(create.params.map((p) => p.name)).toEqual(["s", "a"]);
    expect(agg.canonicalCreate).toBeNull();
  });

  it("treats an unnamed `create(...)` as the canonical creator (name = keyword)", async () => {
    const { model, errors } = await parseModel(WRAP(`      create(s: string) { subject := s }`));
    expect(errors).toEqual([]);
    const agg = aggregateFrom(model, "Order");
    expect(agg.creates).toHaveLength(1);
    expect(agg.creates![0].canonical).toBe(true);
    expect(agg.creates![0].name).toBe("create");
    expect(agg.canonicalCreate).toBe(agg.creates![0]);
  });

  it("parses canonical `destroy { }` (no name, no parens) as the canonical terminator", async () => {
    const { model, errors } = await parseModel(WRAP(`      destroy { }`));
    expect(errors).toEqual([]);
    const agg = aggregateFrom(model, "Order");
    expect(agg.destroys).toHaveLength(1);
    expect(agg.destroys![0].kind).toBe("destroy");
    expect(agg.destroys![0].canonical).toBe(true);
    expect(agg.destroys![0].name).toBe("destroy");
    expect(agg.destroys![0].params).toEqual([]);
    expect(agg.canonicalDestroy).toBe(agg.destroys![0]);
  });

  it("parses a named `destroy archive()` with a soft-delete body", async () => {
    const { model, errors } = await parseModel(
      WRAP(`      destroy archive() { status := "archived" }`),
    );
    expect(errors).toEqual([]);
    const agg = aggregateFrom(model, "Order");
    expect(agg.destroys!.map((d) => d.name)).toEqual(["archive"]);
    expect(agg.destroys![0].canonical).toBe(false);
    expect(agg.canonicalDestroy).toBeNull();
  });

  it("supports multiple named creates with distinct shapes side by side", async () => {
    const { model, errors } = await parseModel(
      WRAP(`      create place(s: string) { subject := s }
      create register(s: string, a: int) {
        subject := s
        amount := a
      }`),
    );
    expect(errors).toEqual([]);
    const agg = aggregateFrom(model, "Order");
    expect(agg.creates!.map((c) => c.name)).toEqual(["place", "register"]);
  });

  it("admits `create`/`destroy` as member names after `.` (no keyword collision)", async () => {
    // The e2e + page surfaces use `<recv>.create(...)` / `<recv>.destroy()`
    // as member calls; making create/destroy keywords must not break
    // member-access parsing.  Assert no *parser* errors (validation of the
    // unresolved receiver is irrelevant to the keyword-collision question).
    const { parserErrors } = await parseModel(
      WRAP(`      operation touch() {
        let a = self.create({ subject: "x" })
        let b = self.destroy()
      }`),
    );
    expect(parserErrors).toEqual([]);
  });
});

describe("lifecycle operations — validation", () => {
  it("flags two creates sharing a name (loom.create-name-conflict)", async () => {
    const { codes } = await parseModel(
      WRAP(`      create place(s: string) { subject := s }
      create place(a: int) { amount := a }`),
    );
    expect(codes).toContain("loom.create-name-conflict");
  });

  it("flags more than one canonical create (loom.canonical-create-conflict)", async () => {
    const { codes } = await parseModel(
      WRAP(`      create(s: string) { subject := s }
      create(a: int) { amount := a }`),
    );
    expect(codes).toContain("loom.canonical-create-conflict");
  });

  it("flags two destroys sharing a name (loom.destroy-name-conflict)", async () => {
    const { codes } = await parseModel(
      WRAP(`      destroy archive() { status := "a" }
      destroy archive() { status := "b" }`),
    );
    expect(codes).toContain("loom.destroy-name-conflict");
  });

  it("flags more than one canonical destroy (loom.canonical-destroy-conflict)", async () => {
    const { codes } = await parseModel(
      WRAP(`      destroy { }
      destroy { }`),
    );
    expect(codes).toContain("loom.canonical-destroy-conflict");
  });

  it("allows a create and a destroy to share a name (independent kinds)", async () => {
    const { errors } = await parseModel(
      WRAP(`      create archive(s: string) { subject := s }
      destroy archive() { status := "archived" }`),
    );
    expect(errors).toEqual([]);
  });

  it("rejects reading `this.id` inside a create body (loom.this-id-in-create)", async () => {
    const { codes } = await parseModel(
      WRAP(`      create place(s: string) {
        let echo = this.id
        subject := s
      }`),
    );
    expect(codes).toContain("loom.this-id-in-create");
  });

  it("allows reading `this.id` inside a destroy body (id is assigned by then)", async () => {
    const { errors, codes } = await parseModel(
      WRAP(`      destroy archive() {
        let echo = this.id
        status := "archived"
      }`),
    );
    expect(errors).toEqual([]);
    expect(codes).not.toContain("loom.this-id-in-create");
  });
});
