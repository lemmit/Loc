// Tenancy surface — grammar slice 1a.1 of multi-tenancy Phase 1a
// (docs/plans/multi-tenancy-implementation.md), upgraded to real Langium
// cross-references in 1b.1.  Covers the `tenancy by user.<claim> of
// <Registry>` SystemMember (claim → the system's `user { … }` field,
// registry → an aggregate; both resolve via `.ref`), the `crossTenant`
// aggregate header flag (the `isAbstract` pattern — plain, `ids`, and
// with-clause combinations), and the soft-keyword escape hatches
// (`tenancy` / `crossTenant` stay legal as field / parameter /
// expression names).  The stance lint is slice 1a.3 — not asserted here.

import { describe, expect, it } from "vitest";
import type {
  Aggregate,
  BoundedContext,
  Subdomain,
  System,
  TenancyDecl,
} from "../../../src/language/generated/ast.js";
import { isAggregate, isTenancyDecl } from "../../../src/language/generated/ast.js";
import { printStructural } from "../../../src/language/print/index.js";
import { parseString } from "../../_helpers/parse.js";

function systemOf(model: import("../../../src/language/generated/ast.js").Model): System {
  const sys = model.members.find((m) => m.$type === "System") as System | undefined;
  if (!sys) throw new Error("no system in model");
  return sys;
}

function aggByName(sys: System, name: string): Aggregate {
  for (const m of sys.members) {
    const contexts: BoundedContext[] =
      m.$type === "Subdomain"
        ? (m as Subdomain).contexts
        : m.$type === "BoundedContext"
          ? [m as BoundedContext]
          : [];
    for (const ctx of contexts) {
      for (const cm of ctx.members) {
        if (isAggregate(cm) && cm.name === name) return cm;
      }
    }
  }
  throw new Error(`aggregate ${name} not found`);
}

describe("tenancy by — SystemMember grammar", () => {
  it("parses `tenancy by user.tenantId of Organization` to the AST shape", async () => {
    const { model, errors } = await parseString(`
      system Billder {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Organization
        subdomain Billing {
          context Accounts {
            aggregate Organization { name: string }
            repository Organizations for Organization { }
          }
        }
      }
    `);
    expect(errors).toEqual([]);
    const decl = systemOf(model).members.find(isTenancyDecl) as TenancyDecl | undefined;
    expect(decl).toBeDefined();
    expect(decl!.$type).toBe("TenancyDecl");
    // Both bindings are real cross-references (1b.1): the claim resolves to
    // the `user { … }` field node, the registry to the aggregate node — so
    // goto-definition / rename / find-refs work through the standard linker.
    expect(decl!.claim.$refText).toBe("tenantId");
    expect(decl!.claim.ref).toBeDefined();
    expect(decl!.claim.ref!.name).toBe("tenantId");
    expect(decl!.claim.ref!.$type).toBe("UserField");
    expect(decl!.registry.$refText).toBe("Organization");
    expect(decl!.registry.ref).toBeDefined();
    expect(decl!.registry.ref!.name).toBe("Organization");
    expect(isAggregate(decl!.registry.ref!)).toBe(true);
  });

  it("parses with a different claim name (`user.orgId`)", async () => {
    const { model, errors } = await parseString(`
      system D {
        user { id: guid  orgId: string }
        tenancy by user.orgId of Org
        subdomain M { context C {
          aggregate Org { name: string }
          repository Orgs for Org { }
        }}
      }
    `);
    expect(errors).toEqual([]);
    const decl = systemOf(model).members.find(isTenancyDecl) as TenancyDecl;
    expect(decl.claim.ref?.name).toBe("orgId");
    expect(decl.registry.ref?.name).toBe("Org");
  });
});

describe("crossTenant — aggregate header flag grammar", () => {
  it("parses on a plain aggregate header (`aggregate Plan crossTenant { … }`)", async () => {
    const { model, errors } = await parseString(`
      system D {
        subdomain M { context C {
          aggregate Plan crossTenant { code: string }
          repository Plans for Plan { }
        }}
      }
    `);
    expect(errors).toEqual([]);
    const plan = aggByName(systemOf(model), "Plan");
    expect(plan.crossTenant).toBe(true);
  });

  it("parses crossTenant before a with-clause (`crossTenant with …`)", async () => {
    const { model, errors } = await parseString(`
      system D {
        subdomain M { context C {
          aggregate Invoice crossTenant with auditable { number: string }
          repository Invoices for Invoice { }
        }}
      }
    `);
    expect(errors).toEqual([]);
    const invoice = aggByName(systemOf(model), "Invoice");
    expect(invoice.crossTenant).toBe(true);
    expect(invoice.withClause?.calls?.[0]?.name).toBe("auditable");
  });

  it("stays absent (falsy) on an unmarked aggregate", async () => {
    const { model, errors } = await parseString(`
      system D {
        subdomain M { context C {
          aggregate Order { subject: string }
          repository Orders for Order { }
        }}
      }
    `);
    expect(errors).toEqual([]);
    expect(aggByName(systemOf(model), "Order").crossTenant).toBeFalsy();
  });
});

describe("tenancy surface — structural printer roundtrip", () => {
  it("prints `tenancy by …` and `crossTenant` back to re-parsing source", async () => {
    const source = `
      system Billder {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Organization
        subdomain Billing {
          context Catalog {
            aggregate Plan crossTenant { code: string }
            aggregate Organization { name: string }
            repository Plans for Plan { }
            repository Organizations for Organization { }
          }
        }
      }
    `;
    const { model, errors } = await parseString(source);
    expect(errors).toEqual([]);
    const printed = printStructural(systemOf(model));
    expect(printed).toContain("tenancy by user.tenantId of Organization");
    expect(printed).toContain("aggregate Plan crossTenant {");
    // Roundtrip: the printed source re-parses to the same declared facts.
    const reparsed = await parseString(printed);
    expect(reparsed.errors).toEqual([]);
    const sys = systemOf(reparsed.model);
    const decl = sys.members.find(isTenancyDecl) as TenancyDecl;
    expect(decl.claim.ref?.name).toBe("tenantId");
    expect(decl.registry.ref?.name).toBe("Organization");
    expect(aggByName(sys, "Plan").crossTenant).toBe(true);
  });
});

describe("tenancy / crossTenant stay legal as ordinary identifiers (soft keywords)", () => {
  it("a field named `tenancy` / `crossTenant` still parses and is readable in expressions", async () => {
    const { errors } = await parseString(`
      system D {
        subdomain M { context C {
          aggregate Order {
            tenancy: string
            crossTenant: bool
            derived hasTenancy: bool = this.tenancy != ""
            derived isCross: bool = this.crossTenant
          }
          repository Orders for Order { }
        }}
      }
    `);
    expect(errors).toEqual([]);
  });

  it("a parameter named `tenancy` still parses (LooseName position)", async () => {
    const { errors } = await parseString(`
      system D {
        subdomain M { context C {
          aggregate Order {
            subject: string
            operation rename(tenancy: string) {
              subject := tenancy
            }
          }
          repository Orders for Order { }
        }}
      }
    `);
    expect(errors).toEqual([]);
  });
});
