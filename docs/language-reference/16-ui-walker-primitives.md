# 16. UI: the walker primitive library

Page bodies are written in a **closed primitive library** — 56 top-level primitives (`Stack`, `Heading`, `Field`, `Table`, `CreateForm`, `QueryView`, `Chart`, `For`, …) plus the two sub-elements `Tab` and `Column`, and the `match` expression. There is no escape hatch to raw markup; every primitive is dispatched by the body walker into the page's active **design pack**, so one `.ddd` body renders as Mantine, shadcn, Vuetify, Angular Material, daisyUI (Feliz), Material 3 (Flutter) or HEEx depending on the hosting frontend. Reach for this chapter to see what each primitive takes, what it emits, and where a target honestly declines.

> **Grammar:** primitives are `BuilderCall`s whose names come from the registry `src/generator/_walker/registry.ts` (`WALKER_PRIMITIVES`), mirrored for the validator by `src/util/walker-primitive-names.ts` (`WALKER_LAYOUT_PRIMITIVES`, `WALKER_SUB_PRIMITIVES`, `WALKER_PRIMITIVE_SLOTS`) and `src/util/walker-primitive-args.ts` (`WALKER_PRIMITIVE_NAMED_ARGS`) · **Validators:** `loom.unknown-page-element` · `loom.unresolved-page-ref` · `loom.page-primitive-unknown-arg` · `loom.page-primitive-extra-children` · `loom.sub-primitive-misplaced` · `loom.slot-outside-component` · `loom.component-prop-type` · `loom.a11y-missing-alt` · `loom.a11y-icon-only-no-name` · `loom.file-upload-not-file-field` · `loom.frontend-collection-op-unsupported` · `loom.user-visible-concat` · `loom.chart-kind-invalid` · `loom.chart-of-not-grouped` · `loom.chart-accessor-not-field` · `loom.datagrid-selection-not-state` · `loom.datagrid-selection-not-array` · `loom.table-filter-server-paged` · `loom.op-form-needs-route-id` · `loom.create-unknown-field` · `loom.create-server-field` · `loom.create-field-type` · per-target: `loom.datagrid-unsupported-target` · `loom.chart-unsupported-target` · `loom.table-filter-unsupported` · `loom.modal-controlled-op-form-unsupported` · `loom.flutter-primitive-unsupported` · **Docs:** [`../page-metamodel.md`](../page-metamodel.md) §9, [`../design-packs.md`](../design-packs.md), [`../actions.md`](../actions.md)

Every output block below is **real generated output** from one fixture — a `ui Web` with the pages shown, bound to seven deployables: `react` (Mantine v9, the default pack), `vue` (Vuetify), `svelte` (shadcnSvelte), `angular` (Angular Material), `feliz`, `flutter`, and a self-hosting `elixir` deployable (Phoenix LiveView, `coreComponents`). The `frontend` tab group carries the four static-bundle frontends; Feliz, Flutter and HEEx output follows as plain blocks where it diverges. A second `react` deployable pinned `design: shadcn` drives the `pack` tabs.

## The dispatch model

A page `body:` is one primitive call whose children are nested primitive calls. The shared walker (`walkBody`, `src/generator/_walker/walker-core.ts`) recurses the body `ExprIR`; for each `call` it looks the name up in `WALKER_PRIMITIVES` and invokes the renderer through the active `WalkerTarget`. **Six** targets ride that one core — `react`, `vue`, `svelte`, `angular` (`src/generator/<fw>/walker/*-target.ts`), `feliz` (`feliz-target.ts`, emits F#) and `flutter` (`flutter-target.ts`, emits Dart). **Phoenix LiveView does not**: `src/generator/elixir/heex-walker-core.ts` is a parallel engine dispatching off the same registry's `heex` renderers, because LiveView's topology (hoisted `handle_event` clauses, `for` comprehensions, `cond` blocks) diverges too far to share.

- **Layout / display / formatter / input** primitives render the same *tree* everywhere; only the host markup and pack vocabulary differ.
- **`match`, `For`, `QueryView`** are control flow, and here the frameworks genuinely diverge — React renders markup-valued expressions (`cond ? <A/> : <B/>`, `.map`), Vue/Svelte/Angular/HEEx emit block control flow (`<template v-if>`, `{#if}`, `@if`, `<%= cond do %>`), Flutter a Dart `switch` / spread.

Every registry entry also declares its **a11y contract** (`role`, `needsName`, `needsAlt`, `landmark`, …) — that is what emits the `role="toolbar"`, `aria-label`, `role="img"` and `aria-hidden` attributes you will see below, and what the `loom.a11y-*` gates read.

## The inventory

Positional **slots** are what a primitive renders positionally (`WALKER_PRIMITIVE_SLOTS`); a *container* renders every positional as a child. **Named args** are the only ones any emitter reads (`WALKER_PRIMITIVE_NAMED_ARGS`); `testid:` and `style: { … }` (an object literal of CSS declarations) are accepted by every primitive.

| Group | Primitive | Positional slots | Named args | Notes |
|---|---|---|---|---|
| Layout | `Stack`, `Group`, `Empty`, `Tabs`, `Breadcrumbs`, `KeyValueRow` | container (`Empty`: 1 — message; `KeyValueRow`: 2 — label, value) | — | `Tabs` owns `Tab { <label>, …children }` |
| Layout | `Grid` | container | `cols` | |
| Layout | `Container` | container | `size` | |
| Layout | `Card` | container | `variant`, `shadow` | |
| Layout | `Paper` | container | `padding` | |
| Layout | `Toolbar` | container | `label` | `role="toolbar"` + accessible name |
| Layout | `Section` | container | `id` | `<section id>` — anchor target, `region` landmark |
| Layout | `Sticky` | container | `top` | `position: sticky` wrapper |
| Layout | `Divider` | 0 | `label` | `role="separator"` |
| Inputs | `Field`, `NumberField`, `PasswordField`, `MultilineField`, `Toggle` | 1 — label | `bind`, `error` | controlled against a `state` field |
| Inputs | `SelectField` | 1 — label | `bind`, `options`, `error` | `options:` is a string-array expression |
| Inputs | `FileUpload` | 1 — label | `bind`, `error` | `bind:` must be a `File` state field |
| Display | `Heading` | 1 — text | `level`, `size`, `weight`, `gradient` | |
| Display | `Text`, `Bold`, `Italic`, `InlineCode` | 1 — text | — | |
| Display | `Badge` | 1 — label | — | |
| Display | `Anchor` | 1 — label | `to` | an **in-app route**, wired through the router link |
| Display | `Image` | 1 — src | `src`, `alt`, `decorative` | `alt:` or `decorative: true` required |
| Display | `Avatar` | 0 | `src`, `alt`, `decorative` | |
| Display | `Icon` | 0 | `name`, `svg`, `size`, `label`, `decorative` | builtin name (`src/generator/_walker/icons.ts`) or `svg:` literal; decorative unless `label:` |
| Display | `Alert` | 1 — message | `title`, `color` | `role="alert"` |
| Display | `Skeleton` | 0 | `count`, `height` | |
| Display | `Loader` | 0 | `size` | `role="status"` |
| Display | `Stat` | 2 — label, value | — | |
| Display | `CodeBlock` | 1 — source | `source`, `language`, `title` | highlight.js at runtime; the source is never translated |
| Display | `Slot` | 0 | — | the caller's children, `component` bodies only |
| Formatters | `Money` | 1 — value | `value`, `currency`, `decimals` | verbatim digits, see below |
| Formatters | `DateDisplay` | 1 — value | `value` | |
| Formatters | `EnumBadge` | 1 — value | `value`, `color` | |
| Formatters | `IdLink` | 1 — id | `of`, `id` | link to the aggregate's detail route |
| Formatters | `FileLink` | 1 — value | `value` | `<a href download>` over a `File` value |
| Formatters | `ProvenanceInfo` | 1 — record | `of`, `field` | "?" disclosure over a `provenanced` field |
| Formatters | `Timeline` | 1 — entries | `of` | the `history(id)` audit trail |
| Data | `QueryView` | 0 | `of`, `loading`, `error`, `empty`, `data`, `single`, `paged` | reads an api/projection query |
| Data | `Table` | container (`Column` children) | `rows`, `keyExpr`, `onRowClick`, `rowTestid`, `pageSize`, `striped`, `highlight`, `sticky`, `serverPaged`, `totalPages`, `sortKey`, `sortDir`, `page`, `filter` | |
| Data | `DataGrid` | container (`Column` children) | `rows`, `multiSort`, `columnVisibility`, `pageSize`, `selection` | TanStack Table; not on HEEx / Flutter |
| Data | `Column` (sub) | 2 — header, cell accessor | `field`, `sortable`, `filterable` | only inside `Table` / `DataGrid` |
| Data | `Chart` | 0 | `of`, `kind`, `x`, `y` | grouped projection → `"line"` / `"bar"` |
| Data | `For` | 2 — collection, item lambda | `each`, `empty`, `render` | |
| Control | `Button` | 1 — label | `label`, `onClick`, `to`, `disabled`, `loading`, `variant`, `icon`, `iconSvg`, `iconPosition`, `emphasis`, `type` | |
| Control | `Action` | 1 — the operation ref | `then` | one-button operation invocation |
| Control | `Modal` | container (state-controlled) / trigger + `OperationForm` | `trigger`, `title`, `open` | |
| Forms | `CreateForm` | 1 — the aggregate | `of`, `onSubmit` | |
| Forms | `OperationForm` | 1 — `record.op` | `of`, `op` | |
| Forms | `WorkflowForm` | 1 — the workflow | `runs`, `onSubmit` | |
| Forms | `DestroyForm` | 1 — the aggregate | `of`, `then` | deletes the record at the route `:id` |

`Tab` and `Column` have no renderer of their own — their parent consumes them inline.

## Arity, argument and placement gates

Because every emitter reads args by name and by slot index, anything outside the vocabulary above used to vanish silently (while its string still landed in the i18n catalog). Each of these is now an error, proven with `ddd parse`:

```ddd
Stat { "a", 1, Text { "x" } }        // loom.page-primitive-extra-children — Stat takes 2 (label and value)
Card { title: "x", Text { "y" } }    // loom.page-primitive-unknown-arg — Card has no `title:`
Text { "x", style: "red" }           // loom.page-primitive-unknown-arg#style-not-object — style: takes { … }
Stack { Tab { "x", Text { "y" } } }  // loom.sub-primitive-misplaced — Tab only inside Tabs
Stack { Heding { "x" } }             // loom.unknown-page-element (+ loom.unknown-builder-type)
Text { nosuchthing }                 // loom.unresolved-page-ref — no param / state / derived / lambda / store field
Stack { Slot { } }                   // loom.slot-outside-component — in a page body
Image { "/a.png" }                   // loom.a11y-missing-alt — add alt: or decorative: true
Button { icon: "trash" }             // loom.a11y-icon-only-no-name (warning) — add text or label:
Heading { "Order " + n }             // loom.user-visible-concat — use `Order {n}` (translatable ICU)
Stat { "n", rows.count }             // loom.frontend-collection-op-unsupported — compute it server-side
```

`Form { … }`, `scaffoldList { … }`, `Dashboard`, `Review`, `Select`, `Fieldset` are **not** primitives (`loom.unknown-page-element`) — the form family is the four named leaves below, and list/detail pages come from `scaffold` ([15](15-ui-pages-structure.md)).

## Layout & surfaces

```ddd
page LayoutDemo {
  route: "/layout"
  state { editing: bool = false  draftName: string = "" }
  body: Container {
    Grid {
      Group { Avatar { alt: "Product" }, Heading { "Product detail", level: 2 } },
      Card { Stack {
        Field { "Name", bind: draftName },
        Toggle { "Editing", bind: editing },
        Stat { "Price", 1999 },
        Divider {},
        Money { 1999, currency: "USD" },
        KeyValueRow { "Owner", Text { "platform-team" } }
      } }
    },
    testid: "layout-demo"
  }
}
```

Every user-visible literal is wrapped in the generated `t(key, default)` shim (the i18n catalog, `.loom/messages.en.json`); the keys are content hashes.

::: tabs frontend
== react
```tsx
// src/pages/layout_demo.tsx — Mantine
const [editing, setEditing] = useState<boolean>(false);
const [draftName, setDraftName] = useState<string>("");
return (
  <Container data-testid="layout-demo">
    <Grid>
      <Grid.Col span="auto">
        <Group>
          <Avatar alt="Product" />
          <Title order={2}>{t("page.LayoutDemo.heading.8ba34l", "Product detail")}</Title>
        </Group>
      </Grid.Col>
      <Grid.Col span="auto">
        <Card withBorder padding="md">
          <Stack>
            <TextInput label={t("page.LayoutDemo.inputLabel.4el6o6", "Name")} value={draftName} onChange={(e) => setDraftName(e.currentTarget.value)} />
            <Switch label={t("page.LayoutDemo.inputLabel.vkb7an", "Editing")} checked={editing} onChange={(e) => setEditing(e.currentTarget.checked)} />
            <Stack gap={2}>
              <Text size="sm" c="dimmed">{t("page.LayoutDemo.statLabel.pdyg96", "Price")}</Text>
              <Text fw={700} size="xl">{1999}</Text>
            </Stack>
            <Divider />
            <MoneyValue value={ 1999 } currency="USD" />
            <KeyValueRow label={t("page.LayoutDemo.keyValue.71lv90", "Owner")}><Text>{t("page.LayoutDemo.text.uprclg", "platform-team")}</Text></KeyValueRow>
          </Stack>
        </Card>
      </Grid.Col>
    </Grid>
  </Container>
);
```
== vue
```vue
<!-- src/pages/layout_demo.vue — Vuetify; state is `const draftName = ref("")` -->
<v-container data-testid="layout-demo">
  <v-row>
    <v-col>
      <div class="d-flex align-center flex-wrap ga-3"><v-avatar alt="Product"></v-avatar><h2>{{ t("page.LayoutDemo.heading.8ba34l", "Product detail") }}</h2></div>
    </v-col>
    <v-col>
      <v-card variant="outlined" class="pa-4">
        <div class="d-flex flex-column ga-3">
          <v-text-field :label='t("page.LayoutDemo.inputLabel.4el6o6", "Name")' :model-value="draftName" @update:model-value="setDraftName" />
          <v-switch :label='t("page.LayoutDemo.inputLabel.vkb7an", "Editing")' :model-value="editing" @update:model-value="(v) => setEditing(!!v)" />
          <!-- Stat / Divider / Money / KeyValueRow … -->
        </div>
      </v-card>
    </v-col>
  </v-row>
</v-container>
```
== svelte
```svelte
<!-- src/routes/(app)/layout/+page.svelte — shadcnSvelte; state is `let draftName = $state<string>("")` -->
<div class="container mx-auto px-4" data-testid="layout-demo">
  <div class="grid gap-4 grid-cols-3">
    <div class="flex flex-row items-center gap-4"><!-- Avatar --><h2 class="text-2xl font-semibold tracking-tight">{t("page.LayoutDemo.heading.8ba34l", "Product detail")}</h2></div>
    <div class="rounded-xl border bg-card p-6">
      <label class="flex flex-col gap-2"><span class="loom-label">{t("page.LayoutDemo.inputLabel.4el6o6", "Name")}</span><input class="loom-input" value={draftName} oninput={(e) => { draftName = e.currentTarget.value; }} /></label>
      <!-- Toggle / Stat / Divider / Money / KeyValueRow … -->
    </div>
  </div>
</div>
```
== angular
```ts
// src/app/pages/layout-demo.component.ts — Angular Material; state is `readonly draftName = signal("")`
<div class="loom-stack" data-testid="layout-demo">
  <div class="loom-grid">
    <div><div class="loom-group"><!-- Avatar --><h2>{{ t("page.LayoutDemo.heading.8ba34l", "Product detail") }}</h2></div></div>
    <div>
      <mat-card>
        <mat-form-field><mat-label>{{ t("page.LayoutDemo.inputLabel.4el6o6", "Name") }}</mat-label><input matInput [value]="draftName()" (input)="draftName.set($any($event.target).value)" /></mat-form-field>
        <mat-slide-toggle [checked]="editing()" (change)="editing.set($event.checked)">{{ t("page.LayoutDemo.inputLabel.vkb7an", "Editing") }}</mat-slide-toggle>
        <!-- Stat / Divider / Money / KeyValueRow … -->
      </mat-card>
    </div>
  </div>
</div>
```
::: end

The remaining surfaces — `Section`, `Paper`, `Sticky`, `Toolbar`, `Breadcrumbs`, `Tabs`/`Tab`, `Divider { label: }` — from one `Display` page:

```ddd
body: Stack {
  Section { Heading { "Typography", level: 2 }, Text { "Plain text" }, id: "typography" },
  Paper { Alert { "Saved.", title: "Done", color: "green" }, padding: "md" },
  Sticky { Toolbar { Button { "Save", variant: "filled" }, label: "Actions" }, top: 0 },
  Breadcrumbs { Anchor { "Home", to: "/" }, Text { "Display" } },
  Tabs {
    Tab { "Overview", Text { "Overview body" } },
    Tab { "Details", Text { "Details body" } }
  },
  Divider { label: "Formatters" }
}
```

::: tabs frontend
== react
```tsx
<section id="typography">
  <Title order={2}>{t("page.Display.heading.hpgbak", "Typography")}</Title>
  <Text>{t("page.Display.text.f1rqam", "Plain text")}</Text>
</section>
<Paper p="md">
  <Alert color="green" variant="light" title={t("page.Display.alertTitle.3cn9g1", "Done")}>{t("page.Display.alert.cageta", "Saved.")}</Alert>
</Paper>
<Box pos="sticky" top="0" style={{ zIndex: 100 }}>
  <Group justify="space-between" role="toolbar" aria-label={t("page.Display.toolbarAria.rx51qc", "Actions")}>
    <Button variant="subtle">{t("page.Display.button.lewgh4", "Save")}</Button>
  </Group>
</Box>
<Breadcrumbs>
  <Anchor component={RouterLink} to="/">{t("page.Display.anchor.n0mxf2", "Home")}</Anchor>
  <Text>{t("page.Display.text.oz7oad", "Display")}</Text>
</Breadcrumbs>
<Tabs defaultValue="overview">
  <Tabs.List>
    <Tabs.Tab value="overview">{t("page.Display.tabLabel.thnxru", "Overview")}</Tabs.Tab>
    <Tabs.Tab value="details">{t("page.Display.tabLabel.43f6md", "Details")}</Tabs.Tab>
  </Tabs.List>
  <Tabs.Panel value="overview"><Text>{t("page.Display.text.iuvnky", "Overview body")}</Text></Tabs.Panel>
  <Tabs.Panel value="details"><Text>{t("page.Display.text.sbdi7r", "Details body")}</Text></Tabs.Panel>
</Tabs>
<Divider label={t("page.Display.dividerLabel.zfocqq", "Formatters")} labelPosition="center" />
```
== vue
```vue
<section id="typography">
  <h2>{{ t("page.Display.heading.hpgbak", "Typography") }}</h2>
  <div>{{ t("page.Display.text.f1rqam", "Plain text") }}</div>
</section>
<v-card variant="outlined" class="pa-4">
  <v-alert color="green" variant="tonal" :title='t("page.Display.alertTitle.3cn9g1", "Done")'>{{ t("page.Display.alert.cageta", "Saved.") }}</v-alert>
</v-card>
<div style="position: sticky; top: 0; z-index: 100">
  <div class="d-flex align-center justify-space-between ga-3" role="toolbar" :aria-label='t("page.Display.toolbarAria.rx51qc", "Actions")'>
    <v-btn variant="text">{{ t("page.Display.button.lewgh4", "Save") }}</v-btn>
  </div>
</div>
<nav :aria-label='t("pack.vuetify.breadcrumbsLandmark.dfc3fw", "Breadcrumb")' class="loom-breadcrumbs d-flex align-center ga-2 text-body-2 mb-2">
  <router-link to="/">{{ t("page.Display.anchor.n0mxf2", "Home") }}</router-link>
  <div>{{ t("page.Display.text.oz7oad", "Display") }}</div>
</nav>
<div>
  <v-tabs v-model="__loomTab">
    <v-tab value="overview">{{ t("page.Display.tabLabel.thnxru", "Overview") }}</v-tab>
    <v-tab value="details">{{ t("page.Display.tabLabel.43f6md", "Details") }}</v-tab>
  </v-tabs>
  <v-tabs-window v-model="__loomTab">
    <v-tabs-window-item value="overview"><div>{{ t("page.Display.text.iuvnky", "Overview body") }}</div></v-tabs-window-item>
    <v-tabs-window-item value="details"><div>{{ t("page.Display.text.sbdi7r", "Details body") }}</div></v-tabs-window-item>
  </v-tabs-window>
</div>
<v-divider>{{ t("page.Display.dividerLabel.zfocqq", "Formatters") }}</v-divider>
```
== svelte
```svelte
<section id="typography">
  <h2 class="text-2xl font-semibold tracking-tight">{t("page.Display.heading.hpgbak", "Typography")}</h2>
  <p class="text-sm leading-relaxed">{t("page.Display.text.f1rqam", "Plain text")}</p>
</section>
<div class="rounded-lg border bg-card p-4 shadow-sm">
  <div role="alert" class="relative w-full rounded-lg border px-4 py-3 text-sm border-border bg-background"><p class="mb-1 font-medium leading-none tracking-tight">{t("page.Display.alertTitle.3cn9g1", "Done")}</p><div class="text-sm [&_p]:leading-relaxed">{t("page.Display.alert.cageta", "Saved.")}</div></div>
</div>
<div style="position: sticky; top: 0; z-index: 100">
  <div class="flex flex-row items-center justify-between gap-4" role="toolbar" aria-label={t("page.Display.toolbarAria.rx51qc", "Actions")}>
    <button type="button" class="loom-btn loom-btn-ghost">{t("page.Display.button.lewgh4", "Save")}</button>
  </div>
</div>
<nav class="flex items-center gap-2 text-sm text-muted-foreground">
  <a href="/" class="text-primary hover:underline">{t("page.Display.anchor.n0mxf2", "Home")}</a>
  <p class="text-sm leading-relaxed">{t("page.Display.text.oz7oad", "Display")}</p>
</nav>
<Tabs tabs={[{ value: "overview", label: t("page.Display.tabLabel.thnxru", "Overview") }, { value: "details", label: t("page.Display.tabLabel.43f6md", "Details") }]} defaultValue="overview">
  {#snippet body(active)}
  {#if active === "overview" }<p class="text-sm leading-relaxed">{t("page.Display.text.iuvnky", "Overview body")}</p>{/if}
  {#if active === "details" }<p class="text-sm leading-relaxed">{t("page.Display.text.sbdi7r", "Details body")}</p>{/if}
  {/snippet}
</Tabs>
<div class="relative flex items-center py-4"><div class="flex-grow border-t border-border"></div><span class="mx-4 text-sm text-muted-foreground">{t("page.Display.dividerLabel.zfocqq", "Formatters")}</span><div class="flex-grow border-t border-border"></div></div>
```
== angular
```ts
<section id="typography">
  <h2>{{ t("page.Display.heading.hpgbak", "Typography") }}</h2>
  <div>{{ t("page.Display.text.f1rqam", "Plain text") }}</div>
</section>
<div class="loom-paper">
  <div class="loom-alert loom-alert-green" role="alert"><div class="loom-alert-title">{{ t("page.Display.alertTitle.3cn9g1", "Done") }}</div><div class="loom-alert-message">{{ t("page.Display.alert.cageta", "Saved.") }}</div></div>
</div>
<div style="position: sticky; top: 0; z-index: 100">
  <div class="loom-toolbar" role="toolbar" [attr.aria-label]='t("page.Display.toolbarAria.rx51qc", "Actions")'>
    <button mat-button>{{ t("page.Display.button.lewgh4", "Save") }}</button>
  </div>
</div>
<nav class="loom-breadcrumbs">
  <a class="loom-anchor" [routerLink]='"/"'>{{ t("page.Display.anchor.n0mxf2", "Home") }}</a>
  <div>{{ t("page.Display.text.oz7oad", "Display") }}</div>
</nav>
<mat-tab-group>
  <mat-tab [label]='t("page.Display.tabLabel.thnxru", "Overview")'><div>{{ t("page.Display.text.iuvnky", "Overview body") }}</div></mat-tab>
  <mat-tab [label]='t("page.Display.tabLabel.43f6md", "Details")'><div>{{ t("page.Display.text.sbdi7r", "Details body") }}</div></mat-tab>
</mat-tab-group>
<div class="loom-divider-labelled"><mat-divider class="loom-divider-rule"></mat-divider><span class="loom-divider-label">{{ t("page.Display.dividerLabel.zfocqq", "Formatters") }}</span><mat-divider class="loom-divider-rule"></mat-divider></div>
```
::: end

Phoenix renders the same page through the app's function components (`<.card>`, `<.button>`, `<.badge>`, `<.empty>`) and a JS-command tab bar:

```heex
<%!-- lib/lv_web/live/display_live.ex --%>
<section id="typography">
  <h2 class="text-lg font-semibold leading-8 text-zinc-800"><%= pgettext("page.Display.heading.hpgbak", "Typography") %></h2>
  <p><%= pgettext("page.Display.text.f1rqam", "Plain text") %></p>
</section>
<.card>
  <div class="alert alert-success" role="alert"><p class="font-medium"><%= pgettext("page.Display.alertTitle.3cn9g1", "Done") %></p><%= pgettext("page.Display.alert.cageta", "Saved.") %></div>
</.card>
<div style="position: sticky; top: 0; z-index: 100">
  <div class="flex flex-row items-center justify-between gap-4" aria-label={pgettext("page.Display.toolbarAria.rx51qc", "Actions")} role="toolbar">
    <.button variant="filled"><%= pgettext("page.Display.button.lewgh4", "Save") %></.button>
  </div>
</div>
<div class="tabs">
  <div role="tablist" class="tab-bar">
    <button type="button" role="tab" id="tabs-1-tab-overview" class="tab tab-active" phx-click={JS.hide(to: "[data-tabs='tabs-1']") |> JS.show(to: "#tabs-1-panel-overview") |> …}><%= pgettext("page.Display.tabLabel.thnxru", "Overview") %></button>
    …
  </div>
  <div role="tabpanel" id="tabs-1-panel-overview" data-tabs="tabs-1" class="tab-panel">…</div>
</div>
```

Flutter has no HTML — the same tree is a widget tree (`Column` / `Row` / `Card` / `DefaultTabController` + `TabBar`), and Feliz an `Html.div [ prop.className "…"; prop.children [ … ] ]` list against daisyUI classes.

## Text & display

```ddd
Stack {
  Heading { "Typography", level: 2 },
  Text { "Plain text" }, Bold { "Bold text" }, Italic { "Italic text" }, InlineCode { "ddd generate system" },
  Badge { "Beta" },
  Anchor { "Loom docs", to: "/docs" },
  Empty { "Nothing here yet." },
  Skeleton { count: 3 },
  Loader { size: "sm" },
  Icon { name: "check", label: "Verified" },
  Image { "/logo.png", alt: "Acme logo" },
  CodeBlock { "let x = 1", language: "ts", title: "Sample" }
}
```

::: tabs frontend
== react
```tsx
<Title order={2}>{t("page.Display.heading.hpgbak", "Typography")}</Title>
<Text>{t("page.Display.text.f1rqam", "Plain text")}</Text>
<strong>{t("page.Display.bold.cl1gdl", "Bold text")}</strong>
<em>{t("page.Display.italic.f5ts34", "Italic text")}</em>
<code>{t("page.Display.code.wndwjf", "ddd generate system")}</code>
<Badge>{t("page.Display.badge.67jzzb", "Beta")}</Badge>
<Anchor component={RouterLink} to="/docs">{t("page.Display.anchor.dzcdln", "Loom docs")}</Anchor>
<Center mih={200}><Text c="dimmed">{t("page.Display.empty.jije2k", "Nothing here yet.")}</Text></Center>
<Stack gap="xs" aria-hidden="true">
  { Array.from({ length: 3 }).map((_, i) => (<Skeleton key={i} height={ 28 } radius="sm" />)) }
</Stack>
<Loader size="sm" />
<span className="loom-icon" role="img" aria-label={t("page.Display.iconLabel.jnn2zp", "Verified")} dangerouslySetInnerHTML={{ __html: "<svg viewBox=\"0 0 24 24\" …><path d=\"M5 12l4 4L19 7\"/></svg>" }} />
<Image src="/logo.png" alt="Acme logo" />
<div className="loom-code-block">
  <div className="loom-code-block-title">{t("page.Display.codeBlockTitle.pb7tfr", "Sample")}</div>
  <pre><code className="language-ts">let x = 1</code></pre>
</div>
```
== vue
```vue
<h2>{{ t("page.Display.heading.hpgbak", "Typography") }}</h2>
<div>{{ t("page.Display.text.f1rqam", "Plain text") }}</div>
<strong>{{ t("page.Display.bold.cl1gdl", "Bold text") }}</strong>
<em>{{ t("page.Display.italic.f5ts34", "Italic text") }}</em>
<code>{{ t("page.Display.code.wndwjf", "ddd generate system") }}</code>
<v-chip size="small">{{ t("page.Display.badge.67jzzb", "Beta") }}</v-chip>
<router-link to="/docs">{{ t("page.Display.anchor.dzcdln", "Loom docs") }}</router-link>
<div class="d-flex align-center justify-center text-medium-emphasis" style="min-height: 200px">{{ t("page.Display.empty.jije2k", "Nothing here yet.") }}</div>
<div class="d-flex flex-column ga-2" aria-hidden="true"><v-skeleton-loader v-for="__i in 3" :key="__i" type="text" height="28" /></div>
<v-progress-circular indeterminate size="24" />
<span class="loom-icon" role="img" :aria-label='t("page.Display.iconLabel.jnn2zp", "Verified")' v-html='"<svg …>"'></span>
<v-img src="/logo.png" alt="Acme logo" />
```
== svelte
```svelte
<h2 class="text-2xl font-semibold tracking-tight">{t("page.Display.heading.hpgbak", "Typography")}</h2>
<p class="text-sm leading-relaxed">{t("page.Display.text.f1rqam", "Plain text")}</p>
<strong>{t("page.Display.bold.cl1gdl", "Bold text")}</strong>
<em>{t("page.Display.italic.f5ts34", "Italic text")}</em>
<code>{t("page.Display.code.wndwjf", "ddd generate system")}</code>
<span class="inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold">{t("page.Display.badge.67jzzb", "Beta")}</span>
<a href="/docs" class="text-primary hover:underline">{t("page.Display.anchor.dzcdln", "Loom docs")}</a>
<div class="flex min-h-[200px] items-center justify-center"><p class="text-sm text-muted-foreground">{t("page.Display.empty.jije2k", "Nothing here yet.")}</p></div>
<div class="flex flex-col gap-2" aria-hidden="true">{#each Array.from({ length: 3 }) as _unused, i (i)}<div class="h-7 animate-pulse rounded-sm bg-muted"></div>{/each}</div>
<span class="loom-spinner inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" role="status" aria-label={t("chrome.loading", "Loading")}></span>
<span class="loom-icon inline-flex items-center" role="img" aria-label={t("page.Display.iconLabel.jnn2zp", "Verified")}>{@html "<svg …>" }</span>
<img class="rounded-md" src="/logo.png" alt="Acme logo" />
```
== angular
```ts
<h2>{{ t("page.Display.heading.hpgbak", "Typography") }}</h2>
<div>{{ t("page.Display.text.f1rqam", "Plain text") }}</div>
<strong>{{ t("page.Display.bold.cl1gdl", "Bold text") }}</strong>
<em>{{ t("page.Display.italic.f5ts34", "Italic text") }}</em>
<code class="loom-inline-code">{{ t("page.Display.code.wndwjf", "ddd generate system") }}</code>
<span class="loom-badge">{{ t("page.Display.badge.67jzzb", "Beta") }}</span>
<a class="loom-anchor" [routerLink]='"/docs"'>{{ t("page.Display.anchor.dzcdln", "Loom docs") }}</a>
<div class="loom-empty">{{ t("page.Display.empty.jije2k", "Nothing here yet.") }}</div>
<div class="loom-skeleton-group" aria-hidden="true"><div class="loom-skeleton" style="height: 28px"></div>…</div>
<mat-progress-spinner mode="indeterminate" diameter="24"></mat-progress-spinner>
<span class="loom-icon" role="img" [attr.aria-label]='t("page.Display.iconLabel.jnn2zp", "Verified")'><svg …><path d="M5 12l4 4L19 7"/></svg></span>
<img class="loom-image" src="/logo.png" alt="Acme logo" />
```
::: end

```dart
// Flutter — lib/pages/display_page.dart (Material 3 widgets, `t()` from lib/i18n.dart)
Semantics(header: true, child: DefaultTextStyle.merge(style: Theme.of(context).textTheme.titleLarge, child: Text(t('page.Display.heading.hpgbak', 'Typography')))),
Text(t('page.Display.text.f1rqam', 'Plain text')),
DefaultTextStyle.merge(style: const TextStyle(fontWeight: FontWeight.bold), child: Text(t('page.Display.bold.cl1gdl', 'Bold text'))),
Chip(label: Text(t('page.Display.badge.67jzzb', 'Beta')), visualDensity: VisualDensity.compact),
TextButton(onPressed: () => Navigator.of(context).pushNamed('/docs'), child: Text(t('page.Display.anchor.dzcdln', 'Loom docs'))),
Icon(Icons.circle, size: 20.0, semanticLabel: t('page.Display.iconLabel.jnn2zp', 'Verified')),
Image.network("/logo.png", semanticLabel: "Acme logo"),
```

`Anchor { to: }` is a **router link** on every frontend (`RouterLink` / `router-link` / `[routerLink]` / `pushNamed`) — give it an in-app path; an external URL belongs in a `menu` link (`link "Docs" -> "https://…"`, [15](15-ui-pages-structure.md)). `Icon` is decorative (`aria-hidden`) unless `label:` names it, which turns it into a `role="img"` and makes the label a translated slot. On Phoenix `Image { "/logo.png", alt: … }` and `Icon { name: … }` render `<img alt="…" />` with no `src` and an empty `<span class="loom-icon">` — the HEEx renderers read only a named `src:` and only an `svg:` literal (`heex-primitives.ts` `renderImage` / `renderIcon`); spell `Image { src: "…", alt: "…" }` and pass `svg:` there.

## Formatters — `Money`, `DateDisplay`, `EnumBadge`, `IdLink`, `FileLink`, `ProvenanceInfo`, `Timeline`

```ddd
Money { "12.3456" }
Money { "12.3456", currency: "EUR", decimals: 2 }
DateDisplay { "2026-01-02T03:04:05Z" }
EnumBadge { "Public" }
```

`Money` renders the wire's **own digits**, verbatim and locale-neutral — no `Number()` hop, no grouping, no invented currency symbol, no 2-dp truncation (a `NUMERIC(19,4)` value shows its 4th decimal). `decimals: n` re-scales the digit string (half away from zero, never through a float); `currency: "EUR"` prefixes exactly the code you passed. One implementation, `moneyText` in `src/generator/_frontend/money-format.ts`, is spliced into every JS pack's `lib/format` helper.

::: tabs frontend
== react
```tsx
<MoneyValue value={ "12.3456" } />                              // → 12.3456
<MoneyValue value={ "12.3456" } currency="EUR" decimals={ 2 } /> // → EUR 12.35
<DateTimeValue iso={ "2026-01-02T03:04:05Z" } />
<Badge tt="none">{ "Public" }</Badge>
// lib/format.tsx: MoneyValue → moneyText(value, currency, decimals)
```
== vue
```vue
<span>{{ formatMoney("12.3456") }}</span>
<span>{{ formatMoney("12.3456", "EUR", 2) }}</span>
<span>{{ formatDateTime("2026-01-02T03:04:05Z") }}</span>
<v-chip size="small">{{ "Public" }}</v-chip>
```
== svelte
```svelte
<span class="tabular-nums">{formatMoney("12.3456")}</span>
<span class="tabular-nums">{formatMoney("12.3456", "EUR", 2)}</span>
<span title={ "2026-01-02T03:04:05Z" }>{formatDateTime("2026-01-02T03:04:05Z")}</span>
<span class="inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold">{ "Public" }</span>
```
== angular
```ts
<span>{{ formatMoney("12.3456") }}</span>
<span>{{ formatMoney("12.3456", "EUR", 2) }}</span>
<span>{{ formatDateTime("2026-01-02T03:04:05Z") }}</span>
<span class="loom-badge">{{ "Public" }}</span>
```
::: end

```fsharp
// Feliz — the raw string, prefixed only by a declared currency; `decimals:` is ignored
Html.span [ prop.className "tabular-nums"; prop.text (string ("12.3456")) ]
Html.span [ prop.className "tabular-nums"; prop.text ("EUR" + " " + string ("12.3456")) ]
```

```heex
<%!-- Phoenix — verbatim + currency prefix; `decimals:` is ignored --%>
<span class="money"><%= to_string("12.3456") %></span>
<span class="money">EUR <%= to_string("12.3456") %></span>
<time datetime={to_string(@row.created_at)}><%= Calendar.strftime(@row.created_at, "%Y-%m-%d") %></time>
<span class="badge badge-enum">Public</span>
```

Flutter still formats through `intl` (`NumberFormat.decimalPattern()` / `NumberFormat.currency(symbol: 'EUR ')`) rather than the verbatim contract — tracked as M-T1.21.

`IdLink { o.id, of: Product }` renders the short id as a link to the aggregate's detail route (`<RouterLink to={`/products/${row.id}`}><IdValue id={row.id} /></RouterLink>` on React, `shortId(row.id)` in a `router-link` on Vue, `[routerLink]='"/products/" + row.id'` on Angular).

`FileLink { a.attachment }` is a native download anchor over a `File` value (`{ url, key, contentType, size }`), null-guarded for `File?`:

```ddd
page Doc(id: Attachment id) {
  route: "/docs/:id"
  body: QueryView { of: Docs.Attachment.byId(id), single: true,
    data: a => Stack { Heading { a.title, level: 2 }, FileLink { a.attachment } } }
}
```

```tsx
// react
{attachmentById.data.attachment ? (
  <a href={attachmentById.data.attachment.url} download>{attachmentById.data.attachment.key}</a>
) : <span>—</span>}
```

```heex
<%!-- phoenix --%>
<%= if @a.attachment do %><a href={@a.attachment["url"]} download><%= @a.attachment["key"] %></a><% else %><span>—</span><% end %>
```

`ProvenanceInfo { of: p, field: "stock" }` is the "?" disclosure over a `provenanced` field's lineage ([provenance.md](../provenance.md)); it reads the `{ value, lineage }` wire carrier and renders a native `<details>` on the JS frontends and HEEx, an `ExpansionTile` on Flutter, `Html.details` on Feliz:

```ddd
Group { Text { p.stock }, ProvenanceInfo { of: p, field: "stock" } }
```

```tsx
// react — pages/product_detail.tsx
<Text>{productById.data.stock.value}</Text>
{productById.data.stock.lineage != null ? (
  <details className="loom-provenance">
    <summary aria-label="How this value was computed">?</summary>
    <dl className="loom-provenance-tree">
      <div><dt>Rule</dt><dd><code>{productById.data.stock.lineage.snapshotId}</code></dd></div>
      <div><dt>Value</dt><dd>{String(productById.data.stock.lineage.computedValue)}</dd></div>
      {productById.data.stock.lineage.inputs.map((inp) => (
        <div key={inp.path}><dt>{inp.path}</dt><dd>{String(inp.value)}</dd></div>
      ))}
    </dl>
  </details>
) : null}
```

```heex
<%!-- phoenix — reads the co-located jsonb column off the Ecto struct --%>
<%= @p.stock %>
<%= if @p.stock_provenance do %>
  <details class="loom-provenance">
    <dl class="loom-provenance-tree">
      <div><dt>Rule</dt><dd><code><%= @p.stock_provenance["snapshotId"] %></code></dd></div>
      …
```

`Timeline { of: entries }` renders an `audited` aggregate's history — the `AuditEntry[]` a backend serves at `GET /<agg>/{id}/history` — as an ordered list of action / time / actor / field changes. The read is the derived `history(id)` (spelled bare, `Product.history(id)`), which the scaffolded Detail page also emits as its History section:

```ddd
page ProductHistory {
  route: "/products/:id/history"
  body: QueryView {
    of: Product.history(id),
    data: entries => Timeline { of: entries, testid: "product-history" }
  }
}
```

::: tabs frontend
== react
```tsx
const productHistory = useHistoryProduct(id);
// …
<ol className="loom-timeline" data-testid="product-history">
  {(productHistory.data ?? []).map((__e) => (
    <li key={__e.auditId} className="loom-timeline-entry">
      <span className="loom-timeline-action">{__e.action}</span>
      <time dateTime={__e.at}>{new Date(__e.at).toLocaleString()}</time>
      {__e.actor != null ? <span className="loom-timeline-actor">{String(__e.actor)}</span> : null}
      {__e.changes.length > 0 ? (
        <dl className="loom-timeline-changes">
          {__e.changes.map((__c) => (
            <div key={__c.field}><dt>{__c.field}</dt><dd>{String(__c.before ?? "—")} → {String(__c.after ?? "—")}</dd></div>
          ))}
        </dl>
      ) : null}
    </li>
  ))}
</ol>
```
== vue
```vue
<ol class="loom-timeline" data-testid="product-history">
  <li v-for="__e in (productHistory.data ?? [])" :key="__e.auditId" class="loom-timeline-entry">
    <span class="loom-timeline-action">{{ __e.action }}</span>
    <time :datetime="__e.at">{{ new Date(__e.at).toLocaleString() }}</time>
    <span v-if="__e.actor != null" class="loom-timeline-actor">{{ String(__e.actor) }}</span>
    <dl v-if="__e.changes.length > 0" class="loom-timeline-changes">
      <div v-for="__c in __e.changes" :key="__c.field"><dt>{{ __c.field }}</dt><dd>{{ String(__c.before ?? "—") }} → {{ String(__c.after ?? "—") }}</dd></div>
    </dl>
  </li>
</ol>
```
== svelte
```svelte
<ol class="loom-timeline" data-testid="product-history">
  {#each (productHistory.data ?? []) as __e (__e.auditId)}
    <li class="loom-timeline-entry">
      <span class="loom-timeline-action">{__e.action}</span>
      <time datetime={__e.at}>{new Date(__e.at).toLocaleString()}</time>
      {#if __e.actor != null}<span class="loom-timeline-actor">{String(__e.actor)}</span>{/if}
      {#if __e.changes.length > 0}<dl class="loom-timeline-changes">…</dl>{/if}
    </li>
  {/each}
</ol>
```
== angular
```ts
<ol class="loom-timeline" data-testid="product-history">
  @for (__e of (productHistory.data() ?? []); track __e.auditId) {
    <li class="loom-timeline-entry">
      <span class="loom-timeline-action">{{ __e.action }}</span>
      <time [attr.datetime]="__e.at">{{ __e.at }}</time>
      @if (__e.actor != null) { <span class="loom-timeline-actor">{{ $any(__e.actor) }}</span> }
      @if (__e.changes.length > 0) { <dl class="loom-timeline-changes">…</dl> }
    </li>
  }
</ol>
```
::: end

```heex
<%!-- phoenix — the page loads the trail itself in handle_params/3 --%>
defp load_product_history(_socket, id) do
  case Lv.Shop.get_product(id) do
    {:ok, _record} -> Lv.Audit.History.for_target(Lv.Repo, "Product", id) |> Enum.map(&product_audit_entry/1)
    _ -> :error
  end
end
…
<ol class="loom-timeline" data-testid="product-history">
  <%= for e <- @product_history || [] do %>
    <li class="loom-timeline-entry">
      <span class="loom-timeline-action"><%= e["action"] %></span>
      <time datetime={to_string(e["at"])}><%= e["at"] %></time>
```

Feliz (`Html.orderedList … (productHistory |> List.map (fun (__e: AuditEntry) -> …))`) and Flutter (`...productHistory.map((e) => Padding(… Text(e.action) …))`) render the same list from their decoded `AuditEntry` records.

## Inputs — `Field`, `NumberField`, `PasswordField`, `MultilineField`, `SelectField`, `Toggle`, `FileUpload`

Each is a **controlled** input bound to a `state` field through `bind:`; `error:` is any expression rendered in the pack's inline error slot (an empty string means no error), and because it is walked in page scope it can read `derived` values — the idiom for client-only validation ([page-metamodel.md §8.2](../page-metamodel.md)). `FileUpload` must bind a `File` state field (`loom.file-upload-not-file-field`); it uploads to the api's `/files` endpoint and writes the returned `FileRef` back.

```ddd
page Inputs {
  route: "/inputs"
  state { name: string = ""  qty: int = 0  pw: string = ""  bio: string = ""  vis: string = ""  notify: bool = false  doc: File }
  derived pwOk: bool = pw.length >= 8
  body: Stack {
    Field { "Name", bind: name },
    NumberField { "Quantity", bind: qty },
    PasswordField { "Password", bind: pw, error: pwOk ? "" : "At least 8 characters" },
    MultilineField { "Bio", bind: bio },
    SelectField { "Visibility", bind: vis, options: ["Private", "Internal", "Public"] },
    Toggle { "Notifications", bind: notify },
    FileUpload { "Attachment", bind: doc }
  }
}
```

::: tabs frontend
== react
```tsx
const [name, setName] = useState<string>("");
const [qty, setQty] = useState<number>(0);
const [pw, setPw] = useState<string>("");
// …
const pwOk = useMemo(() => (pw.length >= 8), [pw]);
return (
  <Stack>
    <TextInput label={t("page.Inputs.inputLabel.4el6o6", "Name")} value={name} onChange={(e) => setName(e.currentTarget.value)} />
    <NumberInput label={t("page.Inputs.inputLabel.c75rso", "Quantity")} value={qty} onChange={(v) => setQty(typeof v === "number" ? v : 0)} />
    <PasswordInput label={t("page.Inputs.inputLabel.cf437c", "Password")} value={pw} onChange={(e) => setPw(e.currentTarget.value)} error={ (pwOk ? "" : "At least 8 characters") } />
    <Textarea label={t("page.Inputs.inputLabel.hi07w1", "Bio")} value={bio} onChange={(e) => setBio(e.currentTarget.value)} />
    <Select label={t("page.Inputs.inputLabel.la143p", "Visibility")} data={ ["Private", "Internal", "Public"] } value={vis} onChange={(v) => setVis(v ?? "")} />
    <Switch label={t("page.Inputs.inputLabel.fki4un", "Notifications")} checked={notify} onChange={(e) => setNotify(e.currentTarget.checked)} />
    <FileInput label={t("page.Inputs.inputLabel.417wqw", "Attachment")} clearable placeholder={ doc?.key ?? t("pack.mantine.chooseFile.ymjjdi", "Choose file") } onChange={async (f) => { if (!f) { setDoc(null); return; } const fd = new FormData(); fd.append("file", f); setDoc(await api.upload("/files", fd)); }} />
  </Stack>
);
```
== angular
```ts
readonly doc = signal<FileRef | null>(null);
// …
<label class="loom-field"><span class="loom-label">{{ t("page.Inputs.inputLabel.417wqw", "Attachment") }}</span><input type="file" (change)="onFileUploadTo($event, doc)" /></label>
// onFileUploadTo: sig.set(await api.uploadFile(file));
```
::: end

```heex
<%!-- phoenix — each input writes its state field back through a hoisted handle_event;
      FileUpload becomes allow_upload/3 + a progress callback --%>
<.input type="text" name="name" value={@name} label={pgettext("page.Inputs.inputLabel.4el6o6", "Name")} phx-change="update_name" />
<.input type="number" name="qty" value={@qty} label={pgettext("page.Inputs.inputLabel.c75rso", "Quantity")} phx-change="update_qty" />
<.input type="password" name="pw" value={@pw} label={pgettext("page.Inputs.inputLabel.cf437c", "Password")} phx-change="update_pw" />
<.input type="textarea" name="bio" value={@bio} label={pgettext("page.Inputs.inputLabel.hi07w1", "Bio")} phx-change="update_bio" />
```

```dart
// flutter — FileUpload picks with file_picker and POSTs a multipart request to /files
OutlinedButton.icon(icon: const Icon(Icons.upload_file), label: Text(t('page.Inputs.inputLabel.417wqw', 'Attachment')),
  onPressed: () async { final picked = await FilePicker.platform.pickFiles(withData: true); … setDoc(FileRef.fromJson(jsonDecode(resp.body) as Map<String, dynamic>)); }),
```

The inputs carry the `labelled: "associate"` a11y contract — every pack renders a real `<label>` association (Mantine's `label=`, a `<label>` wrapper on shadcn/Svelte, `<mat-label>` on Angular Material).

## Design-pack divergence (`pack`)

The same React page under two packs. Mantine ships named components from `@mantine/core`; shadcn ships `<Input>` + `<Label>` from `@/components/ui/*` with Tailwind utility classes. The walker tree is identical — only the leaf rendering differs.

::: tabs pack
== mantine
```tsx
<Card withBorder padding="md">
  <Stack>
    <TextInput label={t("page.LayoutDemo.inputLabel.4el6o6", "Name")} value={draftName} onChange={(e) => setDraftName(e.currentTarget.value)} />
    <Switch label={t("page.LayoutDemo.inputLabel.vkb7an", "Editing")} checked={editing} onChange={(e) => setEditing(e.currentTarget.checked)} />
    <Divider />
  </Stack>
</Card>
// import { Card, Divider, Stack, Switch, TextInput } from "@mantine/core";
```
== shadcn
```tsx
<Card>
  <CardContent><div className="flex flex-col gap-4">
    <div className="flex flex-col gap-2"><Label>{t("page.LayoutDemo.inputLabel.4el6o6", "Name")}</Label><Input value={draftName} onChange={(e) => setDraftName(e.currentTarget.value)} /></div>
    <div className="flex items-center gap-2"><Switch checked={editing} onCheckedChange={(v) => setEditing(v)} /><Label>{t("page.LayoutDemo.inputLabel.vkb7an", "Editing")}</Label></div>
    <hr className="border-border" />
  </div></CardContent>
</Card>
// import { Card, CardContent } from "@/components/ui/card";
// import { Input } from "@/components/ui/input"; import { Label } from "@/components/ui/label";
```
::: end

Pack inventory: `ls designs/` — React `mantine` (v7/v9), `shadcn` (v3/v4), `mui` (v5/v7), `chakra` (v2/v3); Vue `vuetify`, `shadcnVue`; Svelte `shadcnSvelte`, `flowbite`; Angular `angularMaterial`, `primeng`, `spartanNg`; HEEx `coreComponents`, `daisyui`. Feliz (daisyUI) and Flutter (Material 3) are procedural packs with no `.hbs` layer ([design-packs.md](../design-packs.md)).

## `Chart` — grouped-projection series (every frontend)

A `Chart` plots a **grouped** query-time projection (`group by`) as a line or bar series. `kind:` is `"line"` or `"bar"` (kind-discriminated — there is no `LineChart`; `loom.chart-kind-invalid` otherwise), `of:` names the projection through an api handle, `x:`/`y:` are plain accessor lambdas over the declared row (`loom.chart-accessor-not-field`); a singleton projection has one row and nothing to chart (`loom.chart-of-not-grouped`).

```ddd
projection SalesByVisibility {
  visibility: Visibility
  productCount: int
  revenue: money
  from Product as p
  group by p.visibility
  select visibility = p.visibility, productCount = count(), revenue = sum(p.price)
}
// …
page Dash { route: "/dash"
  body: Chart { kind: "bar", of: Shop.SalesByVisibility, x: r => r.visibility, y: r => r.revenue } }
```

```tsx
// react (mantine) — the projection hook is hoisted like any read; the series is
// coerced with Number(): a money field parses into a Decimal, which no chart library plots
const salesByVisibility = useSalesByVisibility();
// …
<div role="img" aria-label="Bar chart of SalesByVisibility: revenue by visibility">
  <BarChart data={ (salesByVisibility.data ?? []).map((r) => ({ visibility: r.visibility, revenue: Number(r.revenue) })) } dataKey="visibility" series={[{ name: "revenue" }]} h={300} withLegend />
</div>
```

```heex
<%!-- phoenix — rows are already a server assign; LoomChart draws inline SVG, no JS --%>
defp load_sales_by_visibility(socket) do
  Lv.Shop.QueryProjections.SalesByVisibility.run(current_user)
  |> Enum.map(fn row -> %{visibility: row.visibility, product_count: row.productCount, revenue: row.revenue} end)
end
…
<LvWeb.Components.LoomChart.chart kind="bar" rows={@sales_by_visibility} x={:visibility} y={:revenue} label="Bar chart of SalesByVisibility: revenue by visibility" />
```

```fsharp
// feliz — View.chart draws inline SVG from the decoded list
(View.chart true "Bar chart of SalesByVisibility: revenue by visibility" model.SalesByVisibility (fun r -> string r.visibility) (fun r -> float r.revenue))
```

```dart
// flutter — LoomChart is a CustomPainter in lib/chart.dart
LoomChart(isBar: true, label: "Bar chart of SalesByVisibility: revenue by visibility",
  points: (salesByVisibilityRead.asData?.value ?? const []).map((r) => LoomChartPoint(r.visibility.toString(), (r.revenue as num).toDouble())).toList()),
```

All targets carry the same a11y contract — `role="img"` (`Semantics(image: true)` on Flutter) with the derived accessible name. The eight React packs each ship a `primitive-chart` template binding their own library (`@mantine/charts`, `@mui/x-charts`, recharts for shadcn/chakra), pulled into `package.json` only when a page charts; Vue, Svelte and Angular render a generated dependency-free `LoomChart` component from one `primitive-chart.hbs` in the framework's shared template layer (`vue/`, `sveltekit/`, `angular/`). `loom.chart-unsupported-target` names no shipping frontend today — it is the seam a new frontend gates on.

## The form family — `CreateForm`, `OperationForm`, `WorkflowForm`, `DestroyForm`

`CreateForm { of: <Aggregate> }` introspects the aggregate's create input and emits one input per field, dispatched by type: `string` → text, `enum` → select, `bool` → switch, `int` → integer input, `money` → a decimal text input holding a `Decimal`, `datetime` → `datetime-local`, `File` → file input, `X id` → a picker over the target's `derived display`. The shell wires the submit to the `create` mutation with zod validation, a success toast, a redirect to the new record, and RFC-7807 field-error mapping. Extra arguments are gated: `fields:` is not a knob (`loom.page-primitive-unknown-arg`), and a hand-written create request is checked field by field (`loom.create-unknown-field`, `loom.create-server-field`, `loom.create-field-type`).

```ddd
page ProductNew {
  route: "/products/new"
  body: Stack {
    Heading { "Create product", level: 2 },
    Card { CreateForm { of: Product, testid: "products-new" } }
  }
}
```

For `aggregate Product { name: string  visibility: Visibility  active: bool  price: money  createdAt: datetime  stock: int }`:

::: tabs frontend
== react
```tsx
const create = useCreateProduct();
const { register, handleSubmit, setError, control, formState: { errors } } = useForm<CreateProductFormState, unknown, CreateProductRequest>({
  resolver: zodResolver(CreateProductRequest),
  defaultValues: { name: "", visibility: "Private", active: false, price: new Decimal("0"), createdAt: "", stock: 0 },
});
// …
<form onSubmit={handleSubmit(async (vals) => {
  try {
    const out = await create.mutateAsync(vals);
    notifications.show({ color: "green", message: "Product created" });
    navigate(`/products/${out.id}`);
  } catch (e) {
    const outcome = applyServerErrors({ error: e, setError, fieldMap: {} as const });
    // … global / unhandled → red notification
  }
})} data-testid="products-new">
  <Stack gap="md">
    <TextInput label="Name" {...register("name")} data-testid="products-new-input-name" error={errors.name?.message} />
    <Controller control={control} name="visibility" render={({ field, fieldState }) => (
      <Select label="Visibility" data={ ["Private","Internal","Public"] } allowDeselect={false} value={field.value as string} onChange={(v) => field.onChange(v)} error={fieldState.error?.message} />
    )} />
    <Controller control={control} name="active" render={({ field, fieldState }) => (
      <Switch label="Active" checked={!!field.value} onChange={(e) => field.onChange(e.currentTarget.checked)} error={fieldState.error?.message} />
    )} />
    <Controller control={control} name="price" render={({ field, fieldState }) => (
      <TextInput label="Price" value={field.value instanceof Decimal ? field.value.toString() : String(field.value ?? "0")} onChange={(e) => { try { field.onChange(new Decimal(e.currentTarget.value || "0")); } catch { field.onChange(new Decimal("0")); } }} inputMode="decimal" error={fieldState.error?.message} />
    )} />
    <TextInput label="Created At" {...register("createdAt")} type="datetime-local" error={errors.createdAt?.message} />
    <Controller control={control} name="stock" render={({ field, fieldState }) => (
      <NumberInput label="Stock" allowDecimal={false} value={field.value as number | "" | undefined} onChange={(v) => field.onChange(typeof v === "number" ? v : Number(v) || 0)} error={fieldState.error?.message} />
    )} />
    <Group justify="flex-end" mt="sm">
      <Button type="submit" loading={ create.isPending } data-testid="products-new-submit">Create</Button>
    </Group>
  </Stack>
</form>
```
== vue
```vue
<!-- a useLoomForm composable drives the same field set -->
const form = useLoomForm(CreateProductRequest, { name: "", visibility: "Private", active: false, price: new Decimal("0"), createdAt: "", stock: 0 });
// …
<v-form @submit.prevent='form.handleSubmit(async (vals) => { const out = await create.mutateAsync(vals); pushToast("Product created"); navigate(`/products/${out.id}`); })($event)' data-testid="products-new">
  <v-text-field label="Name" v-model="form.values.name" :error-messages='form.errors["name"]' />
  <v-select label="Visibility" :items='["Private","Internal","Public"]' v-model="form.values.visibility" :error-messages='form.errors["visibility"]' />
  <v-switch label="Active" v-model="form.values.active" :error-messages='form.errors["active"]' />
  <v-text-field label="Price" inputmode="decimal" :model-value="String(form.values.price ?? '0')" @update:model-value="(v) => form.values.price = String(v || '0')" :error-messages='form.errors["price"]' />
  <v-text-field label="Created At" v-model="form.values.createdAt" type="datetime-local" :error-messages='form.errors["createdAt"]' />
  <v-text-field label="Stock" type="number" step="1" :model-value="form.values.stock" @update:model-value="(v) => form.values.stock = Math.trunc(Number(v)) || 0" :error-messages='form.errors["stock"]' />
  <v-btn type="submit" color="primary" variant="flat" :loading="create.isPending">Create</v-btn>
</v-form>
```
::: end

```heex
<%!-- phoenix — a changeset-backed <.simple_form> --%>
socket |> assign(:form, Lv.Shop.change_product(%Lv.Shop.Product{}) |> to_form())
…
<.simple_form for={@form} phx-submit="save_product" data-testid="products-new">
```

`OperationForm { p.archive }` (the instance spelling — `p` is a loaded record) renders the operation's parameter set as a form; it is usually hosted in a `Modal` behind a trigger button, which is exactly what the scaffold's Detail page emits per public operation:

```ddd
data: p => Modal { trigger: Button { "Archive…" }, title: "Archive product", OperationForm { p.archive } }
```

```tsx
// react — the form is hoisted to module scope and opened through @mantine/modals
function openArchiveModal(mut: ReturnType<typeof useArchiveProduct>): void {
  modals.open({ title: t("page.ProductDetail.modalTitle.umy5vy", "Archive product"),
    children: <ArchiveForm mut={mut} onClose={() => modals.closeAll()} /> });
}
// …
<Button variant="filled" onClick={() => openArchiveModal(archive)}>{t("page.ProductDetail.button.v0v5o9", "Archive…")}</Button>
```

```heex
<.button phx-click={show_modal("product-op-archive-modal")}><%= pgettext("page.ProductDetail.button.v0v5o9", "Archive…") %></.button>
<.modal id="product-op-archive-modal">
  <:title><%= pgettext("page.ProductDetail.modalTitle.umy5vy", "Archive product") %></:title>
  <.simple_form for={@archive_form} phx-change="validate_archive" phx-submit="submit_archive">
```

```dart
// flutter — showDialog around the generated ArchiveProductForm
ElevatedButton(onPressed: () => showDialog(context: context, builder: (dialogContext) => AlertDialog(title: Text(t('page.ProductDetail.modalTitle.umy5vy', 'Archive product')), content: SizedBox(width: double.maxFinite, child: SingleChildScrollView(child: ArchiveProductForm(id: id))))), child: Text(t('page.ProductDetail.button.v0v5o9', 'Archive…'))),
```

The op-form spelling `OperationForm { of: Product, op: archive }` names no record, so it targets the page's `:id` route param — on a route without one it is rejected (`loom.op-form-needs-route-id`). A `Modal` has two shapes that do not combine everywhere: the **trigger** shape above, and the **state-controlled** shape `Modal { …children, open: <stateBool> }` (a children container, dialog title via `title:`). Putting an `OperationForm` inside the controlled shape is an error on React, Vue, Svelte and Flutter (`loom.modal-controlled-op-form-unsupported`); an extra positional next to the op form is `loom.page-primitive-extra-children#modal-op-form`. `WorkflowForm { runs: <wf> }` and `DestroyForm { of: <Aggregate>, then: navigate(Page) }` follow the create shape over a workflow start / the aggregate's canonical destroy ([page-metamodel.md §9](../page-metamodel.md), [13-workflows](13-workflows.md)). `DestroyForm` names the **aggregate**, never a loaded record — it deletes the record at the page's `:id` route param, confirms through the pack's dialog, and navigates to `then:` (default: the aggregate's list route). It needs a canonical `destroy { }` (`with crudish` gives one). Spelling `of: p` over a `QueryView` binding is **not** rejected today — it degrades to a `DestroyForm(of: p): aggregate not found` comment on every target.

```ddd
workflow registerProduct {
  create(name: string) { let p = Product.create({ name: name, price: 0.0 }) }
}
// …
page ProductNew { route: "/products/register" body: WorkflowForm { runs: registerProduct, testid: "register" } }
page ProductDetail(id: Product id) {
  route: "/products/:id"
  body: QueryView { of: Shop.Product.byId(id), single: true,
    data: p => Stack { Heading { p.name, level: 2 }, DestroyForm { of: Product, then: navigate(Home) } } }
}
```

```tsx
// react — pages/product_new.tsx: the workflow's create(…) params are the field set
const run = useRegisterProductWorkflow();
<form onSubmit={handleSubmit(async (vals) => {
  await run.mutateAsync(vals);
  notifications.show({ color: "green", message: "Register Product completed" });
  navigate("/workflows");
})} data-testid="register">
  <TextInput label="Name" {...register("name")} data-testid="register-input-name" error={errors.name?.message} />
  <Button type="submit" loading={ run.isPending } data-testid="register-submit">Run</Button>

// react — pages/product_detail.tsx: DestroyForm is one confirm-then-delete button
const deleteProduct = useDeleteProduct();
<Button onClick={() => { if (window.confirm(t("chrome.deleteConfirm", "Delete this {entity}?", { entity: "product" }))) void deleteProduct.mutateAsync(id ?? "").then(() => { navigate("/"); }); }}
  loading={deleteProduct.isPending} data-testid="products-destroy">{t("chrome.deleteEntity", "Delete {entity}", { entity: "Product" })}</Button>
```

```heex
<%!-- phoenix — product_new_live.ex.  The HEEx workflow form ships a single
      `_placeholder` input instead of the create(…) params (heex-primitives.ts:388) --%>
<.simple_form for={@form} phx-submit="run_register_product" data-testid="register">
  <.input field={@form[:_placeholder]} label="Field" />
  <:actions><.button type="submit" data-testid="register-submit">Submit</.button></:actions>
</.simple_form>

<%!-- product_detail_live.ex --%>
def handle_event("destroy_product", %{"id" => id}, socket) do
  Lv.Shop.destroy_product!(id)
  {:noreply, socket |> put_flash(:info, "Delete succeeded") |> push_navigate(to: ~p"/products")}
end
…
<.button phx-click="destroy_product" phx-value-id={@id} data-confirm="Delete this product? This cannot be undone." class="btn-danger">Delete Product</.button>
```

## `QueryView` — async data branching

`QueryView { of:, loading:, error:, empty:, data: rows => … }` reads a query — `<api>.<Agg>.all`, `.byId(id)`, a declared `find`, a projection — and renders one of four arms by state. `single: true` marks a one-record read (derived anyway from `byId` / a `T?` find); `paged: true` binds the **envelope** instead of the rows (§9.2 of [page-metamodel.md](../page-metamodel.md)). Because `.all` is paged by default, the simplest table over it is rewritten at the macro layer into the scaffold's server-paged shape — `pageNum` / `sortKey` / `sortDir` state, the args threaded into the hook, sortable headers, a pager — so `unfold` ejects real source:

```ddd
page Products {
  route: "/products"
  body: QueryView {
    of: Shop.Product.all,
    loading: Skeleton { count: 5 },
    error: Alert { "Couldn't load products" },
    empty: Empty { "No products yet." },
    data: rows => Paper { Table {
      rows: rows, striped: true,
      Column { "ID", o => IdLink { o.id, of: Product } },
      Column { "Name", o => Text { o.name } },
      Column { "Visibility", o => EnumBadge { o.visibility } },
      Column { "Price", o => Money { o.price, currency: "USD" } },
      Column { "Created", o => DateDisplay { o.createdAt } }
    } }
  }
}
```

::: tabs frontend
== react
```tsx
const [pageNum, setPageNum] = useState<number>(1);
const [sortKey, setSortKey] = useState<string>("");
const [sortDir, setSortDir] = useState<string>("asc");
const productAll = useAllProducts({ page: pageNum, pageSize: 20, sort: sortKey, dir: sortDir });
return (
  <>
    { productAll.isLoading && (<Stack gap="xs" aria-hidden="true">{ /* 5 × <Skeleton/> */ }</Stack>) }
    { productAll.isError && (<Alert color="red" variant="light">{t("page.Products.alert.qx0ntz", "Couldn't load products")}</Alert>) }
    { productAll.data && productAll.data.items.length === 0 && (
      <Center mih={200}><Text c="dimmed">{t("page.Products.empty.nnvlb2", "No products yet.")}</Text></Center>
    ) }
    { productAll.data && productAll.data.items.length > 0 && (
      <Paper p="md">
        <><Table striped>
          <Table.Thead><Table.Tr>
            <Table.Th><button type="button" onClick={() => { /* toggle sortKey/sortDir for "id" */ }}>{t("page.Products.columnHeader.o4495s", "ID")}{sortKey === "id" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button></Table.Th>
            {/* … one sortable header per column */}
          </Table.Tr></Table.Thead>
          <Table.Tbody>
            { productAll.data.items.map((row) => (
              <Table.Tr key={ row.id }>
                <Table.Td><RouterLink to={`/products/${ row.id }`}><IdValue id={ row.id } /></RouterLink></Table.Td>
                <Table.Td><Text>{row.name}</Text></Table.Td>
                <Table.Td><Badge tt="none">{ row.visibility }</Badge></Table.Td>
                <Table.Td><MoneyValue value={ row.price } currency="USD" /></Table.Td>
                <Table.Td><DateTimeValue iso={ row.createdAt } /></Table.Td>
              </Table.Tr>
            )) }
          </Table.Tbody>
        </Table>
        <div data-testid="pager"><button type="button" disabled={pageNum <= 1} onClick={() => setPageNum(pageNum - 1)}>{t("chrome.prev", "Prev")}</button><span>{t("chrome.pageOf", "Page {page} of {pages}", { page: pageNum, pages: Math.max(1, productAll.data.totalPages) })}</span><button type="button" disabled={pageNum >= Math.max(1, productAll.data.totalPages)} onClick={() => setPageNum(pageNum + 1)}>{t("chrome.next", "Next")}</button></div></>
      </Paper>
    ) }
  </>
);
```
== vue
```vue
const productAll = reactive(useAllProducts(() => ({ page: pageNum.value, pageSize: 20, sort: sortKey.value, dir: sortDir.value })));
// …
<div>
  <template v-if="productAll.isLoading">…skeleton…</template>
  <template v-if="productAll.isError"><v-alert color="red" variant="tonal">{{ t("page.Products.alert.qx0ntz", "Couldn't load products") }}</v-alert></template>
  <template v-if="productAll.data && productAll.data.items.length === 0">
    <div class="d-flex align-center justify-center text-medium-emphasis" style="min-height: 200px">{{ t("page.Products.empty.nnvlb2", "No products yet.") }}</div>
  </template>
  <template v-if="productAll.data && productAll.data.items.length > 0">
    <v-card variant="outlined" class="pa-4"><v-table striped="even">
      <thead><tr><th><button type="button" @click="sortKey === 'id' ? (sortDir = sortDir === 'asc' ? 'desc' : 'asc') : (sortKey = 'id', sortDir = 'asc')">{{ t("page.Products.columnHeader.o4495s", "ID") }}…</button></th><!-- … --></tr></thead>
      <tbody>
        <tr v-for="(row) in productAll.data.items" :key="row.id">
          <td><router-link :to="`/products/${ row.id }`" :title="row.id">{{ shortId(row.id) }}</router-link></td>
          <td><div>{{ row.name }}</div></td>
          <td><v-chip size="small">{{ row.visibility }}</v-chip></td>
          <td><span>{{ formatMoney(row.price, "USD") }}</span></td>
          <td><span>{{ formatDateTime(row.createdAt) }}</span></td>
        </tr>
      </tbody>
    </v-table><!-- pager --></v-card>
  </template>
</div>
```
== svelte
```svelte
const productAll = useAllProducts(() => ({ page: pageNum, pageSize: 20, sort: sortKey, dir: sortDir }));
// …
{#if productAll.isLoading}
    …skeleton…
  {:else if productAll.isError}
    <div role="alert" class="…">{t("page.Products.alert.qx0ntz", "Couldn't load products")}</div>
  {:else if (productAll.data?.items ?? []).length === 0}
    <div class="flex min-h-[200px] items-center justify-center"><p class="text-sm text-muted-foreground">{t("page.Products.empty.nnvlb2", "No products yet.")}</p></div>
  {:else if productAll.data}
    <div class="rounded-lg border bg-card p-4 shadow-sm">
      <div class="w-full overflow-auto"><table class="w-full caption-bottom text-sm">
        <tbody>
          {#each (productAll.data.items ?? []) as row (row.id)}
            <tr class="border-b transition-colors hover:bg-muted/50">
              <td class="p-2 align-middle"><a href={`/products/${ row.id }`} class="text-primary hover:underline"><code title={ row.id }>{formatId(row.id)}</code></a></td>
              <td class="p-2 align-middle"><p class="text-sm leading-relaxed">{row.name}</p></td>
              <td class="p-2 align-middle"><span class="…">{ row.visibility }</span></td>
              <td class="p-2 align-middle"><span class="tabular-nums">{formatMoney(row.price, "USD")}</span></td>
              <td class="p-2 align-middle"><span title={ row.createdAt }>{formatDateTime(row.createdAt)}</span></td>
            </tr>
          {/each}
        </tbody>
      </table></div>
      <!-- pager -->
    </div>
{/if}
```
== angular
```ts
readonly productAll = useAllProducts(() => ({ page: this.pageNum(), pageSize: 20, sort: this.sortKey(), dir: this.sortDir() }));
// …
@if (productAll.isLoading()) { …skeleton… }
@if (productAll.isError()) { <div class="loom-alert loom-alert-red" role="alert"><div class="loom-alert-message">{{ t("page.Products.alert.qx0ntz", "Couldn't load products") }}</div></div> }
@if (!productAll.isLoading() && !productAll.isError() && (productAll.data()?.items ?? []).length === 0) {
  <div class="loom-empty">{{ t("page.Products.empty.nnvlb2", "No products yet.") }}</div>
}
@if ((productAll.data()?.items ?? []).length > 0) {
  <div class="loom-paper">
    <table class="loom-table loom-table-striped">
      <tbody>
        @for (row of productAll.data()!.items; track row.id) {
          <tr><td><a class="loom-anchor" [routerLink]='"/products/" + row.id'>{{ shortId(row.id) }}</a></td>
              <td><div>{{ row.name }}</div></td><td><span class="loom-badge">{{ row.visibility }}</span></td>
              <td><span>{{ formatMoney(row.price, "USD") }}</span></td><td><span>{{ formatDateTime(row.createdAt) }}</span></td></tr>
        }
      </tbody>
    </table>
    <!-- pager -->
  </div>
}
```
::: end

React renders four short-circuit expressions; Vue sibling `<template v-if>`s; Svelte one `{#if}/{:else if}` chain; Angular `@if` blocks over signals. Phoenix loads the page in `handle_params/3` (`Lv.Shop.list_products(page_num, 20, sort_key, sort_dir)`) and re-queries on `"loom-sort"` / `"loom-page"` events; Flutter wraps a Riverpod `FutureProvider` in `AsyncValue.when(loading/error/data)`; Feliz decodes into a `Remote<'T list>` Model field. A `QueryView` over a projection is only admitted for an unkeyed query-time projection (`loom.ui-projection-read-unsupported`).

## `Table`, `Column` and `DataGrid`

`Table { rows:, …Column }` is the portable grid: single-column sort (`Column { …, sortable: true, field: "name" }`), server or client paging (`page:` / `pageSize:` / `serverPaged:` / `totalPages:`), and one client-side substring `filter: <stateField>`. The filter renders on the six `walkBody` frontends only (`loom.table-filter-unsupported` on Phoenix) and only on a client-paged table — on a server-paged one it would narrow the current page rather than the result set (`loom.table-filter-server-paged`); note the auto-paged rewrite above makes a bare `Table { rows: rows, filter: q }` over `.all` server-paged.

`DataGrid` swaps the hand-rolled controls for a TanStack Table row model — multi-column sort, per-column filters, column visibility, client pagination, optional row selection — and is emitted as a hoisted child component (`<CustomersGrid rows={…} />`):

```ddd
state { picked: string[] }
// …
QueryView { of: Sales.Customer.all, data: rows => DataGrid {
  Column { "Name", o => o.name, sortable: true, filterable: true },
  Column { "Tier", o => o.tier, sortable: true },
  rows: rows, selection: picked, multiSort: true, columnVisibility: true, pageSize: 25, testid: "customers-grid" } }
```

`selection:` must name a `string[]` field of the page's `state` (`loom.datagrid-selection-not-state`, `loom.datagrid-selection-not-array`). It ships on react, vue, svelte, angular and feliz; Phoenix (no client row model) and Flutter (no JS runtime) reject it with `loom.datagrid-unsupported-target` — use `Table`, whose sort and paging are server-driven there. The 15 JS packs each ship a `primitive-data-grid.hbs` for the chrome. Full design notes: [page-metamodel.md §9.1](../page-metamodel.md).

## `For` — list comprehension

`For { each: <coll>, empty?: <markup>, <item> => <markup> }` emits the item lambda once per element; it is a child primitive (nest it in a container). The optional `empty:` arm renders when the collection is empty. The item can be used bare (`Badge { tag }`) or through member access.

```ddd
Stack {
  For { each: ["alpha", "beta"], empty: Empty { "No tags" }, tag => Badge { tag } }
}
```

::: tabs frontend
== react
```tsx
<>{["alpha", "beta"].length === 0 ? (
  <Center mih={200}><Text c="dimmed">{t("page.Lists.empty.8e7r1j", "No tags")}</Text></Center>
) : (
  ["alpha", "beta"].map((tag, tagIdx) => (
  <Fragment key={tagIdx}>
    <Badge>{tag}</Badge>
  </Fragment>
))
)}</>
```
== vue
```vue
<template v-for='(tag, tagIdx) in ["alpha", "beta"]' :key="tagIdx">
  <v-chip size="small">{{ tag }}</v-chip>
</template>
<template v-if='!["alpha", "beta"].length'>
  <div class="d-flex align-center justify-center text-medium-emphasis" style="min-height: 200px">{{ t("page.Lists.empty.8e7r1j", "No tags") }}</div>
</template>
```
== svelte
```svelte
{#each ["alpha", "beta"] as tag, tagIdx (tagIdx)}
  <span class="inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold">{tag}</span>
{:else}
  <div class="flex min-h-[200px] items-center justify-center"><p class="text-sm text-muted-foreground">{t("page.Lists.empty.8e7r1j", "No tags")}</p></div>
{/each}
```
== angular
```ts
@for (tag of ["alpha", "beta"]; track $index) {
  <span class="loom-badge">{{ tag }}</span>
} @empty {
  <div class="loom-empty">{{ t("page.Lists.empty.8e7r1j", "No tags") }}</div>
}
```
::: end

```heex
<%= if Enum.empty?(["alpha", "beta"]) do %>
  <.empty><%= pgettext("page.Lists.empty.8e7r1j", "No tags") %></.empty>
<% else %>
  <%= for tag <- ["alpha", "beta"] do %>
    <.badge><%= tag %></.badge>
  <% end %>
<% end %>
```

```dart
if (['alpha', 'beta'].isEmpty) Center(child: Padding(padding: const EdgeInsets.all(32), child: Text(t('page.Lists.empty.8e7r1j', 'No tags')))) else ...['alpha', 'beta'].map((tag) => Chip(label: Text('${tag}'), visualDensity: VisualDensity.compact)),
```

The list key is the loop index (`tagIdx` / `$index`). Inline `filter` / `map` on the collection render natively (`orders.filter(o => …)`); every other collection op is a backend vocabulary and is rejected (`loom.frontend-collection-op-unsupported`).

## `match` in markup — the ternary/block split

`match { pred => value, … else => value }` is the predicate-arm conditional. In body position it is where React and everyone else part ways: React renders a markup-valued ternary, the rest emit block control flow. A bare identifier before `=>` parses as a **lambda** (`submitted => …` is `param => body`), so write the comparison out (`submitted == true =>`).

```ddd
match {
  showArchived == true => Badge { "showing archived" },
  else => Text { "active only" }
}
```

::: tabs frontend
== react
```tsx
{((showArchived === true)) ? (<Badge>{t("page.Lists.badge.nr1x3e", "showing archived")}</Badge>) : <Text>{t("page.Lists.text.2ovjgv", "active only")}</Text>}
```
== vue
```vue
<template v-if="(showArchived === true)">
  <v-chip size="small">{{ t("page.Lists.badge.nr1x3e", "showing archived") }}</v-chip>
</template>
<template v-else>
  <div>{{ t("page.Lists.text.2ovjgv", "active only") }}</div>
</template>
```
== svelte
```svelte
{#if (showArchived === true)}
  <span class="…">{t("page.Lists.badge.nr1x3e", "showing archived")}</span>
{:else}
  <p class="text-sm leading-relaxed">{t("page.Lists.text.2ovjgv", "active only")}</p>
{/if}
```
== angular
```ts
@if ((showArchived() === true)) {
  <span class="loom-badge">{{ t("page.Lists.badge.nr1x3e", "showing archived") }}</span>
} @else {
  <div>{{ t("page.Lists.text.2ovjgv", "active only") }}</div>
}
```
::: end

```heex
<%= cond do %>
  <% @show_archived == true -> %>
    <.badge><%= pgettext("page.Lists.badge.nr1x3e", "showing archived") %></.badge>
  <% true -> %>
    <p><%= pgettext("page.Lists.text.2ovjgv", "active only") %></p>
<% end %>
```

```dart
switch (0) { _ when (state.showArchived == true) => Chip(label: Text(t('page.Lists.badge.nr1x3e', 'showing archived')), visualDensity: VisualDensity.compact), _ => Text(t('page.Lists.text.2ovjgv', 'active only')) },
```

Feliz renders `if … then … else …` over the Model. Nest a `match` inside a container: a page whose `body:` **is** a bare `match` is currently dropped from the build with no diagnostic (no page file, no route) — wrap it (`body: Stack { match { … } }`) until that gap closes.

## `Button` and `Action`

`Button { "label", onClick: <action> | to: <route>, disabled:, loading:, variant:, icon:, iconPosition: }` — `onClick:` names a page/component/store action (never an inline effect: `loom.effect-in-lambda`), `to:` navigates. `Action { record.op, then: navigate(Page) }` is one button that invokes an aggregate operation through its mutation hook and runs `then:` after it resolves.

```ddd
component ProductActions(product: Product) {
  body: Toolbar { Action { product.archive, then: navigate(Home) } }
}
// …
Button { "Increment", onClick: bump }
```

::: tabs frontend
== react
```tsx
const archiveProduct = useArchiveProduct(product?.id);
<Group justify="space-between" role="toolbar" aria-label="Actions">
  <Button onClick={() => void archiveProduct.mutateAsync({}).then(() => { navigate("/"); })} loading={archiveProduct.isPending}>Archive</Button>
</Group>
// …
<Button onClick={bump}>{t("page.Counter.button.132vha", "Increment")}</Button>
```
== vue
```vue
<v-btn @click='() => void archiveProduct.mutateAsync({}).then(() => { router.push("/"); })' :loading='archiveProduct.isPending'>Archive</v-btn>
<v-btn @click='bump'>{{ t("page.Counter.button.132vha", "Increment") }}</v-btn>
```
== svelte
```svelte
<button type="button" class="loom-btn loom-btn-primary" onclick={() => void archiveProduct.mutateAsync({}).then(() => { navigate("/"); })}>Archive</button>
<button type="button" class="loom-btn loom-btn-primary" onclick={bump}>{t("page.Counter.button.132vha", "Increment")}</button>
```
== angular
```ts
<button mat-button (click)='onArchiveProduct()' [disabled]='archiveProduct.isPending()'>Archive</button>
// async onArchiveProduct() { await this.archiveProduct.mutateAsync({ id, input: {} }); this.router.navigateByUrl("/"); }
<button mat-button (click)='bump()'>{{ t("page.Counter.button.132vha", "Increment") }}</button>
```
::: end

```heex
<.button phx-click="archive_product" phx-value-id={@product.id}>Archive</.button>
<%!-- handle_event("archive_product", …) runs Lv.Shop.archive_product!/1 and push_navigate --%>
```

An icon-only button needs a name — visible text or `label:` (`loom.a11y-icon-only-no-name`, a warning). An `Action` over an operation with parameters is rejected (`loom.action-op-has-params`) — use `OperationForm`.

## `Slot`

`Slot { }` renders the positional children a caller passed to a `component`; the component shell declares the matching children parameter. It means nothing in a page (`loom.slot-outside-component`).

```ddd
component PageBox(title: string) {
  body: Card { Heading { title, level: 3 }, Slot { } }
}
page Boxed { route: "/boxed" body: PageBox { title: "Welcome", Text { "hi" } } }
```

::: tabs frontend
== react
```tsx
// src/components/PageBox.tsx
export default function PageBox({ title, children }: PageBoxProps) {
  return (
    <Card withBorder padding="md">
      <Title order={3}>{title}</Title>
      {children}
    </Card>
  );
}
// src/pages/boxed.tsx
<PageBox title="Welcome"><Text>{t("page.Boxed.text.sx4lga", "hi")}</Text></PageBox>
```
== vue
```vue
<!-- src/components/PageBox.vue -->
<v-card variant="outlined" class="pa-4">
  <h3>{{ title }}</h3>
  <slot />
</v-card>
```
== svelte
```svelte
<!-- src/lib/components/PageBox.svelte -->
let { title, children }: { title: string; children?: Snippet } = $props();
…
<h3 class="text-xl font-semibold">{title}</h3>
{@render children?.()}
```
== angular
```ts
// src/app/components/PageBox.ts
template: `<mat-card><mat-card-content><h3>{{ title }}</h3><ng-content></ng-content></mat-card-content></mat-card>`
```
::: end

Feliz emits `let PageBox (props: {| title: string; children: ReactElement |}) = …` in the nested `Components` module, Flutter a `PageBox extends StatelessWidget` with a `Widget? child`, Phoenix a `page_box(assigns)` function component with `slot :inner_block`.

## Per-target honest gates

Where a target cannot render a primitive the compiler says so — a `loom.*` error, never a blank spot:

| Gate | Fires when |
|---|---|
| `loom.datagrid-unsupported-target` | `DataGrid` on `phoenixLiveView` or `flutter` |
| `loom.table-filter-unsupported` | `Table { filter: }` on `phoenixLiveView` |
| `loom.table-filter-server-paged` | `filter:` on a `serverPaged: true` table (any target) |
| `loom.modal-controlled-op-form-unsupported` | `Modal { open: …, OperationForm { … } }` on react / vue / svelte / flutter |
| `loom.chart-unsupported-target` | `Chart` on a frontend with no chart renderer — none of the seven today |
| `loom.flutter-primitive-unsupported` | a primitive the Flutter pack has no renderer for — none in the current registry (the message still names `FileUpload`, which now renders) |
| `loom.user-component-deferred-target` | a `component` shape the Angular / Feliz emitter filters out — `slot` / `action` params, a Feliz body with `Action { … }`, a `byId` or store read, an Angular read fed by an `@Input()` ([15](15-ui-pages-structure.md)) |
| `loom.heex-component-host-state-unsupported` | inputs / forms / queries / uploads / table controls inside a `component` on Phoenix — only `state` and named `action`s are lifted to the host LiveView |
| `loom.feliz-async-effect-unsupported` · `loom.flutter-async-effect-unsupported` | `match await` in a component action ([actions.md](../actions.md)) |
| `loom.ui-projection-read-unsupported` | a keyed or folded projection read from a page, or a frontend without a projection client |
| `loom.toast-message-unsupported` | a realtime `toast(…)` message outside the literal / `e.field` / binary-op subset |

The HEEx parity list (`test/generator/elixir/heex-parity.test.ts`) freezes the set of TSX-rendered primitives without a `heex` renderer: today that is **`DataGrid` only** — every other primitive has a HEEx renderer, so a new TSX-only primitive fails CI until it gets one or is pinned with a reason.

## Where to go next

- The registry and the derived name/slot/arg tables: `src/generator/_walker/registry.ts`, `src/util/walker-primitive-names.ts`, `src/util/walker-primitive-args.ts` — pinned by `walker-stdlib-completeness.test.ts` and `walker-primitive-args-completeness.test.ts`.
- Page structure, `state {}`, `store`, `component`, scaffolding: [15. UI: pages & structure](15-ui-pages-structure.md) and [`../page-metamodel.md`](../page-metamodel.md).
- Named actions and `match await`: [`../actions.md`](../actions.md).
- Authoring a design pack: [`../design-packs.md`](../design-packs.md).
- The framework seams each target implements (`renderMatchChild`, `renderForEach`, state read/write, navigation, the `renderTimeline` / `renderFileLink` / `renderProvenanceInfo` forks): `src/generator/_walker/target.ts`.
