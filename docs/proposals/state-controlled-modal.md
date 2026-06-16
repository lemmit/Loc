# State-controlled `Modal { open: <state> }`

> Status: building (React slice — Mantine + shadcn — landing first; other packs
> fall back gracefully). Motivated by the all-platform review: showcase's
> `Modal { open: editing }` emitted a stub comment because the only Modal shape
> implemented was the *operation-form* modal.

## Two Modal shapes

Loom's `Modal` primitive serves two distinct intents:

1. **Operation-form modal** (already shipped): open a validated form that runs an
   aggregate operation.
   ```
   Modal { trigger: Button { "Archive" }, Form(project.archive) }
   ```
   Open/close is owned by the generated operation-form module (shadcn: a local
   `useState`+`<Dialog>`; Mantine: the imperative `@mantine/modals` manager),
   keyed to the trigger→submit/cancel lifecycle.

2. **State-controlled modal** (this spec): a dialog whose visibility is a page
   `state` field — confirmations, info popovers, anything not tied to a form.
   ```
   state { archiveOpen: bool = false }
   …
   Button { "Archive", onClick: e => { archiveOpen := true } },
   Modal { Text { "Confirm archive?" }, open: archiveOpen, title: "Archive" }
   ```

## Surface

- `open:` — a `bind:`-style ref to a `bool` `state` field. Its presence (with no
  `Form(...)` child) selects the state-controlled shape. Reuses the same
  state-ref resolution the input bindables (`Field { bind: x }`) use: it marks
  `ctx.usesState`, so the page emits `const [x, setX] = useState<boolean>(…)`.
- Positional children are the modal body (walked normally).
- `title:` — optional dialog title.

## Generated React

**Mantine** — controlled `<Modal>` (not the imperative manager, since the open
state lives on the page):
```tsx
<Modal opened={archiveOpen} onClose={() => setArchiveOpen(false)} title="Archive">
  <Text>Confirm archive?</Text>
</Modal>
```

**shadcn** — controlled Radix `<Dialog>`:
```tsx
<Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
  <DialogContent>
    <DialogHeader><DialogTitle>Archive</DialogTitle></DialogHeader>
    <Text>Confirm archive?</Text>
  </DialogContent>
</Dialog>
```

## Scope / fallback

All four React packs ship the controlled modal: Mantine (`<Modal opened/onClose>`),
shadcn (`<Dialog open/onOpenChange>`), MUI (`<Dialog open/onClose>`), Chakra
(v2 `<Modal isOpen/onClose>`, v3 `<Dialog.Root open/onOpenChange>`).

A pack without a `primitive-modal-controlled` template (Vue: vuetify/shadcnVue;
Svelte: shadcnSvelte/flowbite; Phoenix HEEx) keeps the existing explanatory stub
comment — no breakage. Vue/Svelte are a deliberate follow-up: their state model
differs (Vue `ref` + `v-model`; Svelte `$state` + `x = false`, not the React
`setter`), and their modal area is itself partly unbuilt (vuetify's op-form
modal is a TODO), so the templates want their own verification (vue-tsc /
svelte-check) rather than a port of the React shape. No new walker primitive
name, so the completeness/HEEx-parity gates are unaffected.
