# Graduating from no-code: the customization gradient

Loom's promise is "start fast and easy like no-code, then have a full app with
no excuses." The part that makes or breaks that promise is the **middle** — the
path from a fully-scaffolded UI to a fully hand-written one. Most no-code tools
have a cliff there: you scaffold, you love it, you need one custom screen, and
you fall off into rewriting everything.

Loom's middle is a gradient, not a cliff. There are four rungs, and you can stop
on any of them — or mix them per page. This guide walks all four with one running
example.

Throughout: **`generate` (or a `tsc` / compiler run on the emitted target) is the
real gate, not `parse`.** `parse` only runs the front of the pipeline; see
[`tools.md`](tools.md) → *parse ≠ generate*.

---

## Rung 0 — scaffold everything

```ddd
aggregate Task with crudish {
  title: string
  done: bool
}

ui WebApp with scaffold(subdomains: [Core]) { }
```

`with scaffold(...)` synthesises the whole UI — a home dashboard, and a
List / New / Detail page per aggregate — with no page bodies written by hand.
`with crudish` gives you `create` / `update` / `destroy` + `findAll` for free.
This is the no-code rung: describe shape, get an app. See
[`scaffold-macros.md`](scaffold-macros.md).

## Rung 1 — override one page, keep the rest scaffolded

You rarely want *all* custom. You want the default List and New, and one bespoke
Detail. Write the page you care about in the matching **`area`** next to the
scaffold clause — it replaces the scaffolded page of the same name, and every
sibling stays scaffolded:

```ddd
ui WebApp with scaffold(subdomains: [Core]) {
  area Tasks {
    page Detail(id: Task id) {
      route: "/tasks/:id"
      title: "Custom task"
      body: Stack {
        Heading { "My bespoke task console", level: 1 },
        testid: "custom-detail"
      }
    }
  }
}
```

One `generate system` later, `pages/tasks/detail.tsx` is **your** page,
`list.tsx` / `new.tsx` are the untouched scaffold, and the router wires
`/tasks/:id` to your component exactly once:

```tsx
// pages/tasks/detail.tsx — the explicit page wins
export default function TaskDetail() {
  return (
    <Stack data-testid="custom-detail">
      <Title order={1}>My bespoke task console</Title>
    </Stack>
  );
}
```

This is **override-by-name** — scope-local, and it works for the singleton
dashboard pages too (write your own `page Home { … }` and the scaffolded one
steps aside). Full mechanics in
[`scaffold-macros.md`](scaffold-macros.md#overriding-a-scaffolded-page).

**Reach for this rung when** you're writing something bespoke anyway and don't
need to see the generated default.

## Rung 2 — unfold: start from the generated body, then edit it

Sometimes the scaffolded page is 90% right and you want to *tweak* it, not
rewrite it. **Unfold** materialises a macro's output as real `.ddd` source you
can edit in place. It's exposed as an LSP code action ("Unfold macro") and as
the `loom_unfold_macro` agent tool.

Unfolding is **one level at a time** and composable:

```
with scaffold(subdomains: [Core])
  ⟶ unfold ⟶  with scaffoldSubdomain(of: Core)   (+ Home/index pages as source)
  ⟶ unfold ⟶  with scaffoldContext(of: Tasks)
  ⟶ unfold ⟶  with scaffoldAggregate(of: Task)
  ⟶ unfold ⟶  page List … / page New … / page Detail …   ← real, editable source
```

Drill only into the aggregate you want to customise; the rest of the UI stays
under the macro. Once a page is source, edit it like any hand-written page.

**Reach for this rung when** the default is close and you want to adjust it —
the reverse of rung 1's "replace wholesale".

## Rung 3 — fully hand-written, and multi-framework

Drop `with scaffold` entirely and write every page from the closed page-primitive
library (`Stack` / `Toolbar` / `QueryView` / `Table` / `CreateForm` /
`OperationForm` / `match` / lambdas / reusable `component`s). No excuses: the
primitives are framework-neutral, so the *same* `ui` can be served to more than
one frontend off one backend:

```ddd
deployable reactApp { platform: react
  targets: api
  ui: Board { Work: api }
}
deployable vueApp  { platform: vue
  targets: api
  ui: Board { Work: api }
}
```

`generate system` emits a React/Mantine app *and* a Vue/Vuetify app from that one
`ui Board`, and both type-check. See [`page-metamodel.md`](page-metamodel.md) for
the primitive library.

> **Separator note.** A `deployable` whose field uses the brace api-binding form
> (`ui: Board { Work: api }`) must use **newline-separated** fields — a trailing
> comma after the brace is rejected. See [`language.md`](language.md) →
> *Lexical structure*.

---

## You don't climb the whole ladder

The point of the gradient is that each rung is a **stable resting place**, and
they compose *per page*: a real app is usually rung 0 for the CRUD-shaped
aggregates, rung 1 for the two screens that carry the product's identity, and
rung 3 for the one dashboard that's the reason the app exists. You never pay for
customization you didn't ask for, and you're never blocked from the
customization you did.

## Worked example

The [`journey/`](../journey/) folder builds one app across five stages — simple
todo → fully custom multi-context system — with a running journal
([`journey/FINDINGS.md`](../journey/FINDINGS.md)) of what was easy, what was
missing, and what only surfaced when the emitted target was actually compiled.
It's the long-form companion to this guide.

## See also

- [`scaffold-macros.md`](scaffold-macros.md) — the scaffold family, override-by-name, and unfold.
- [`page-metamodel.md`](page-metamodel.md) — the page/primitive surface for rungs 1–3.
- [`tools.md`](tools.md) — the CLI, and why `generate` (not `parse`) is the gate.
