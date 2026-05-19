// Slice A4 — `Form(of: <Aggregate>)` walker-side auto-dispatch.
//
// Walker introspects an aggregate's IR field list and emits one
// RHF-bound input per non-optional field, dispatching by type
// (string→TextInput, int/decimal→NumberInput, bool→Switch via
// Controller, datetime→TextInput[type=datetime-local], enum→Select,
// `Id<X>`→Select with auto-injected `useAllX()` picker, value-
// object→nested Fieldset).  Required-field metadata becomes RHF
// rules through Zod (zodResolver(Create<Agg>Request)).
//
// What this slice pins:
//   1. The page TSX emits with `useForm` + `zodResolver` + a
//      `useCreate<Agg>()` mutation hook.
//   2. Each non-optional aggregate field surfaces in the form.
//   3. `Id<X>` targets auto-inject `useAll<TargetPlural>()` hooks at
//      page-top.
//   4. The default submit handler matches scaffold parity
//      (`create.mutateAsync` + notify + navigate to `/<plural>/{id}`).
//   5. An explicit `onSubmit: vals => …` lambda overrides the
//      default handler and skips the notifications import.
//   6. `testid:` on the Form sets the per-field testid namespace
//      (so `<slug>-input-<f>` becomes `<testid>-input-<f>`).
//   7. RHF parity with scaffold's New-page output — the field-level
//      TSX comes from the SAME `prepareFormFieldVM` + `renderFormField`
//      preparer, so any future Zod-rules / Controller / register
//      tweak in the scaffold path automatically applies here.

import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { generateSystems } from "../src/system/index.js";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Model } from "../src/language/generated/ast.js";

async function buildAndGenerate(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const { parseHelper } = await import("langium/test");
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  return generateSystems(doc.parseResult.value as Model).files;
}

const baseOrderSystem = (body: string) => `
  system S {
    module M {
      context C {
        aggregate Order {
          customerId: string display
          quantity:   int
        }
        repository Orders for Order { }
      }
    }
    ui WebApp {
      page CreateOrder {
        route: "/orders/new"
        body:  ${body}
      }
    }
    deployable api { platform: hono, modules: M, port: 3000 }
    deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
  }
`;

describe("Slice A4 — Form(of: <Aggregate>) auto-dispatch", () => {
  it("emits useForm + zodResolver + useCreate<Agg> mutation hook", async () => {
    const files = await buildAndGenerate(baseOrderSystem(`Form(of: Order)`));
    const tsx = files.get("web/src/pages/create_order.tsx")!;
    expect(tsx).toBeDefined();
    expect(tsx).toMatch(/import \{[^}]*useForm[^}]*\} from "react-hook-form"/);
    expect(tsx).toMatch(/import \{ zodResolver \} from "@hookform\/resolvers\/zod"/);
    expect(tsx).toMatch(
      /import \{ CreateOrderRequest, useCreateOrder \} from "\.\.\/api\/order"/,
    );
    expect(tsx).toMatch(/const create = useCreateOrder\(\)/);
    expect(tsx).toMatch(/useForm<CreateOrderRequest>/);
    expect(tsx).toMatch(/resolver: zodResolver\(CreateOrderRequest\)/);
  });

  it("emits one input per non-optional aggregate field", async () => {
    const files = await buildAndGenerate(baseOrderSystem(`Form(of: Order)`));
    const tsx = files.get("web/src/pages/create_order.tsx")!;
    // string → TextInput with register("customerId")
    expect(tsx).toMatch(
      /<TextInput[^>]*\{\.\.\.register\("customerId"\)\}/,
    );
    // int → NumberInput inside Controller (RHF requirement for non-
    // string inputs)
    expect(tsx).toMatch(
      /<Controller[\s\S]*name="quantity"[\s\S]*<NumberInput/,
    );
  });

  it("excludes optional fields from the create form (scaffold-parity rule)", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M {
          context C {
            aggregate Order {
              customerId: string display
              note:       string?
            }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          page CreateOrder { route: "/orders/new"  body: Form(of: Order) }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const tsx = files.get("web/src/pages/create_order.tsx")!;
    expect(tsx).toBeDefined();
    expect(tsx).toMatch(/register\("customerId"\)/);
    expect(tsx).not.toMatch(/register\("note"\)/);
    // `note` should not appear in defaultValues either.
    expect(tsx).not.toMatch(/note:/);
  });

  it("Id<X> targets auto-inject useAll<TargetPlural>() at page-top", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M {
          context C {
            aggregate Customer {
              name: string display
            }
            repository Customers for Customer { }
            aggregate Order {
              customerId: Id<Customer>
              quantity:   int
            }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          page CreateOrder { route: "/orders/new"  body: Form(of: Order) }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const tsx = files.get("web/src/pages/create_order.tsx")!;
    expect(tsx).toBeDefined();
    expect(tsx).toMatch(
      /import \{ useAllCustomers \} from "\.\.\/api\/customer"/,
    );
    expect(tsx).toMatch(/const __customers = useAllCustomers\(\)/);
    // Field is a Select with options from the hook.
    expect(tsx).toMatch(/<Select[\s\S]*data=\{\(__customers\.data/);
  });

  it("default submit handler emits the scaffold's create + notify + navigate flow", async () => {
    const files = await buildAndGenerate(baseOrderSystem(`Form(of: Order)`));
    const tsx = files.get("web/src/pages/create_order.tsx")!;
    expect(tsx).toMatch(/await create\.mutateAsync\(vals\)/);
    expect(tsx).toMatch(
      /notifications\.show\(\{ color: "green", message: "Order created" \}\)/,
    );
    expect(tsx).toMatch(/navigate\(`\/orders\/\$\{out\.id\}`\)/);
    // Default flow needs the notifications import too.
    expect(tsx).toMatch(
      /import \{ notifications \} from "@mantine\/notifications"/,
    );
  });

  it("explicit onSubmit: lambda overrides the default flow and skips the notify import", async () => {
    const files = await buildAndGenerate(
      baseOrderSystem(`Form(of: Order, onSubmit: v => create.mutateAsync(v))`),
    );
    const tsx = files.get("web/src/pages/create_order.tsx")!;
    expect(tsx).toBeDefined();
    expect(tsx).toMatch(/handleSubmit\(async \(vals\) => create\.mutateAsync\(vals\)\)/);
    expect(tsx).not.toMatch(/notifications\.show/);
    expect(tsx).not.toMatch(/import \{ notifications \}/);
  });

  it("testid: on the Form replaces the auto-derived per-field testid namespace", async () => {
    const files = await buildAndGenerate(
      baseOrderSystem(`Form(of: Order, testid: "place-order")`),
    );
    const tsx = files.get("web/src/pages/create_order.tsx")!;
    expect(tsx).toBeDefined();
    expect(tsx).toMatch(/data-testid="place-order-input-customerId"/);
    expect(tsx).toMatch(/data-testid="place-order-input-quantity"/);
    expect(tsx).toMatch(/data-testid="place-order-submit"/);
  });

  it("missing 'of:' or unknown aggregate emits a visible TSX comment placeholder", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Broken { route: "/x"  body: Form() }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const tsx = files.get("web/src/pages/broken.tsx")!;
    expect(tsx).toBeDefined();
    expect(tsx).toMatch(/\{\/\* Form\(of: …\): missing 'of:' aggregate ref \*\/\}/);
  });
});
