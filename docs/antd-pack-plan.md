# Ant Design pack — deferred plan

> Status: scoped out, not started.  This document captures the design
> decisions so the work can be picked up later without re-deriving
> them.

## Why deferred

The current React design-pack lineup (Mantine, shadcn, MUI, Chakra)
covers the four dominant idiom-clusters:

| Pack | Idiom |
|---|---|
| Mantine | Hooks-first, batteries-included, modal/drawer-heavy |
| shadcn | Tailwind + Radix Primitives, source-vendored |
| MUI | Material spec, npm-shipped, mature |
| Chakra | Tokens-first, npm-shipped, prop-style |

Ant Design's idiom is a fifth: **declarative-table-first, enterprise
form layout, prescriptive component API**.  That's a useful addition
but not a parity gap — none of the existing packs leave a hole that
only AntD fills.

The trigger to start: a user request for AntD specifically, OR a
production deployment whose design language is Ant.

## What's needed

Concrete deliverables to ship `design: antd`:

### 1. Pack directory

Add `designs/antd/` with the full `pack.json` contract (see
`docs/design-system-packs.md` §3 for the required-emits list).  Mirror
Chakra's structure — closest in shape (npm-package model, same
emit list, no `shellFiles`/`shellGlobs`).

### 2. Helpers

- `antdIcon` map — Tabler-style DSL icon names → `@ant-design/icons`
  component names.  Use Chakra/MUI's icon map as a starting roster:
  `IconPlus → PlusOutlined`, `IconTrash → DeleteOutlined`,
  `IconCheck → CheckOutlined`, etc.
- `antdRadius` map — `xs`/`sm`/`md`/`lg`/`xl` → AntD's `borderRadius`
  token values (`2`/`4`/`6`/`8`/`16`).  AntD takes numbers like MUI;
  reuse the `muiRadius` shape.

No new helper *category* is required — `lucide`/`muiIcon`/`muiRadius`/
`chakraRadius` already establish the pattern.

### 3. AntD-specific primitive choices

AntD has stronger opinions than the other packs on several components.
The decisions to make at template-author time:

| Primitive | AntD-native choice | Note |
|---|---|---|
| `primitive-stack` | `<Space direction="vertical">` | AntD's preferred vertical flex |
| `primitive-group` | `<Space>` (horizontal default) | |
| `primitive-grid` | `<Row>` + `<Col>` | 24-column grid; map DSL `cols: N` to `span={24/N}` |
| `primitive-card` | `<Card title=…>` | AntD's Card has prescriptive header slots — use `title`/`extra` props, not children |
| `primitive-field` | `<Form.Item label=…><Input/></Form.Item>` | AntD couples label+input via `Form.Item`; the field-input templates need to emit `Form.Item` wrappers, not standalone `<Input>` |
| `primitive-tabs` | `<Tabs items=[]>` | AntD's v5 `items` prop is declarative, not children-based |
| `primitive-form-of` | `<Form layout="vertical" onFinish=…>` | AntD's `<Form>` is the idiomatic choice — see §5.  Requires the body-walker to gain a per-pack form-state seam (today it hardcodes RHF). |
| `primitive-table` (view-table) | `<Table columns=[] dataSource=[]>` | This is the big one — see below |
| `primitive-alert` | `<Alert type="error" message=… description=…>` | `type` takes `success`/`info`/`warning`/`error`; map semantic colors via a `helpers.colorSeverity` table or inline conditional |

### 4. The declarative-table question

AntD's `<Table>` is **declarative** (`columns={[{ title, dataIndex,
sorter, render }]}`) where every other pack's `<Table>` is
**composable** (`<Thead><Tr><Th>…`).  Two ways to handle this:

**Option A — emit the AntD-native shape in `primitive-table.hbs`.**
The walker passes the page's `ColumnDescriptor[]` view-model; the
template renders a `columns` array literal from it.  Loses the
`cell-*` template family for AntD — cells become `render: (v) => …`
functions inline in the columns array.

**Option B — keep the composable shape, lose AntD's sorting/filter
features.**  Render AntD's `<Table.Column>` JSX-style children
(`<Table columns={undefined}><Table.Column .../></Table>`), reusing
the existing `cell-*` templates.  Works but throws away the half of
AntD that motivates picking it.

Recommendation: **Option A**.  Add a one-off
`primitive-table.hbs` that consumes the page's column view-model
and outputs the declarative form.  The cost is that `cell-*` templates
go unused under AntD — but they remain the contract for the other
four packs, and AntD's `render: (v) =>` callbacks would be redundant
work.

This is the same decision AntD itself made vs other libraries; it's
not a generator failing.  The contract permits each pack to either
participate in the `cell-*` family or emit their own table shape —
the field is already there in `pack.json` and no new contract is
needed.

### 5. The AntD-form question

AntD's `<Form>` component has its own state machine, `getFieldValue`/
`setFieldValue` API, and `onFinish` lifecycle.  This conflicts with
the generator's existing react-hook-form integration: the four
in-tree `tsx` packs all emit `useForm` + `Controller` and expect
raw `<input>` shape semantics underneath.

Two options, with the project's "idiomatic per pack" principle
pulling the answer one way:

**Option A — use AntD's native `<Form>`.**  AntD's `<Form>` is as
load-bearing in AntD codebases as MUI's `<DataGrid>` is for MUI
tables.  Picking RHF here is the same anti-idiom we explicitly chose
to avoid for tables (see "DataTables" below).  Cost: this pack
diverges from the other four on form state, and the body-walker's
form path needs a per-pack switch (today it assumes RHF).

**Option B — RHF inside `<Form.Item>` shells.**  Wrap AntD's inputs in
`<Form.Item label="…" help={…}>` for the visual label/error slot but
keep RHF outside.  Mechanically simpler — body-walker stays as-is —
but the result is a half-AntD form that AntD users would not write
by hand.

**Recommended: Option A.**  The whole point of an AntD pack is to
produce code an AntD developer would recognize.  Expect this to
require adding a per-pack form-state strategy to the walker (the
same way each pack picks its DataTable engine — see §6).  RHF stays
the default for packs that don't declare a native form story.

### 6. DataTables (idiomatic per pack)

The four existing packs already differ on this — captured here for
completeness because the AntD answer is the same kind of decision:

| Pack | Datatable approach |
|---|---|
| Mantine | `mantine-datatable` (npm; declarative columns, sort + paging + selection built-in) |
| MUI | `@mui/x-data-grid` (npm; declarative columns + rows) |
| shadcn | TanStack Table headless + shadcn's `<Table>` primitive |
| Chakra | TanStack Table headless + Chakra's `<Table>` primitive |
| **antd** | **AntD's `<Table columns dataSource>` — its native declarative table is canonical, same as MUI** |

This is why §4's "declarative-table question" lands on **Option A**:
emit AntD's native shape in `primitive-table.hbs`, and let the
generator's per-pack data-table seam handle the divergence (the
same seam mantine/MUI use for their declarative tables).

### 6. DatePicker / DateTimePicker

AntD ships `<DatePicker>` and `<DatePicker showTime />` (combined).
The Mantine pack had a similar choice and walked back to a native
`<input type="datetime-local">` because Playwright couldn't `.fill()`
Mantine's picker.  AntD has the same Playwright concern — its date
picker is also a button that opens a panel.

Decision: **emit native `<input type="datetime-local">` for the
`field-input-datetime` template, same as Mantine after Phase 2**
(see existing comment in `test/generator-react.test.ts:107`).  Cost
is the visual mismatch with the rest of AntD; benefit is e2e parity.

### 7. Package + provider

```json
"dependencies": {
  "antd":                "^5.x",
  "@ant-design/icons":   "^5.x"
}
```

`main.hbs` wraps `<App>` in `<ConfigProvider theme={…}>` (no provider
strictly required, but conventional for theme tokens).  Notifications:
AntD ships `message` (toasts) and `notification` (corner cards) as
imperative APIs imported from `antd`; map `notifySuccess`/`notifyError`
to `message.success`/`message.error` in `format-helpers.hbs`.

### 8. Validation

Existing gate.  Add `antd` to the four-pack matrix in
`test/generated-react-build.test.ts` — expands 16 cases to 20.
Treat all four example fixtures (acme, banking, inventory, sales) as
must-pass before merging.

## Effort estimate

Larger than the MUI or Chakra pack because two architectural seams
need to grow to admit AntD's idioms:

1. **Per-pack form-state seam in the body-walker** (see §5).  The
   walker currently emits `useForm` + `Controller` unconditionally;
   AntD wants `<Form form={form}>` + `useForm` from `antd`.  This
   is the load-bearing change — once it exists, other packs continue
   to pick "RHF" via a pack-level `formState: "rhf"` flag (or
   equivalent contract entry) and AntD picks `formState: "antd"`.
2. **Declarative-table per pack** (see §4 + §6).  Mantine and MUI
   already need this for `mantine-datatable` / `@mui/x-data-grid`;
   AntD becomes the third declarative-table pack and shares whatever
   shape the seam settles on.  Worth designing all three together
   rather than retrofitting AntD onto a Mantine/MUI-specific design.

The remaining ~70 templates are MUI/Chakra-shape rename-fests once
the two seams above land.  Without those seams the pack ships in a
non-idiomatic shape and defeats the point.

## Open questions to resolve when picking it up

- Is `<App>`-wrapping AntD's `<ConfigProvider>` mandatory or just for
  theme tokens?  (Affects `main.hbs` shape.)
- AntD's `Tabs` v4 vs v5 `items` API — pin v5+ in the package range
  to avoid the deprecated children-based shape.
- AntD's `Card` headerless variant for the home-page dashboard
  blocks — `bordered={false}` vs a plain `<div>`?

## Cross-references

- `docs/design-system-packs.md` — the pack contract this work
  satisfies
- `designs/chakra/` — the closest structural template
- `designs/mui/` — closest npm-package model + has the `muiIcon` /
  `muiRadius` helper pattern AntD will copy
- `test/generated-react-build.test.ts` — the LOOM_REACT_BUILD gate
  AntD must enter
