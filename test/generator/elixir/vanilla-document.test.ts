import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// `shape: document` persistence on the vanilla (plain Ecto) foundation —
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
      aggregate Cart shape: document with crudish {
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
    platform: elixir
    contexts: [Carts]
    dataSources: [cartState]
    serves: CartsApi
    port: 4000
  }
}
`;

// Same aggregate without shape: document — asserts the document path is gated
// off (relational columns + Map.from_struct serialize stay byte-identical).
const RELATIONAL = DOC.replace(" shape: document", "");

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla shape: document persistence (DEBT-07)", () => {
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
    // B5: the optimistic-concurrency `version` token is a ROOT column
    // (`field :version` on the row, stamped by `document_changeset`), NOT a field
    // inside the `:data` embed — if it leaked in, the embed's changeset would
    // `validate_required(:version)` while create (which never supplies it) would
    // fail with a 422 carrying an empty top-level `errors` array.
    const dataEmbed = schema.slice(schema.indexOf("defmodule Api.Carts.Cart.Data do"));
    expect(dataEmbed).not.toContain("field :version");
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
    // Update: cast_embed(on_replace: :update) merges onto the existing embed;
    // default-on versioning (M-T3.4) guards the write with `optimistic_lock`
    // over the client's expected version (stamped as the changeset's current
    // version), bumping it by one — a stale write raises StaleEntryError →
    // {:error, :conflict}.  No manual Map.merge.
    expect(repo).toContain(
      "def update(%Api.Carts.Cart{} = record, attrs, expected_version \\\\ nil)",
    );
    expect(repo).toContain("record = %{record | version: expected_version || record.version}");
    expect(repo).toContain("|> Api.Carts.CartChangeset.document_changeset(attrs, record.version)");
    expect(repo).toContain("|> Ecto.Changeset.optimistic_lock(:version)");
    expect(repo).toContain("Ecto.StaleEntryError -> {:error, :conflict}");
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
      aggregate Cart shape: document with crudish {
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
    platform: elixir
    contexts: [Carts]
    dataSources: [cartState]
    serves: CartsApi
    port: 4000
  }
}
`;

describe("vanilla shape: document scalar finds + named ops (Route A slice 2 — struct mode)", () => {
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
    // A `precondition` guard hoists into a `with ensure(...)` denial chain (422,
    // not a raise → 500) — the struct-mode read `record.item_count` is preserved.
    expect(ctx).toContain("with :ok <- ensure(record.item_count >= 0, :precondition_failed) do");
    expect(ctx).not.toContain("raise(ArgumentError");
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
      aggregate Cart shape: document with crudish {
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
    platform: elixir
    contexts: [Carts]
    dataSources: [cartState]
    serves: CartsApi
    port: 4000
  }
}
`;

describe("vanilla shape: document non-scalar residual (DEBT-07 follow-up)", () => {
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
    // The op guard calls the function passing the embed struct, reading the VO
    // sub-field — now hoisted into a `with ensure(...)` denial chain (422, not a
    // raise → 500); the call-site qualification `is_cheap(record)` + the VO
    // subfield read are preserved inside the ensure clause.
    expect(ctx).toContain("ensure(is_cheap(record), :precondition_failed)");
    expect(ctx).toContain(
      'ensure(Map.get(record.subtotal, :amount, Map.get(record.subtotal, "amount")) >= 0, :precondition_failed)',
    );
    expect(ctx).not.toContain("raise(ArgumentError");
  });

  it("emits returning ops as tagged tuples (error variant in-memory, mutating success persists)", async () => {
    const ctx = file(await generateSystemFiles(DOC_RICH), "/carts.ex");
    // An unconditional error-variant `return` never commits → {:error, "<tag>", <map>};
    // the row is unused (no embed read, no persist) so it's underscored (-Werror).
    expect(ctx).toContain(
      "def try_close_cart(%Api.Carts.Cart{} = _row, params) when is_map(params) do",
    );
    expect(ctx).toContain('{:error, "AlreadyClosed", %{message: "closed"}}');
    // #1774: a MUTATING fall-through success now PERSISTS the embed re-write (it
    // previously projected the mutated struct in memory and dropped the write) and
    // projects the aggregate wire off the SAVED embed.
    expect(ctx).toContain(
      "def bump_or_close_cart(%Api.Carts.Cart{} = row, params) when is_map(params) do",
    );
    expect(ctx).toContain("|> Ecto.Changeset.put_embed(:data, Map.from_struct(record))");
    expect(ctx).toContain("case Api.Carts.CartRepository.persist_change(changeset) do");
    expect(ctx).toContain(
      '{:ok, saved} -> {:ok, %{"id" => saved.id, "subtotal" => saved.data.subtotal, "itemCount" => saved.data.item_count, "version" => saved.version}}',
    );
    expect(ctx).toContain("{:error, changeset} -> {:error, changeset}");
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
      aggregate Order shape: document with crudish {
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
    platform: elixir
    contexts: [Orders]
    dataSources: [orderState]
    serves: OrdersApi
    port: 4000
  }
}
`;

describe("vanilla shape: document containments (Route A slice 4)", () => {
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
describe("vanilla shape: document paged finds (Route A slice 4c)", () => {
  const DOC_PAGED = `
system Shop {
  subdomain Sales {
    context Shop {
      enum Status { open, closed }
      aggregate Ticket shape: document with crudish {
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
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], serves: ShopApi, port: 4000 }
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

describe("vanilla shape: document union finds (Route A slice 4d)", () => {
  const DOC_UNION = `
system Shop {
  subdomain Sales {
    context Shop {
      error NotFound { }
      aggregate Cart shape: document with crudish {
        reference: string
      }
      repository Carts for Cart {
        find byRef(reference: string): Cart or NotFound where this.reference == reference
      }
    }
  }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], serves: ShopApi, port: 4000 }
}
`;

  it("returns the single-get {:ok, nil}/{:ok, record} tuple the union controller reads", async () => {
    const files = await generateSystemFiles(DOC_UNION);
    const repo = file(files, "/shop/cart_repository.ex");
    // A union find is a single-return in-memory filter → first match or nil.
    expect(repo).toContain(
      "@spec by_ref(term()) :: {:ok, Api.Shop.Cart.t() | nil} | {:error, term()}",
    );
    expect(repo).toContain("def by_ref(reference) do");
    expect(repo).toContain("record = row.data");
    expect(repo).toContain("record.reference == reference");
    expect(repo).toContain("{:ok, List.first(results)}");
  });

  it("translates the absent variant to the tagged union wire in the controller", async () => {
    const ctrl = file(await generateSystemFiles(DOC_UNION), "/cart_controller.ex");
    // Found → 200 body (untagged success variant); absent → RFC-7807 via the
    // shared problem_variant/5 responder (NotFound → 404).
    expect(ctrl).toContain("def by_ref(conn, params) do");
    expect(ctrl).toContain("{:ok, nil} ->");
    expect(ctrl).toContain("problem_variant(conn, 404,");
    expect(ctrl).toContain("{:ok, record} ->");
    expect(ctrl).toContain("json(conn, serialize(record))");
    expect(ctrl).toContain("defp problem_variant(conn, status, type, title, data) do");
  });
});

describe("vanilla shape: document audited named ops (Route A slice 4e)", () => {
  const DOC_AUDIT = `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Cart shape: document with crudish {
        total: int
        operation touch() audited { total := total + 1 }
        operation bump(by: int) audited {
          requires by > 0
          total := total + by
        }
      }
      repository Carts for Cart { }
    }
  }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], serves: ShopApi, port: 4000 }
}
`;

  it("records the audit row INSIDE the persist transaction (atomic with the embed re-write)", async () => {
    const facade = file(await generateSystemFiles(DOC_AUDIT), "/shop.ex");
    // before snapshot captured from the pre-mutation root row (document isDoc form).
    expect(facade).toContain(
      "audit_before = Map.merge(%{id: row.id}, (row.data && Map.from_struct(row.data)) || %{})",
    );
    // persist + audit share one transaction; the embed re-write bumps version.
    expect(facade).toContain("Api.Repo.transaction(fn ->");
    expect(facade).toContain("|> Ecto.Changeset.put_embed(:data, Map.from_struct(record))");
    expect(facade).toContain("case Api.Shop.CartRepository.persist_change(changeset) do");
    expect(facade).toContain('operation_id: "touchCart"');
    expect(facade).toContain("before: audit_before");
    expect(facade).toContain(
      "after: Map.merge(%{id: saved.id}, (saved.data && Map.from_struct(saved.data)) || %{})",
    );
    expect(facade).toContain("Api.Repo.rollback(reason)");
  });

  it("hoists a guarded audited op's guard OUTSIDE the persist transaction (denial → no audit)", async () => {
    const facade = file(await generateSystemFiles(DOC_AUDIT), "/shop.ex");
    // The guard short-circuits BEFORE the transaction — a denied op writes nothing
    // and records no audit row.
    const bump = facade.slice(facade.indexOf("def bump_cart("));
    expect(bump).toContain("with :ok <- ensure(by > 0, :forbidden) do");
    // audit_before + record bind precede the `with`; the tx is inside the `do`.
    expect(bump.indexOf("audit_before =")).toBeLessThan(bump.indexOf("with :ok <-"));
    expect(bump.indexOf("with :ok <-")).toBeLessThan(bump.indexOf("Api.Repo.transaction"));
  });
});

describe("vanilla shape: document returning ops persist their mutation (#1774)", () => {
  const DOC_RET = `
system Shop {
  subdomain Sales {
    context Shop {
      error TooMany { }
      aggregate Cart shape: document with crudish {
        total: int
        operation bumpFall(): Cart or TooMany {
          precondition total < 10
          total := total + 1
        }
        operation bumpReturn(): Cart or TooMany {
          precondition total < 10
          total := total + 1
          return this
        }
        operation peek(): Cart or TooMany {
          precondition total < 100
          return this
        }
      }
      repository Carts for Cart { }
    }
  }
  api ShopApi from Sales { httpStatus TooMany -> 409 }
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], serves: ShopApi, port: 4000 }
}
`;

  function op(facade: string, name: string): string {
    const start = facade.indexOf(`def ${name}(%`);
    return facade.slice(start, facade.indexOf("\n  end", start));
  }

  it("persists a MUTATING fall-through success + projects off the saved embed", async () => {
    const bump = op(file(await generateSystemFiles(DOC_RET), "/shop.ex"), "bump_fall_cart");
    expect(bump).toContain("record = %{record | total: record.total + 1}");
    expect(bump).toContain("|> Ecto.Changeset.change(%{version: row.version + 1})");
    expect(bump).toContain("|> Ecto.Changeset.put_embed(:data, Map.from_struct(record))");
    expect(bump).toContain("case Api.Shop.CartRepository.persist_change(changeset) do");
    expect(bump).toContain(
      '{:ok, saved} -> {:ok, %{"id" => saved.id, "total" => saved.data.total, "version" => saved.version}}',
    );
    expect(bump).toContain("{:error, changeset} -> {:error, changeset}");
  });

  it("persists a MUTATING trailing `return this` (normalized onto the persist path)", async () => {
    const bump = op(file(await generateSystemFiles(DOC_RET), "/shop.ex"), "bump_return_cart");
    // The trailing `return this` is excluded from the linear body and folded into
    // the aggregate-success projection off the saved embed (no inline in-memory return).
    expect(bump).toContain("|> Ecto.Changeset.put_embed(:data, Map.from_struct(record))");
    expect(bump).toContain(
      '{:ok, saved} -> {:ok, %{"id" => saved.id, "total" => saved.data.total, "version" => saved.version}}',
    );
  });

  it("leaves a NON-mutating returning op in-memory (no persist, byte-identical)", async () => {
    const peek = op(file(await generateSystemFiles(DOC_RET), "/shop.ex"), "peek_cart");
    // A pure read commits nothing — no changeset / put_embed / persist_change.
    expect(peek).not.toContain("put_embed");
    expect(peek).not.toContain("persist_change");
    expect(peek).toContain("{:ok, record}");
  });
});

describe("vanilla shape: document audited RETURNING ops (Route A slice 4f)", () => {
  const DOC_AUDIT_RET = `
system Shop {
  subdomain Sales {
    context Shop {
      error TooMany { }
      aggregate Cart shape: document with crudish {
        total: int
        operation bump() audited: Cart or TooMany {
          precondition total < 10
          total := total + 1
        }
      }
      repository Carts for Cart { }
    }
  }
  api ShopApi from Sales { httpStatus TooMany -> 409 }
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], serves: ShopApi, port: 4000 }
}
`;

  it("records the audit row INSIDE the persist transaction + projects off the saved embed", async () => {
    const facade = file(await generateSystemFiles(DOC_AUDIT_RET), "/shop.ex");
    const body = facade.slice(facade.indexOf("def bump_cart(%"));
    // Pre-mutation snapshot, guard hoist, persist + audit in one transaction.
    expect(body).toContain(
      "audit_before = Map.merge(%{id: row.id}, (row.data && Map.from_struct(row.data)) || %{})",
    );
    expect(body).toContain("with :ok <- ensure(record.total < 10, :precondition_failed) do");
    expect(body).toContain("Api.Repo.transaction(fn ->");
    expect(body).toContain("|> Ecto.Changeset.put_embed(:data, Map.from_struct(record))");
    expect(body).toContain('operation_id: "bumpCart"');
    expect(body).toContain("before: audit_before");
    // Post-commit success projects the aggregate wire off the saved embed.
    expect(body).toContain("case tx_result do");
    expect(body).toContain(
      '{:ok, saved} -> {:ok, %{"id" => saved.id, "total" => saved.data.total, "version" => saved.version}}',
    );
    expect(body).toContain("{:error, reason} -> {:error, reason}");
    // Guard precedes the transaction (a denial writes nothing + records no audit).
    expect(body.indexOf("with :ok <-")).toBeLessThan(body.indexOf("Api.Repo.transaction"));
  });
});
// Document-op guards deny 403/422, not raise → 500 (parity with the relational
// path).  A scalar/returning document op's `requires`/`precondition` hoists into
// a leading `with ensure(...)` chain — an expected denial returns a typed tuple
// the controller maps to 403 / 422, instead of raising an ArgumentError (500).
// A guard-free document op stays byte-identical.
// (docs/old/plans/phoenix-op-guards-403-422.md)
// ---------------------------------------------------------------------------
const DOC_GUARDS = `
system S {
  subdomain O {
    context O {
      error NotFound { resource: string }
      aggregate Note shape: document with crudish {
        title: string
        count: int
        // Guarded NAMED (mutating scalar) op.
        operation bump(by: int) {
          requires by > 0
          precondition count >= 0
          count := count + by
        }
        // Guarded RETURNING op.
        operation summary(): string or NotFound {
          requires title != ""
          return title
        }
        // Guard-free NAMED op — must stay byte-identical (no with/ensure).
        operation touch() {
          count := count + 1
        }
      }
      repository Notes for Note { }
    }
  }
  api A from O
  storage pg { type: postgres }
  resource st { for: O, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [O]
    dataSources: [st]
    serves: A
    port: 4000
  }
}
`;

describe("vanilla shape: document op guards deny 403/422 (not raise → 500)", () => {
  it("a guarded NAMED document op hoists guards into a `with ensure(...)` chain before the re-embed", async () => {
    const ctx = file(await generateSystemFiles(DOC_GUARDS), "lib/api/o.ex");
    const fn = ctx.slice(ctx.indexOf("def bump_note(%"));
    const body = fn.slice(0, fn.indexOf("\n  end"));
    // `record = row.data` + param binds precede the guards (guards read record).
    expect(body).toContain("record = row.data");
    // `requires` → 403 (`:forbidden`); `precondition` → 422 (`:precondition_failed`).
    expect(body).toContain("with :ok <- ensure(by > 0, :forbidden),");
    expect(body).toContain(":ok <- ensure(record.count >= 0, :precondition_failed) do");
    // The mutation + re-embed persist run INSIDE the with-do (denial short-circuits
    // before any write).
    const withAt = body.indexOf("with :ok <- ensure");
    const mutAt = body.indexOf("record = %{record | count:");
    const embedAt = body.indexOf("Ecto.Changeset.put_embed(:data");
    expect(withAt).toBeGreaterThan(-1);
    expect(withAt).toBeLessThan(mutAt);
    expect(mutAt).toBeLessThan(embedAt);
    // NOT a raise — an expected denial is no longer a 500.
    expect(body).not.toContain("raise(ArgumentError");
    // The shared `ensure/2` helper is emitted (document op now needs it).
    expect(ctx).toContain("defp ensure(true, _reason), do: :ok");
    expect(ctx).toContain("defp ensure(false, reason), do: {:error, reason}");
  });

  it("a guarded RETURNING document op returns the denial tuple over a `with ensure(...)` chain", async () => {
    const ctx = file(await generateSystemFiles(DOC_GUARDS), "lib/api/o.ex");
    const fn = ctx.slice(ctx.indexOf("def summary_note(%"));
    const body = fn.slice(0, fn.indexOf("\n  end"));
    expect(body).toContain('with :ok <- ensure(record.title != "", :forbidden) do');
    expect(body).toContain("{:ok, record.title}");
    expect(body).not.toContain("raise(ArgumentError");
  });

  it("a GUARD-FREE document op stays flat (no with/ensure wrap)", async () => {
    const ctx = file(await generateSystemFiles(DOC_GUARDS), "lib/api/o.ex");
    const fn = ctx.slice(ctx.indexOf("def touch_note(%"));
    const body = fn.slice(0, fn.indexOf("\n  end"));
    expect(body).not.toContain("with :ok <- ensure");
    // Flat: record bind → mutation → re-embed persist, no denial wrap.
    expect(body).toContain("record = row.data");
    expect(body).toContain("record = %{record | count: record.count + 1}");
  });

  it("the document-op controller maps the denial atoms to 403 / 422", async () => {
    const files = await generateSystemFiles(DOC_GUARDS);
    const ctl = file(files, "/controllers/note_controller.ex");
    // NAMED op → `else` arms; RETURNING op → result-fn clauses.  Same status +
    // ProblemDetails body as the relational / ES-command path.
    expect(ctl).toContain(
      'ProblemDetails.problem_response(conn, 403, "Forbidden", "Operation not permitted")',
    );
    expect(ctl).toContain(
      'ProblemDetails.problem_response(conn, 422, "Unprocessable Entity", "A precondition failed")',
    );
    expect(ctl).toContain("def summary_note_result(conn, {:error, :forbidden}),");
    expect(ctl).toContain("def summary_note_result(conn, {:error, :precondition_failed}),");
  });
});
