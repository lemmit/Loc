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

React Mantine + shadcn first (the packs the showcase deployables use). A pack
without a `primitive-modal-controlled` template (MUI, Chakra, Vue, Svelte,
Phoenix HEEx) keeps the existing explanatory stub comment — no breakage; those
packs adopt the template incrementally. No new walker primitive name, so the
walker-stdlib-completeness and HEEx-parity gates are unaffected.
