// `CreateForm { of: <Aggregate> }` walker-side auto-dispatch.
//
// Walker introspects an aggregate's IR field list and emits one
// RHF-bound input per non-optional field, dispatching by type
// (string→TextInput, int/decimal→NumberInput, bool→Switch via
// Controller, datetime→TextInput[type=datetime-local], enum→Select,
// `X id`→Select with auto-injected `useAllX()` picker, value-
// object→nested Fieldset).  Required-field metadata becomes RHF
// rules through Zod (zodResolver(Create<Agg>Request)).
//
// What this test pins:
//   1. The page TSX emits with `useForm` + `zodResolver` + a
//      `useCreate<Agg>()` mutation hook.
//   2. Each non-optional aggregate field surfaces in the form.
//   3. `X id` targets auto-inject `useAll<TargetPlural>()` hooks at
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
import { generateSystemFiles } from "../../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

const baseOrderSystem = (body: string) => `
  system S {
    subdomain M {
      context C {
        aggregate Order {
          customerId: string
          derived display: string = customerId
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
    deployable api { platform: node, contexts: [C], port: 3000 }
    deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
  }
`;

describe("CreateForm { of: <Aggregate> } auto-dispatch", () => {
  it("emits useForm + zodResolver + useCreate<Agg> mutation hook", async () => {
    const files = await buildAndGenerate(baseOrderSystem(`CreateForm { of: Order }`));
    const tsx = files.get("web/src/pages/create_order.tsx")!;
    expect(tsx).toBeDefined();
    expect(tsx).toMatch(/import \{[^}]*useForm[^}]*\} from "react-hook-form"/);
    expect(tsx).toMatch(/import \{ zodResolver \} from "@hookform\/resolvers\/zod"/);
    expect(tsx).toMatch(/import \{ CreateOrderRequest, useCreateOrder \} from "\.\.\/api\/order"/);
    expect(tsx).toMatch(/const create = useCreateOrder\(\)/);
    expect(tsx).toMatch(/useForm<CreateOrderRequest>/);
    expect(tsx).toMatch(/resolver: zodResolver\(CreateOrderRequest\)/);
  });

  it("emits one input per non-optional aggregate field", async () => {
    const files = await buildAndGenerate(baseOrderSystem(`CreateForm { of: Order }`));
    const tsx = files.get("web/src/pages/create_order.tsx")!;
    // string → TextInput with register("customerId")
    expect(tsx).toMatch(/<TextInput[^>]*\{\.\.\.register\("customerId"\)\}/);
    // int → NumberInput inside Controller (RHF requirement for non-
    // string inputs)
    expect(tsx).toMatch(/<Controller[\s\S]*name="quantity"[\s\S]*<NumberInput/);
  });

  it("excludes optional fields from the create form (scaffold-parity rule)", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M {
          context C {
            aggregate Order {
              customerId: string
              derived display: string = customerId
              note:       string?
            }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          page CreateOrder { route: "/orders/new"  body: CreateForm { of: Order } }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
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

  it("X id targets auto-inject useAll<TargetPlural>() at page-top", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M {
          context C {
            aggregate Customer {
              name: string
              derived display: string = name
            }
            repository Customers for Customer { }
            aggregate Order {
              customerId: Customer id
              quantity:   int
            }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          page CreateOrder { route: "/orders/new"  body: CreateForm { of: Order } }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const tsx = files.get("web/src/pages/create_order.tsx")!;
    expect(tsx).toBeDefined();
    expect(tsx).toMatch(/import \{ useAllCustomers \} from "\.\.\/api\/customer"/);
    expect(tsx).toMatch(/const __customers = useAllCustomers\(\)/);
    // Field is a Select with options from the hook.
    expect(tsx).toMatch(/<Select[\s\S]*data=\{\(__customers\.data/);
  });

  it("X id target with COMPOUND display still emits a Select (reads wire `display` field)", async () => {
    // Before PR B: `derived display: string = firstName + " " + lastName`
    // (anything other than a single bare property reference) routed
    // the id field to the text-input fallback — Select picker
    // disabled, label rendered as raw uuid.  The wire response from
    // every backend already carries the computed `display` derived as
    // a JSON field, so the picker can always read `__o.display`
    // regardless of the source-expression shape.
    const files = await buildAndGenerate(`
      system S {
        subdomain M {
          context C {
            aggregate Customer {
              firstName: string
              lastName: string
              derived display: string = firstName + " " + lastName
            }
            repository Customers for Customer { }
            aggregate Order {
              customerId: Customer id
              quantity:   int
            }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          page CreateOrder { route: "/orders/new"  body: CreateForm { of: Order } }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const tsx = files.get("web/src/pages/create_order.tsx")!;
    expect(tsx).toBeDefined();
    // Hook is still imported and the Select is rendered.
    expect(tsx).toMatch(/import \{ useAllCustomers \} from "\.\.\/api\/customer"/);
    expect(tsx).toMatch(/<Select[\s\S]*data=\{\(__customers\.data/);
    // Label binding reads the canonical wire `display` field — the
    // expression shape is opaque to the client.
    expect(tsx).toMatch(/label:\s*__o\.display\b/);
    // No text-input fallback was emitted for the customerId field.
    expect(tsx).not.toMatch(/<TextInput[^>]*customerId/);
  });

  it("default submit handler emits the scaffold's create + notify + navigate flow", async () => {
    const files = await buildAndGenerate(baseOrderSystem(`CreateForm { of: Order }`));
    const tsx = files.get("web/src/pages/create_order.tsx")!;
    expect(tsx).toMatch(/await create\.mutateAsync\(vals\)/);
    expect(tsx).toMatch(/notifications\.show\(\{ color: "green", message: "Order created" \}\)/);
    expect(tsx).toMatch(/navigate\(`\/orders\/\$\{out\.id\}`\)/);
    // Default flow needs the notifications import too.
    expect(tsx).toMatch(/import \{ notifications \} from "@mantine\/notifications"/);
  });

  it("explicit onSubmit: lambda overrides the default flow and skips the notify import", async () => {
    const files = await buildAndGenerate(
      baseOrderSystem(`CreateForm { of: Order, onSubmit: v => create.mutateAsync(v) }`),
    );
    const tsx = files.get("web/src/pages/create_order.tsx")!;
    expect(tsx).toBeDefined();
    expect(tsx).toMatch(/handleSubmit\(async \(vals\) => create\.mutateAsync\(vals\)\)/);
    expect(tsx).not.toMatch(/notifications\.show/);
    expect(tsx).not.toMatch(/import \{ notifications \}/);
  });

  it("testid: on the Form replaces the auto-derived per-field testid namespace", async () => {
    const files = await buildAndGenerate(
      baseOrderSystem(`CreateForm { of: Order, testid: "place-order" }`),
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
        subdomain M { context C { } }
        ui WebApp {
          page Broken { route: "/x"  body: CreateForm {} }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const tsx = files.get("web/src/pages/broken.tsx")!;
    expect(tsx).toBeDefined();
    expect(tsx).toMatch(/\{\/\* CreateForm\(of: …\): missing 'of:' aggregate ref \*\/\}/);
  });
});

describe("CreateForm renders the create-input contract, not raw fields (S1b)", () => {
  it("a stamp-target field never surfaces as a client input (form, defaults, page object)", async () => {
    const files = await buildAndGenerate(`
      system S {
        user { id: guid  role: string }
        subdomain M {
          context C {
            aggregate Order {
              customerId: string
              createdByRole: string
              stamp onCreate { createdByRole := currentUser.role }
            }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          page CreateOrder {
            route: "/orders/new"
            body:  CreateForm { of: Order }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000, auth: required }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const tsx = files.get("web/src/pages/create_order.tsx")!;
    expect(tsx).toBeDefined();
    // The client-suppliable field renders; the server-stamped one does not —
    // it isn't in Create<Agg>Request (promoteStampTargets → managed →
    // forCreateInput), so an input/defaultValue for it would not typecheck.
    expect(tsx).toMatch(/data-testid="orders-new-input-customerId"/);
    expect(tsx).not.toMatch(/createdByRole/);
    // Managed fields stay readable — the api module keeps it in the RESPONSE
    // schema while dropping it from the create request.
    const api = files.get("web/src/api/order.ts")!;
    expect(api).toBeDefined();
    const createSchema = api.slice(0, api.indexOf("OrderResponse"));
    expect(createSchema).not.toMatch(/createdByRole/);
    expect(api).toMatch(/createdByRole/);
  });
});
