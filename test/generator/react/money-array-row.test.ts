// Money inside a dynamic row (`VO[]` + `CreateForm`) must stay a STRING.
//
// M-T1.24 seam 2 (numeric-types audit F5).  `field-input-money` used to sit in
// the `NUMERIC` set of `src/generator/_walker/form-fields-vm.ts`, so an array-row
// money sub-field registered `{ valueAsNumber: true }` and the fresh-row seed was
// the JS number `0`.  Both break the money contract: `moneySchema` is
// `z.union([z.instanceof(Decimal), z.string()])`, so a number never validates —
// and had it validated, the wire would have carried a JSON number instead of the
// decimal string the backends parse.  The flat money field (Controller +
// Decimal) was always correct; only the array path diverged.
//
// The seed is the string `"0"`, not `""`: `moneySchema`'s string arm is
// `/^-?\d+(\.\d+)?$/`, which rejects the empty string — an untouched fresh row
// must still submit.
//
// The `int` sibling in the same row is the control: it keeps `valueAsNumber`
// and the numeric `0` seed, so this is a money-only change.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = (platform: string, design: string) => `
system Shop {
  api ShopApi from Sales
  subdomain Sales {
    context Ordering {
      valueobject Fee { label: string  amount: money  qty: int }
      aggregate Invoice with crudish {
        reference: string
        fees: Fee[]
      }
      repository Invoices for Invoice { }
    }
  }
  storage db { type: postgres }
  resource ordState { for: Ordering, kind: state, use: db }
  ui WebApp with scaffold(subdomains: [Sales]) { api Shop: ShopApi }
  deployable api { platform: node contexts: [Ordering] dataSources: [ordState] serves: ShopApi port: 3000 }
  deployable web { platform: ${platform} targets: api ui: WebApp { Shop: api } port: 3005 design: ${design} }
}
`;

async function newPage(platform: string, design: string, suffix: string): Promise<string> {
  const files = await generateSystemFiles(SRC(platform, design));
  return [...files.entries()].find(([p]) => p.endsWith(suffix))![1];
}

// mantine / mui / chakra destructure `register` off `useForm`; shadcn keeps the
// whole `form` object and registers through `form.register`.
const REACT_PACKS: { design: string; reg: string }[] = [
  { design: "mantine", reg: "register" },
  { design: "mui", reg: "register" },
  { design: "chakra", reg: "register" },
  { design: "shadcn", reg: "form.register" },
];

describe.each(REACT_PACKS)("react money array row — $design", ({ design, reg }) => {
  const page = () => newPage("react", design, "pages/invoices/new.tsx");

  it("registers the money sub-field WITHOUT valueAsNumber", async () => {
    const tsx = await page();
    expect(tsx).toContain(`{...${reg}(\`fees.\${index}.amount\`)}`);
    expect(tsx).not.toContain(`{...${reg}(\`fees.\${index}.amount\`, { valueAsNumber: true })}`);
  });

  it("still coerces the int sibling via valueAsNumber", async () => {
    const tsx = await page();
    expect(tsx).toContain(`{...${reg}(\`fees.\${index}.qty\`, { valueAsNumber: true })}`);
  });

  it('seeds a fresh row with the STRING "0" for money and the number 0 for int', async () => {
    const tsx = await page();
    expect(tsx).toContain('appendFees({ label: "", amount: "0", qty: 0 })');
  });
});

describe("svelte money array row — shadcnSvelte", () => {
  it('pushes a fresh row whose money seed is the string "0"', async () => {
    const page = await newPage("svelte", "shadcnSvelte", "invoices/new/+page.svelte");
    expect(page).toContain('form.values.fees.push({ label: "", amount: "0", qty: 0 })');
  });
});

describe("vue money array row — shadcnVue", () => {
  it('pushes a fresh row whose money seed is the string "0"', async () => {
    const vue = await newPage("vue", "shadcnVue", "pages/invoices/new.vue");
    expect(vue).toContain('form.values.fees.push({ label: "", amount: "0", qty: 0 })');
  });
});
