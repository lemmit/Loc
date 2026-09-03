// `loom.page-form-locals-unsupported` — two forms on one page whose generated
// page-local bindings collide.
//
// What shipped before this gate, per frontend, all reproduced byte-for-byte:
//
//   react   `const create = useCreateItem(); const { register, handleSubmit,
//           setError, formState: { errors } } = useForm<CreateItemRequest>(…)`
//           emitted TWICE in one function scope → TS2300 ×3.  Same for two
//           CreateForms over DIFFERENT aggregates: the locals carry no
//           aggregate in their names.
//   svelte  identical shape (`const create` / `const form` twice).
//   vue     the shell DEDUPES the decl strings, so it COMPILES — and the
//           second form binds `form.values.<field>` of the FIRST form's schema
//           and submits the FIRST form's mutation.  A `CreateForm { of: Note }`
//           posting an `Item`, announcing "Note created", navigating to
//           `/notes/…`.  Silent.
//   angular locals are already aggregate-scoped (`itemCreate`, `itemForm`), so
//           two DIFFERENT aggregates are correct; two forms over the SAME
//           aggregate collide (`itemCreate`/`itemForm`/`onSubmitItem` ×2).
//
// The gate is scoped to exactly that, per framework.  The negative cases below
// are the ones that were probed CLEAN on all four and must never be refused —
// a gate one axis too wide is a false refusal.

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { buildLoomModel } from "../../_helpers/index.js";

const DOMAIN = `
  subdomain S {
    context C {
      aggregate Item {
        name: string
        operation rename(n: string) { name := n }
        operation touch(m: string) { name := m }
      }
      repository Items for Item { }
      aggregate Note { text: string }
      repository Notes for Note { }
    }
  }
  api Api from S
  storage pg { type: postgres }
`;

async function formDiags(platform: string, body: string): Promise<string[]> {
  const loom = await buildLoomModel(`
    system Demo {
      ${DOMAIN}
      ui Web {
        api C: Api
        page Probe { route: "/probe" body: ${body} }
      }
      storage loomDb { type: postgres }
      resource st { for: C, kind: state, use: loomDb }
      deployable api { platform: node, contexts: [C], dataSources: [st], serves: Api, port: 3000 }
      deployable web { platform: ${platform}, targets: api, ui: Web { C: api }, port: 3001 }
    }
  `);
  return validateLoomModel(loom)
    .filter((d) => d.code === "loom.page-form-locals-unsupported")
    .map((d) => d.message);
}

const TWO_CREATE_SAME = `Stack { CreateForm { of: Item }, CreateForm { of: Item } }`;
const TWO_CREATE_DIFF = `Stack { CreateForm { of: Item }, CreateForm { of: Note } }`;
const CREATE_PLUS_OP = `Stack { CreateForm { of: Item }, OperationForm { of: Item, op: rename } }`;
const TWO_OPS_DIFF = `Stack { OperationForm { of: Item, op: rename }, OperationForm { of: Item, op: touch } }`;
const TWO_OPS_SAME = `Stack { OperationForm { of: Item, op: rename }, OperationForm { of: Item, op: rename } }`;
const ONE_FORM = `Stack { CreateForm { of: Item } }`;

describe("loom.page-form-locals-unsupported", () => {
  // --- fires -------------------------------------------------------------
  // ANGULAR IS ABSENT ON PURPOSE — it emits both shapes correctly (see the
  // "must NOT fire" arms below), so listing it here would assert a refusal the
  // emitter has no need of.
  for (const fw of ["react", "vue", "svelte"]) {
    it(`${fw}: two CreateForms over the SAME aggregate collide`, async () => {
      const d = await formDiags(fw, TWO_CREATE_SAME);
      expect(d).toHaveLength(1);
      expect(d[0]).toContain("page 'Probe'");
      expect(d[0]).toContain("CreateForm { of: Item }");
    });

    it(`${fw}: two OperationForms over the SAME op collide`, async () => {
      const d = await formDiags(fw, TWO_OPS_SAME);
      expect(d).toHaveLength(1);
      expect(d[0]).toContain("op: rename");
    });
  }

  // react / svelte / vue name the locals BARE, so two create forms collide
  // even across aggregates.  Angular's are aggregate-scoped and DO NOT.
  for (const fw of ["react", "vue", "svelte"]) {
    it(`${fw}: two CreateForms over DIFFERENT aggregates still collide (bare locals)`, async () => {
      const d = await formDiags(fw, TWO_CREATE_DIFF);
      expect(d).toHaveLength(1);
      expect(d[0]).toContain("CreateForm { of: Item } and CreateForm { of: Note }");
    });
  }

  it("vue: the message says it does NOT fail the build — it submits the wrong mutation", async () => {
    const d = await formDiags("vue", TWO_CREATE_DIFF);
    expect(d[0]).toContain("does NOT fail the build");
    expect(d[0]).toContain("silently submits the first form's mutation");
  });

  it("react: the message says the duplicate declarations are a compile error", async () => {
    const d = await formDiags("react", TWO_CREATE_DIFF);
    expect(d[0]).toContain("compile error in the generated project");
  });

  // --- must NOT fire (a gate one axis too wide is a false refusal) --------
  // ANGULAR IS FULLY DRAINED — and these three arms are the ratchet that keeps
  // it out of the gate.  Its locals were always aggregate-scoped (so DIFFERENT
  // aggregates never collided), and #2734 closed the same-aggregate case with
  // an ordinal suffix (`itemCreate2` / `onSubmitItem2` / `itemForm2`).  An
  // earlier revision of this gate still listed angular, which refused a shape
  // that works AND hid #2734's own `gives the second same-aggregate form its
  // own class members` test behind the refusal — the fixture could not reach
  // generation.  If angular ever regresses, these three fail rather than the
  // gate quietly re-widening.
  it("angular: two CreateForms over DIFFERENT aggregates are fine (locals are aggregate-scoped)", async () => {
    expect(await formDiags("angular", TWO_CREATE_DIFF)).toEqual([]);
  });

  it("angular: two CreateForms over the SAME aggregate are fine (#2734 ordinal suffix)", async () => {
    expect(await formDiags("angular", TWO_CREATE_SAME)).toEqual([]);
  });

  it("angular: two OperationForms over the SAME op are fine (#2734 ordinal suffix)", async () => {
    expect(await formDiags("angular", TWO_OPS_SAME)).toEqual([]);
  });

  for (const fw of ["react", "vue", "svelte", "angular"]) {
    it(`${fw}: CreateForm + OperationForm do not collide`, async () => {
      expect(await formDiags(fw, CREATE_PLUS_OP)).toEqual([]);
    });

    it(`${fw}: two OperationForms over DIFFERENT ops do not collide`, async () => {
      expect(await formDiags(fw, TWO_OPS_DIFF)).toEqual([]);
    });

    it(`${fw}: a single form is fine`, async () => {
      expect(await formDiags(fw, ONE_FORM)).toEqual([]);
    });
  }

  // The rule is JS-frontend-scoped: feliz / flutter / heex build forms through
  // entirely different machinery and were NOT probed, so naming them would be
  // an unverified refusal.
  for (const fw of ["feliz", "flutter"]) {
    it(`${fw}: not covered by this gate`, async () => {
      expect(await formDiags(fw, TWO_CREATE_SAME)).toEqual([]);
    });
  }
});
