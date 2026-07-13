# State-controlled `Modal { open: <state> }`

> Status: building (React slice — Mantine + shadcn — landing first; other packs
> fall back gracefully). Motivated by the all-platform review: showcase's
> `Modal { open: editing }` emitted a stub comment because the only Modal shape
> implemented was the *operation-form* modal.

> **[2026-06-20 status audit]** Top-of-file 'building (React slice)' header is stale — the doc's own §Scope update says all EIGHT frontend packs ship the controlled modal (react/vue/svelte tests `modal-state-controlled.test.ts`). Treat as SHIPPED.

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

> **Status update:** now implemented on **all eight frontend packs.**

- **React** — Mantine (`<Modal opened/onClose>`), shadcn (`<Dialog open/onOpenChange>`),
  MUI (`<Dialog open/onClose>`), Chakra (v2 `<Modal isOpen/onClose>`, v3
  `<Dialog.Root open/onOpenChange>`).
- **Vue** — vuetify (`<v-dialog v-model>` + `v-card`), shadcnVue
  (`<Dialog v-model:open>`). State is a `ref`; v-model writes it (no React setter).
- **Svelte** — shadcnSvelte / flowbite (a hand-rolled `{#if <state>}` overlay,
  matching their op-form modal idiom; the `$state` rune drives visibility).

- **Phoenix LiveView** — an assign-driven conditional render
  (`<%= if @open do %> … <% end %>`). HEEx runs a parallel walker, so this is a
  branch in `heex-primitives.ts`'s `renderModal` rather than a pack template:
  the `open:` ref reads the page-state assign (`@archive_open`), `mount` defaults
  it, and the close is driven by a child button that writes the state (the
  existing `handle_event` machinery). No `<.modal>` JS/id indirection — the
  visibility is pure server state.

Now implemented on **every frontend**. A pack without a
`primitive-modal-controlled` template keeps the explanatory stub comment — no
breakage. No new walker primitive name, so the completeness/HEEx-parity gates
are unaffected.

## Verification note

Generated output verified structurally for all packs (state declaration +
dialog/conditional binding + children render). Compile verification is the
per-frontend build CI (`generated-react-build` / `-vue-build` / `-svelte-build`
/ the elixir-vanilla-* gates), as for any pack template — not run in this environment.
