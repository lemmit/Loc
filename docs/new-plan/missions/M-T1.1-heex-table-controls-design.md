# M-T1.1 slice 8 (HEEx leg) — server-driven sort + pagination on the Phoenix LiveView table

> Closes the last **product-visible** gap in M-T1.1: on `platform: elixir` a
> scaffolded list page is hard-capped at the first 10 rows, with no pager and
> no column sort. The four JSX frontends have shipped both since slices 1–7/9.

## The bug this closes (verified on fresh `main`)

Generate any Phoenix scaffold (`web/src/examples/storefront-elixir.ddd`) and read
`product_list_live.ex`:

```elixir
def mount(_params, _session, socket) do
  socket =
    socket
    |> assign(:sort_key, "")
    |> assign(:sort_dir, "")
    |> assign(:page_num, 0)      # ← scaffold declares `pageNum: int = 1`
  {:ok, socket}
end

def handle_params(_params, _uri, socket) do
  socket =
    case PhoenixApp.Storefront.list_products() do   # ← no args at all
      {:ok, items} -> assign(socket, :items, items)
      _ -> assign(socket, :items, :error)
    end
  {:noreply, socket}
end
```

Three distinct defects compound:

1. **The `of:` args are dropped.** The scaffold emits
   `<api>.<Agg>.all(pageNum, 10, sortKey, sortDir)`, but `QueryBinding` carries
   only `{kind, assign, aggregate}` — the argument list never reaches
   `renderQueryLoadBlock`, which emits a bare `list_products()`. The repository's
   `list/4` defaults (`page \\ 1, page_size \\ 10, sort \\ "id", dir \\ "asc"`)
   then silently pin every Phoenix list to **page 1, forever**. Rows 11+ are
   unreachable — data the user modelled is invisible in the generated app.
2. **`StateFieldIR.init` is ignored in the Elixir mount.** `renderMount` uses
   `defaultInitFor(f.type)`, so the scaffold's explicit `pageNum: int = 1` seeds
   as `0`. This is the same defect the Vue page-shell had in slice 6 (fixed
   there, never ported here). It matters more once (1) is fixed: `page = 0`
   makes `offset = (0 - 1) * page_size = -10`, which Ecto rejects.
3. **`renderTable` ignores every control arg.** `sortKey:` / `sortDir:` /
   `page:` / `serverPaged:` / `totalPages:` are all parsed away — no sortable
   header, no pager. The `sort_key`/`sort_dir`/`page_num` assigns are seeded in
   `mount` and then read by nothing (the tracker's "harmless unused
   mount-assigns").

## Approach

Server-driven, not client-side — and this is *why* the HEEx leg is worth doing
now rather than porting the JSX client-side design. A LiveView calls the context
function **directly** (no HTTP client, no refetch hook), so `page`/`sort` are
just arguments to `list_<agg>s/4`, which already ships paged with a whitelisted
`ORDER BY`. The LiveView topology that made slices 1–7 awkward here is an
advantage for slice 9's server mode.

| Piece | Change |
|---|---|
| `heex-walker-core.ts` | `QueryBinding` gains `listArgs?: string[]` (rendered Elixir) + the walk result gains `tableControls` (the sort/page assign names). |
| `heex-primitives.ts` — `renderQueryView` | Render the `of:` call args and record them on the binding. |
| `heex-primitives.ts` — `renderTable` | Emit `sort_field` on `<:col>` slots; append a Prev / "Page N of M" / Next pager driven by `totalPages`. |
| `liveview-emit.ts` — `renderMount` | Honour `field.init` (falling back to `defaultInitFor`). |
| `liveview-emit.ts` — `renderQueryLoadBlock` | Emit `list_<agg>s(<args>)` from `listArgs`. |
| `liveview-emit.ts` | New hoisted `handle_event("loom-sort"/"loom-page")` clauses: update the assign, re-run the load block. |
| `designs/{coreComponents,daisyui}` | `<.table>`'s `:col` slot gains an optional `sort_field`; a set one renders the label as a `phx-click="loom-sort"` `<button>` (keyboard-focusable — the same a11y call slice 5 made for JSX). |

**Gated throughout:** a Table without the control args, and a page without a
sortable/paged table, emit byte-identical output. Client-side filter stays out
of scope — it is gated off under `serverPaged` on the JSX targets too (the
repository `list/4` has no filter parameter; a server filter is its own slice).

## Verification

- Generator unit tests under `test/generator/elixir/`.
- `mix compile --warnings-as-errors` on a generated Phoenix app in the
  `hexpm/elixir` image (`LOOM_HEX_MIRROR=1`) — the emitted `handle_event`
  clauses and the pack component change both have to survive the real compiler.
- The `heex-parity` pins for sort/pager come out of `docs/new-plan/T1`.
