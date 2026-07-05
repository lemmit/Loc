import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// `shape(document)` persistence on the vanilla (plain Ecto) foundation —
// DEBT-07.  The whole aggregate persists as ONE jsonb `data` blob in an
// `(id, data, version)` table.  Writes validate the domain fields through a
// SCHEMALESS changeset (cast + validate_required + invariant validators — the
// same contract the relational `base_changeset` runs) and store the validated
// map; reads merge `data` back over the id.  v1 scope: CRUD.
// ---------------------------------------------------------------------------

const DOC = `
system Carting {
  subdomain Sales {
    context Carts {
      valueobject Money { amount: int  currency: string }
      enum CartStatus { open, checkedOut }
      aggregate Cart shape(document) with crudish {
        reference: string
        status: CartStatus
        subtotal: Money
        itemCount: int
        invariant itemCount >= 0
      }
      repository Carts for Cart { }
    }
  }
  api CartsApi from Sales
  storage pg { type: postgres }
  resource cartState { for: Carts, kind: state, use: pg }
  deployable api {
    platform: elixir { foundation: vanilla }
    contexts: [Carts]
    dataSources: [cartState]
    serves: CartsApi
    port: 4000
  }
}
`;

// Same aggregate without shape(document) — asserts the document path is gated
// off (relational columns + Map.from_struct serialize stay byte-identical).
const RELATIONAL = DOC.replace(" shape(document)", "");

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla shape(document) persistence (DEBT-07)", () => {
  it("emits an (id, data, version) schema, not flattened columns", async () => {
    const schema = file(await generateSystemFiles(DOC), "/carts/cart.ex");
    // Route A: the blob is a TYPED `embeds_one :data, <Agg>.Data` embedded schema
    // (still one jsonb `data` column via the unchanged migration), not a flattened
    // relational table nor a bare `field :data, :map`.
    expect(schema).toContain("embeds_one :data, Api.Carts.Cart.Data, on_replace: :update");
    expect(schema).toContain("field :version, :integer, default: 1");
    // The ROOT schema carries no flattened relational table (`schema "carts"` holds
    // only the embed + version + timestamps).
    expect(schema).not.toContain("has_many");
    // The `<Agg>.Data` embedded schema carries the domain fields — enum stays
    // `:string` and value object stays `:map` so the stored jsonb + the wire are
    // byte-identical to the pre-Route-A map path; `@primary_key false` so no `id`
    // leaks into the blob.
    expect(schema).toContain("defmodule Api.Carts.Cart.Data do");
    expect(schema).toContain("@primary_key false");
    expect(schema).toContain("embedded_schema do");
    expect(schema).toContain("field :status, :string");
    expect(schema).toContain("field :subtotal, :map");
    expect(schema).toContain("field :item_count, :integer");
  });

  it("validates through the embedded Data changeset (cast + required + invariants)", async () => {
    const schema = file(await generateSystemFiles(DOC), "/carts/cart.ex");
    // Route A: validation lives on the `<Agg>.Data` embedded schema's changeset/2
    // (cast the scalar fields + validate_required + invariant validators), which
    // the root changeset `cast_embed`s.
    expect(schema).toContain("def changeset(struct, attrs) do");
    expect(schema).toContain("|> cast(attrs, [:reference, :status, :subtotal, :item_count])");
    expect(schema).toContain("|> validate_required([:reference, :status, :subtotal, :item_count])");
    // The same invariant-derived validator the relational path emits.
    expect(schema).toContain("validate_number(:item_count, greater_than_or_equal_to: 0)");
    // The root changeset casts attrs INTO the embed + stamps version.
    const cs = file(await generateSystemFiles(DOC), "/carts/cart_changeset.ex");
    expect(cs).toContain("def document_changeset(%Api.Carts.Cart{} = record, attrs, version)");
    expect(cs).toContain('|> cast(%{"data" => attrs}, [])');
    expect(cs).toContain(
      "|> cast_embed(:data, with: &Api.Carts.Cart.Data.changeset/2, required: true)",
    );
    expect(cs).toContain("|> put_change(:version, version)");
  });

  it("repository CRUD round-trips the document (cast_embed + version bump)", async () => {
    const repo = file(await generateSystemFiles(DOC), "/carts/cart_repository.ex");
    // Insert: cast attrs into a fresh embed, version 1.
    expect(repo).toContain("|> Api.Carts.CartChangeset.document_changeset(attrs, 1)");
    expect(repo).toContain("%Api.Carts.Cart{}");
    // Update: cast_embed(on_replace: :update) merges onto the existing embed,
    // bumps version — no manual Map.merge.
    expect(repo).toContain(
      "|> Api.Carts.CartChangeset.document_changeset(attrs, record.version + 1)",
    );
    expect(repo).not.toContain("Map.merge(record.data");
    // Same fn names as the relational repo (so context defdelegates are unchanged).
    expect(repo).toContain("def list do");
    expect(repo).toContain("def find_by_id(id)");
  });

  it("serializes the document via the shared wireShape projection rooted at the embed (§14)", async () => {
    const ctrl = file(await generateSystemFiles(DOC), "/controllers/cart_controller.ex");
    // Route A slice 4: the document controller roots the SAME wireShape serializer
    // at the rehydrated `%<Agg>.Data{}` embed (`record = row.data`), id off the
    // root row — camelCase keys, VO via the shared serialize_<vo>/1 helper (wire
    // byte-identical to the pre-slice-4 map projection).
    expect(ctrl).toContain("defp serialize(row) do");
    expect(ctrl).toContain("record = row.data");
    expect(ctrl).toContain('"id" => row.id');
    expect(ctrl).toContain('"itemCount" => record.item_count');
    expect(ctrl).toContain('"reference" => record.reference');
    // The VO projects through the shared camelCase helper (key-agnostic subfield read).
    expect(ctrl).toContain('"subtotal" => serialize_money(record.subtotal)');
    expect(ctrl).toContain("defp serialize_money(record) do");
  });

  it("normalizes camelCase inbound keys to snake before the embedded cast (§15)", async () => {
    const schema = file(await generateSystemFiles(DOC), "/carts/cart.ex");
    // Route A: normalization lives on the `<Agg>.Data` changeset (a camelCase
    // `itemCount` body casts into `:item_count` instead of silently dropping).
    expect(schema).toContain("attrs = __normalize_keys(attrs)");
    expect(schema).toContain("defp __normalize_keys(attrs) when is_map(attrs) do");
    expect(schema).toContain("{k, v} when is_binary(k) -> {Macro.underscore(k), v}");
  });

  it("emits the canonical (id, data, version) document migration", async () => {
    const mig = file(await generateSystemFiles(DOC), "_create_carts.exs");
    expect(mig).toContain("add :data, :map");
    expect(mig).toContain("add :version, :integer");
    expect(mig).not.toContain("add :reference");
  });

  it("gates the document path off for a relational aggregate (byte-identical)", async () => {
    const schema = file(await generateSystemFiles(RELATIONAL), "/carts/cart.ex");
    expect(schema).toContain("field :reference, :string");
    expect(schema).not.toContain("field :data, :map");
    const ctrl = file(await generateSystemFiles(RELATIONAL), "/controllers/cart_controller.ex");
    // The relational serializer projects from the aggregate's wireShape (the
    // canonical cross-backend wire), NOT a raw `Map.from_struct` struct dump.
    expect(ctrl).not.toContain("Map.from_struct()");
    expect(ctrl).toContain('"reference" => record.reference');
    expect(ctrl).toContain('"itemCount" => record.item_count');
  });
});

// ---------------------------------------------------------------------------
// Scalar custom finds + named operations on a document aggregate (DEBT-07).
// A document row has no flattened columns, so a find filters IN MEMORY over the
// jsonb `data` map and a named op runs its body over that map, persisting via
// the document repo's `update/2`.
// ---------------------------------------------------------------------------
const DOC_OPS = `
system Carting {
  subdomain Sales {
    context Carts {
      enum CartStatus { open, checkedOut }
      aggregate Cart shape(document) with crudish {
        reference: string
        status: CartStatus
        itemCount: int
        invariant itemCount >= 0
        operation addItem() {
          precondition itemCount >= 0
          itemCount := itemCount + 1
        }
        operation checkOut() {
          precondition status == open
          status := checkedOut
        }
      }
      repository Carts for Cart {
        find byReference(reference: string): Cart? where this.reference == reference
        find checkedOutOnes(): Cart[] where this.status == checkedOut
      }
    }
  }
  api CartsApi from Sales
  storage pg { type: postgres }
  resource cartState { for: Carts, kind: state, use: pg }
  deployable api {
    platform: elixir { foundation: vanilla }
    contexts: [Carts]
    dataSources: [cartState]
    serves: CartsApi
    port: 4000
  }
}
`;

describe("vanilla shape(document) scalar finds + named ops (Route A slice 2 — struct mode)", () => {
  it("emits in-memory custom finds that read the rehydrated embed struct", async () => {
    const repo = file(await generateSystemFiles(DOC_OPS), "/carts/cart_repository.ex");
    // A list find returns every match; the predicate reads the rehydrated
    // `%<Agg>.Data{}` embed bound as `record` (struct access, no docMap fork),
    // enums compared as their stored strings.
    expect(repo).toContain("def checked_out_ones() do");
    expect(repo).toContain("|> Repo.all()");
    expect(repo).toContain("|> Enum.filter(fn row ->");
    expect(repo).toContain("record = row.data");
    expect(repo).toContain('record.status == "checkedOut"');
    expect(repo).toContain("{:ok, results}");
    // A single-return find (`Cart?`) yields the first match (or nil).
    expect(repo).toContain("def by_reference(reference) do");
    expect(repo).toContain("record.reference == reference");
    expect(repo).toContain("{:ok, List.first(results)}");
    // The docMap normaliser helper is gone.
    expect(repo).not.toContain("__doc_data");
  });

  it("emits struct-mode named-op fns that re-embed the mutated struct + bump version", async () => {
    const ctx = file(await generateSystemFiles(DOC_OPS), "/carts.ex");
    // Route A slice 2: bind the embed as `record`, mutate it in struct mode, then
    // put_embed the flattened struct + bump version (no docMap, no schemaless fold).
    expect(ctx).toContain(
      "def add_item_cart(%Api.Carts.Cart{} = row, params) when is_map(params) do",
    );
    expect(ctx).toContain("record = row.data");
    expect(ctx).toContain("if not (record.item_count >= 0), do: raise(ArgumentError");
    expect(ctx).toContain("record = %{record | item_count: record.item_count + 1}");
    expect(ctx).toContain("|> Ecto.Changeset.change(%{version: row.version + 1})");
    expect(ctx).toContain("|> Ecto.Changeset.put_embed(:data, Map.from_struct(record))");
    expect(ctx).toContain("|> Api.Carts.CartRepository.persist_change()");
    // An enum assign uses the stored string form (struct field stays `:string`).
    expect(ctx).toContain('record = %{record | status: "checkedOut"}');
    // The find defdelegates front the repository fns.
    expect(ctx).toContain(
      "defdelegate by_reference_cart(reference), to: Api.Carts.CartRepository, as: :by_reference",
    );
    // The docMap fork is gone — no `data = ... Map.from_struct` map bind, no Map.put.
    expect(ctx).not.toContain('Map.put(data, "item_count"');
    expect(ctx).not.toContain("CartRepository.update(record, data)");
  });
});

// ---------------------------------------------------------------------------
// Non-scalar residual now emitted (DEBT-07 follow-up): value-object-subfield
// reads, pure-function calls, and RETURNING (`: A or B`) operations.
// ---------------------------------------------------------------------------
const DOC_RICH = `
system Carting {
  subdomain Sales {
    context Carts {
      valueobject Money { amount: int  currency: string }
      error AlreadyClosed { message: string }
      aggregate Cart shape(document) with crudish {
        subtotal: Money
        itemCount: int
        function isCheap(): bool = subtotal.amount < 100
        operation discount() {
          precondition isCheap()
          precondition subtotal.amount >= 0
          itemCount := itemCount + 1
        }
        operation tryClose(): Cart or AlreadyClosed {
          return AlreadyClosed { message: "closed" }
        }
        operation bumpOrClose(): Cart or AlreadyClosed {
          itemCount := itemCount + 1
        }
      }
      repository Carts for Cart { }
    }
  }
  api CartsApi from Sales
  storage pg { type: postgres }
  resource cartState { for: Carts, kind: state, use: pg }
  deployable api {
    platform: elixir { foundation: vanilla }
    contexts: [Carts]
    dataSources: [cartState]
    serves: CartsApi
    port: 4000
  }
}
`;

describe("vanilla shape(document) non-scalar residual (DEBT-07 follow-up)", () => {
  it("emits document functions over the rehydrated embed struct + value-object-subfield reads", async () => {
    const ctx = file(await generateSystemFiles(DOC_RICH), "/carts.ex");
    // Route A slice 2: a pure function on a document aggregate takes the
    // `%<Agg>.Data{}` embed struct (struct-guarded, no `is_map` map form), reading
    // the value-object subfield via the key-type-agnostic fallback (a VO map may
    // be string- or atom-keyed; #1660).
    expect(ctx).toContain("def is_cheap(%Api.Carts.Cart.Data{} = record) do");
    expect(ctx).toContain(
      'Map.get(record.subtotal, :amount, Map.get(record.subtotal, "amount")) < 100',
    );
    // The op guard calls the function passing the embed struct, reading the VO sub-field.
    expect(ctx).toContain("if not (is_cheap(record)), do: raise(ArgumentError");
    expect(ctx).toContain(
      'if not (Map.get(record.subtotal, :amount, Map.get(record.subtotal, "amount")) >= 0), do: raise(ArgumentError',
    );
  });

  it("emits returning ops as tagged tuples (error variant + fall-through success wire)", async () => {
    const ctx = file(await generateSystemFiles(DOC_RICH), "/carts.ex");
    // An error-variant `return` → {:error, "<tag>", <map>}; the row is unused
    // (no embed read) so it's underscored to avoid a -Werror unused warning.
    expect(ctx).toContain(
      "def try_close_cart(%Api.Carts.Cart{} = _row, params) when is_map(params) do",
    );
    expect(ctx).toContain('{:error, "AlreadyClosed", %{message: "closed"}}');
    // A fall-through success projects the in-memory wire off the mutated embed —
    // `id` off the root row (the embed carries none), fields off `record`
    // (camelCase keys, matching serialize/1).
    expect(ctx).toContain(
      "def bump_or_close_cart(%Api.Carts.Cart{} = row, params) when is_map(params) do",
    );
    expect(ctx).toContain("record = row.data");
    expect(ctx).toContain(
      '{:ok, %{"id" => row.id, "subtotal" => record.subtotal, "itemCount" => record.item_count}}',
    );
  });
});

// ---------------------------------------------------------------------------
// Document containments (Route A slice 4) — nested entity parts fold into the
// `<Agg>.Data` embed as embeds_many + project through the shared serialize helper.
// ---------------------------------------------------------------------------
const DOC_CONTAIN = `
system Ordering {
  subdomain Sales {
    context Orders {
      aggregate Order shape(document) with crudish {
        reference: string
        contains lines: OrderLine[]
        entity OrderLine { sku: string  qty: int }
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage pg { type: postgres }
  resource orderState { for: Orders, kind: state, use: pg }
  deployable api {
    platform: elixir { foundation: vanilla }
    contexts: [Orders]
    dataSources: [orderState]
    serves: OrdersApi
    port: 4000
  }
}
`;

describe("vanilla shape(document) containments (Route A slice 4)", () => {
  it("folds the part into the <Agg>.Data embed as embeds_many + cast_embed", async () => {
    const schema = file(await generateSystemFiles(DOC_CONTAIN), "/orders/order.ex");
    expect(schema).toContain("embeds_many :lines, Api.Orders.OrderLine");
    expect(schema).toContain("|> cast_embed(:lines)");
  });

  it("projects the containment through the shared camelCase serialize helper", async () => {
    const ctrl = file(await generateSystemFiles(DOC_CONTAIN), "/controllers/order_controller.ex");
    // Rooted at the embed, id off the row; the part list maps through serialize_order_line/1.
    expect(ctrl).toContain("defp serialize(row) do");
    expect(ctrl).toContain("record = row.data");
    expect(ctrl).toContain('"id" => row.id');
    expect(ctrl).toContain('"lines" => Enum.map(record.lines || [], &serialize_order_line/1)');
    expect(ctrl).toContain("defp serialize_order_line(record) do");
    expect(ctrl).toContain('"sku" => record.sku');
  });

  it("emits an in-op containment mutation that appends a part struct + re-embeds (Route A slice 4b)", async () => {
    const DOC_MUT = DOC_CONTAIN.replace(
      "entity OrderLine { sku: string  qty: int }",
      `entity OrderLine { sku: string  qty: int }
        operation addLine(sku: string, qty: int) {
          lines += OrderLine { sku: sku, qty: qty }
        }`,
    );
    const ctx = file(await generateSystemFiles(DOC_MUT), "/orders.ex");
    // `lines += OrderLine{…}` appends a part struct to the rehydrated embed list…
    expect(ctx).toContain(
      "record = %{record | lines: (record.lines || []) ++ [%Api.Orders.OrderLine{sku: sku, qty: qty}]}",
    );
    // …then re-embeds the whole mutated struct (the struct-list casts into embeds_many).
    expect(ctx).toContain("|> Ecto.Changeset.put_embed(:data, Map.from_struct(record))");
  });
});

// ---------------------------------------------------------------------------
// Paged custom finds (Route A slice 4c) — the document find fn builds the
// %{items, page, pageSize, total, totalPages} wire envelope IN MEMORY.
// ---------------------------------------------------------------------------
describe("vanilla shape(document) paged finds (Route A slice 4c)", () => {
  const DOC_PAGED = `
system Shop {
  subdomain Sales {
    context Shop {
      enum Status { open, closed }
      aggregate Ticket shape(document) with crudish {
        title: string
        status: Status
      }
      repository Tickets for Ticket {
        find recent(): Ticket paged
        find byStatus(status: Status): Ticket paged where this.status == status
      }
    }
  }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir { foundation: vanilla }, contexts: [Shop], dataSources: [shopState], serves: ShopApi, port: 4000 }
}
`;

  it("builds the paged envelope in-memory (filter → slice → %{items,page,…})", async () => {
    const repo = file(await generateSystemFiles(DOC_PAGED), "/shop/ticket_repository.ex");
    // Page controls with the shared defaults.
    expect(repo).toContain("def recent(page \\\\ 1, page_size \\\\ 20) do");
    expect(repo).toContain("def by_status(status, page \\\\ 1, page_size \\\\ 20) do");
    // Filter the whole table, then slice the page in memory.
    expect(repo).toContain("|> Repo.all()");
    expect(repo).toContain("total = length(matched)");
    expect(repo).toContain("items = Enum.slice(matched, offset, page_size)");
    // camelCase envelope keys (Jason serialises the atoms verbatim).
    expect(repo).toContain("pageSize: page_size");
    expect(repo).toContain("totalPages: if(page_size > 0, do: ceil(total / page_size), else: 0)");
    // A filtered paged find still reads the embed (struct-mode predicate).
    expect(repo).toContain("record = row.data");
    expect(repo).toContain("record.status == status");
    // An unfiltered paged find must NOT bind an unused `record` (else -Werror).
    expect(repo).toContain("|> Enum.filter(fn _row -> true end)");
  });
});
