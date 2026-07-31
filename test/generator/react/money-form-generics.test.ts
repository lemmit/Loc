import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// M-T9.24 F1b — a scaffolded form over a bare `money` field failed `tsc`.
//
// `zodResolver` types the resolver's INPUT as `z.input`.  Money is the one wire
// type whose schema TRANSFORMS on parse (decimal string in, `Decimal` out), so
// `z.input ≠ z.output` and the single-generic `useForm<Create<Agg>Request>`
// asked for a `Resolver<{total: Decimal}, …>` while `zodResolver` handed back a
// `Resolver<{total: string | Decimal}, …>`:
//
//   error TS2322: Type 'Resolver<{ ref: string; total: string | Decimal; }, …>'
//     is not assignable to type 'Resolver<{ ref: string; total: Decimal; }, …>'
//   error TS2345: Argument of type 'TFieldValues' is not assignable …
//
// Fixed by emitting RHF's THREE-generic form —
// `useForm<FormState, unknown, Request>` — conditionally, only where the schema
// reaches money.  The condition matters twice: the `FormState` alias is itself
// only emitted where `z.input` diverges, and every non-money form stays on the
// single generic, so nothing else in the emitted output moves.
// ---------------------------------------------------------------------------

const system = (totalType: string) => `
system MoneyForm {
  subdomain Ops {
    context Ops {
      aggregate Invoice with crudish {
        ref: string
        total: ${totalType}
      }
      repository Invoices for Invoice { }
      workflow IssueInvoice transactional {
        create(ref: string, total: ${totalType}) {
          let inv = Invoice.create({ ref: ref, total: total })
        }
      }
    }
  }
  api OpsApi from Ops
  ui Web with scaffold(subdomains: [Ops]) {
    api ops: OpsApi
    page Issue {
      route: "/issue"
      body: WorkflowForm(runs: IssueInvoice)
    }
  }
  storage primary { type: postgres }
  resource opsState { for: Ops, kind: state, use: primary }
  deployable svc {
    platform: node
    contexts: [Ops]
    dataSources: [opsState]
    serves: OpsApi
    port: 4000
  }
  deployable web {
    platform: react
    targets: svc
    ui: Web { ops: svc }
    port: 3000
  }
}
`;

async function build(totalType: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(system(totalType));
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("money forms use RHF's three-generic useForm", () => {
  it("emits <FormState, unknown, Request> and imports the alias, on create/update/workflow", async () => {
    const files = await build("money");

    const create = files.get("web/src/pages/invoices/new.tsx")!;
    expect(create).toContain("useForm<CreateInvoiceFormState, unknown, CreateInvoiceRequest>(");
    expect(create).toContain("CreateInvoiceFormState");

    const detail = files.get("web/src/pages/invoices/detail.tsx")!;
    expect(detail).toContain("useForm<UpdateInvoiceFormState, unknown, UpdateInvoiceRequest>(");

    // Workflow requests live in their own module, which had no dual aliases at
    // all — so a money-bearing WorkflowForm had no `FormState` name to reach
    // for.  The alias is now emitted there under the same gate.
    const issue = files.get("web/src/pages/issue.tsx")!;
    expect(issue).toContain("useForm<IssueInvoiceFormState, unknown, IssueInvoiceRequest>(");
    expect(files.get("web/src/api/workflows.ts")).toContain(
      "export type IssueInvoiceFormState = z.input<typeof IssueInvoiceRequest>;",
    );
  });

  it("leaves a form with no money field on the single generic", async () => {
    // `decimal`'s schema does not transform, so input === output and the extra
    // generics would be noise — and the `FormState` alias isn't emitted for it.
    const files = await build("decimal");
    const create = files.get("web/src/pages/invoices/new.tsx")!;
    expect(create).toContain("useForm<CreateInvoiceRequest>(");
    expect(create).not.toContain("FormState");
    expect(files.get("web/src/api/invoice.ts")).not.toContain("CreateInvoiceFormState");
  });
});

// ---------------------------------------------------------------------------
// Follow-up: the create-form gate read the wrong field list.
//
// The form RENDERS only non-optional create-input fields, but the SCHEMA it
// resolves against — `Create<Agg>Request` — is built from the UNFILTERED
// `createInputFields(agg)`, which is also what `api-module.ts` gates
// `dualTypeAliases` on.  Gating the generic on the rendered (filtered) list
// made the two disagree for an aggregate whose only money field is OPTIONAL:
// the alias was emitted, the schema carried the transform, and the form still
// took the single generic — the same TS2322/TS2345, one case narrower.
//
// The rule: the generic describes what `zodResolver` PARSES, so it must be
// keyed on the schema's field set, never on the subset the form draws.
// ---------------------------------------------------------------------------

describe("the create-form generic follows the SCHEMA's field set, not the rendered one", () => {
  it("an OPTIONAL money field still forces the three-generic form", async () => {
    const files = await build("money?");
    const api = files.get("web/src/api/invoice.ts")!;
    // The alias is emitted — the schema carries the transform either way…
    expect(api).toContain(
      "export type CreateInvoiceFormState = z.input<typeof CreateInvoiceRequest>;",
    );
    // …so the form must name it, even though the field is never rendered.
    const page = files.get("web/src/pages/invoices/new.tsx")!;
    expect(page).toContain("useForm<CreateInvoiceFormState, unknown, CreateInvoiceRequest>(");
    expect(page).toContain("CreateInvoiceFormState");
  });

  it("a money-free aggregate is untouched — still the single generic", async () => {
    const files = await build("decimal");
    const page = files.get("web/src/pages/invoices/new.tsx")!;
    expect(page).toContain("useForm<CreateInvoiceRequest>(");
    expect(page).not.toContain("FormState");
  });
});
