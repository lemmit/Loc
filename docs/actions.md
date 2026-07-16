# Actions & effects — `action`, `match await`, error handling

A page or component `action` is a **named event handler**: a block of statements
wired to a control (`onClick: submit`). Actions come in two flavours — a **sync**
action that only touches local `state` (Proposal A, Stage 1), and an **async**
action that invokes a remote command and discriminates its result with
`match await` (Stage 2 of [`docs/old/proposals/async-actions-and-effects.md`](old/proposals/async-actions-and-effects.md)).

This page is the user-facing reference; the design rationale lives in the
proposals. As always in Loom, every feature carries **two** examples — the `.ddd`
source and the generated target output.

## Named actions (sync)

```ddd
page Counter {
  route: "/"
  state { count: int = 0 }
  action inc() { count += 1 }
  body: Stack {
    Heading { "Counter" },
    Button { "＋", onClick: inc }
  }
}
```

A named `action` hoists to one handler per framework (React `const inc = …`,
LiveView `handle_event("inc", …)`), referenced by name from the control. A named
`action` is the **only** home for an effect: an inline effect handler
(`onClick: e => { count += 1 }`) is rejected by `loom.effect-in-lambda`, so a
render-tree lambda stays pure (a value projection like a `Table` column
accessor). This keeps one effect-handler form across the language and, for the
[MVU/Elmish study](old/proposals/fable-elmish-frontend.md), keeps the `Model → Html`
view pure so `Msg`/`update` project straight off the action list.

## What belongs in a lambda vs an action

The split is **read vs write**, not "no state." A **render-tree lambda** — a
`Table`/`Column` accessor, a `For`/`.map`/`.filter` callback, a `data:` renderer
— is a *pure projection*: given a bound item, it returns a value or markup. It
may read anything and compute freely; it may not perform an effect. An **effect**
— mutating `state`/`store`, `navigate`/`toast`/`emit` — lives in a named
`action`, referenced by name from the control (`onClick: bump`). Effects inside
an `action` body are unrestricted; the rule only governs lambdas in the view.

| In a render-tree lambda | Allowed? | |
|---|---|---|
| `o => Text { o.code }` — render a component | ✅ | value/markup |
| `o => Text { o.active ? "Y" : "N" }` — ternary / `match` value | ✅ | computed value |
| `o => Text { o.code + label }` — **reads** `state`, concatenates | ✅ | reads are fine |
| `o => Text { initials(o.code) }` — value-returning function call | ✅ | pure call |
| `orders.filter(o => o.active)` / `.map(...)` — collection op | ✅ | pure callback |
| `onClick: bump` — **reference** a named action | ✅ | the effect goes here |
| `e => { count := count + 1 }` — **writes** `state` | ❌ | `loom.effect-in-lambda` |
| `e => navigate("/x")` — `navigate` / `toast` / `emit` | ❌ | `loom.effect-in-lambda` |

Rule of thumb: **a lambda is any expression that computes a value; anything that
*does* something is an `action`.** Reading `state`/`store`/props/derived values
inside a lambda is always fine — only writing (or a view effect) is rejected.

```ddd
// ❌ effect inline in the view
Button { "＋", onClick: e => { count += 1 } }

// ✅ effect named; the view just dispatches
action inc() { count += 1 }
Button { "＋", onClick: inc }
```

(One deliberate exception: a direct api-hook call such as
`onClick: e => { Orders.Order.create.mutate(v) }` is *not* flagged — it is the
mutation-hook mechanism, not a free effect statement.)

## `match await` — awaiting a remote command

When an action needs to run a remote, `Result`-returning aggregate operation
(one declared `operation foo(): Agg or SomeError`), it **awaits** the call as the
subject of a `match` and discriminates the returned union:

```ddd
error Rejected { reason: string }

aggregate Order {
  code: string
  operation confirm(): Order or Rejected { … }
}

page OrderDetail {
  route: "/orders/:id"
  state { message: string = "" }
  action confirm() {
    match await Orders.Order.confirm() {
      Order o    => { message := o.code }
      Rejected r => { message := r.reason }
    }
  }
  body: Stack { Button { "Confirm", onClick: confirm } }
}
```

- The subject is `await <api>.<Agg>.<op>(args)` — an instance operation, so it is
  invoked against the page's **route-id record**. The hosting page **must** declare
  a `:id` route param (a detail page): the instance is that record. A paramless page
  has no record in scope, so an instance-op `match await` there is rejected on every
  frontend (`loom.instance-effect-needs-route-id`) — host it on a `/…/:id` page, or
  drive the op through an `OperationForm`.
- The `args` build the request payload, so they must **match the operation
  signature** — one argument per parameter, in order (a trailing `optional` param
  may be omitted). A count mismatch is rejected (`loom.match-await-arg-mismatch`),
  and a literal argument of the wrong type (`confirm(42)` for a `string` param) is
  rejected (`loom.match-await-arg-type`) — rather than shipping a broken request.
- Each arm names a **variant** of the op's `or`-union: the **success** variant is
  the aggregate itself (`Order`); the rest are **error** variants.
- Arm bodies run statements (state writes, `navigate`), binding the narrowed
  variant (`o`, `r`).
- An `else` arm is the catch-all; it may replace the error arms entirely if you
  don't need to distinguish them.

### Generated output — client-side (React/Vue/Svelte/Angular)

The JS frontends run the async boundary in the browser: await the mutation, reify
a thrown `ApiError` back into the error variant, then `switch` on the tag.

```tsx
const confirm = async () => {
  let result: ConfirmOrderResponse;
  try {
    result = await orderConfirm.mutateAsync({});
  } catch (e) {
    if (e instanceof ApiError) {
      result = { ...(e.body as Record<string, unknown>), type: "Rejected" } as ConfirmOrderResponse;
    } else { throw e; }
  }
  switch (result.type) {
    case "Order":    { const o = result; setMessage(o.code); break; }
    case "Rejected": { const r = result; setMessage(r.reason); break; }
  }
};
```

The backend maps an error variant to an RFC-7807 ProblemDetails whose `type` is
the error URI (the tag is clobbered), but the fields survive — so the caught body
is re-stamped with the known tag.

### Generated output — server-side (Phoenix / HEEx)

LiveView's async boundary is **server-side**: the `handle_event` loads the record,
runs the op's context function, and `case`s on the tagged Result tuple — no HTTP
round-trip, no reification.

```elixir
def handle_event("confirm", _params, socket) do
  socket =
    socket
    |> then(fn socket ->
      case Orders.get_order(socket.assigns.id) do
        {:ok, record} ->
          case apply(Orders, :confirm_order, [record, %{}]) do
            {:ok, o}                 -> socket |> assign(:message, o.code)
            {:error, "Rejected", r}  -> socket |> assign(:message, r.reason)
            _                        -> socket
          end
        {:error, :not_found} ->
          put_flash(socket, :error, "Order not found")
      end
    end)
  {:noreply, socket}
end
```

## Multiple error variants

A union may declare more than one error. Each named arm routes independently: the
client maps the caught ProblemDetails `type` URI back to the matching tag.

```ddd
operation confirm(): Order or Rejected or Blocked { … }

action confirm() {
  match await Orders.Order.confirm() {
    Order o    => { message := o.code }
    Rejected r => { message := r.reason }
    Blocked b  => { message := "blocked" }
  }
}
```

```tsx
} catch (e) {
  if (e instanceof ApiError) {
    const __t = (e.body as Record<string, unknown>)?.type;
    const __tag = __t === "/errors/rejected" ? "Rejected" : "Blocked";
    result = { ...(e.body as Record<string, unknown>), type: __tag } as ConfirmOrderResponse;
  } else { throw e; }
}
```

On HEEx each variant is its own `case` clause (`{:error, "Rejected", r}`,
`{:error, "Blocked", _b}`; an unused binder is `_`-prefixed for
`--warnings-as-errors`).

### Naming a context-local error

An `error` declared inside a `context` is **context-scoped** — it is not exported
globally (so it can't collide across contexts). It is still nameable in a
match-await arm **when the page's `api X: Y` handle binds the context that owns
it** — the page can only match errors from contexts it actually talks to. An error
from an unbound context does not resolve.

## The effect marker

A **bare** (un-`await`ed) remote mutating call in an action body has an invisible
async boundary. The validator flags it — `loom.missing-effect-marker` (a warning
during the Stage-2 ramp) — pointing you at the `match await` form:

```ddd
action confirm() {
  Orders.Order.confirm()          // ⚠ loom.missing-effect-marker
}
```

Reads (`byId`, finders), sibling-action calls, pure helpers, and view-effects
(`navigate` / `toast`) are **not** flagged.

## Further reading

- [`docs/page-metamodel.md`](page-metamodel.md) — the page/component DSL surface,
  `state`, `match`, block-body lambdas.
- [`docs/payloads.md`](payloads.md) — `error` records, the `or`-union carrier, the
  ProblemDetails wire.
- [`docs/old/proposals/async-actions-and-effects.md`](old/proposals/async-actions-and-effects.md),
  [`named-actions-and-stores.md`](old/proposals/named-actions-and-stores.md) — design
  rationale and the remaining stages (`await`-required flip, `spawn` / `attempt`,
  `async` composition).
