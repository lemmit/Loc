import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// §11c — nested entity parts on a RELATIONAL (default-shape) vanilla (plain
// Ecto) aggregate.  `contains pipelines: Pipeline[]` persists as a child TABLE
// (`pipelines`): the part schema is table-backed (`schema "pipelines"`) with a
// `belongs_to` back to its owner (the `project_id` FK the shared child-table
// migration emits), the root `has_many`s + `cast_assoc`s it, and every read
// `Repo.preload`s it — the vanilla analogue of the value-object collection
// `has_many` path.  Persist + read AND in-operation mutation
// (`pipelines += Pipeline { … }`) are wired: the op persist tail `put_assoc`s the
// mutated part-struct list (the schema's `on_replace: :delete` rewrites the child
// rows) — the relational analogue of the embedded `put_embed` path.
// ---------------------------------------------------------------------------

const SOURCE = `
system RelParts {
  subdomain Core {
    context Catalog {
      aggregate Project {
        name: string
        active: bool
        contains pipelines: Pipeline[]
        entity Pipeline { label: string  runCount: int }
      }
      repository Projects for Project {
        find byName(n: string): Project[] where this.name == n
      }
    }
  }
  api CatalogApi from Core
  storage pg { type: postgres }
  resource projectState { for: Catalog, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Catalog]
    dataSources: [projectState]
    serves: CatalogApi
    port: 4000
  }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla relational entity parts (§11c)", () => {
  it("the root schema has_many's the part (relational, not embeds_many; no field)", async () => {
    const project = file(await generateSystemFiles(SOURCE), "/catalog/project.ex");
    expect(project).toContain(
      "has_many :pipelines, Api.Catalog.Pipeline, foreign_key: :project_id, on_replace: :delete",
    );
    expect(project).not.toContain("embeds_many :pipelines");
    expect(project).not.toContain("field :pipelines");
  });

  it("emits the part as a table-backed schema with belongs_to + timestamps + Jason encoder", async () => {
    const pipeline = file(await generateSystemFiles(SOURCE), "/catalog/pipeline.ex");
    expect(pipeline).toContain("use Ecto.Schema");
    expect(pipeline).toContain("@derive {Jason.Encoder, only: [:id, :label, :run_count]}");
    // Table-backed schema (a real table), NOT an embedded_schema.
    expect(pipeline).toContain('schema "pipelines" do');
    expect(pipeline).not.toContain("embedded_schema");
    expect(pipeline).toContain("field :label, :string");
    expect(pipeline).toContain("field :run_count, :integer");
    expect(pipeline).toContain(
      "belongs_to :project, Api.Catalog.Project, foreign_key: :project_id, type: :binary_id",
    );
    // The child table carries NOT-NULL timestamps in the migration → auto-stamp.
    expect(pipeline).toContain("timestamps(type: :utc_datetime)");
    expect(pipeline).toContain("cast(attrs, [:label, :run_count])");
    // §15: the part changeset snakes ITS OWN top-level keys, so a `cast_assoc`
    // nested body with camelCase keys (`{"runCount": 3}`) casts cleanly instead of
    // dropping `run_count` → not-null violation.
    expect(pipeline).toContain("attrs = __normalize_keys(attrs)");
    expect(pipeline).toContain("defp __normalize_keys(attrs) when is_map(attrs) do");
    expect(pipeline).toContain("{k, v} when is_binary(k) -> {Macro.underscore(k), v}");
  });

  it("base_changeset cast_assocs the containment (create path), but update_changeset does NOT", async () => {
    const cs = file(await generateSystemFiles(SOURCE), "/catalog/project_changeset.ex");
    // Create seam casts the containment (so a create body can seed pipelines).
    expect(cs).toContain("|> cast_assoc(:pipelines, with: &Api.Catalog.Pipeline.changeset/2)");
    expect(cs).not.toContain("cast_embed(:pipelines)");
    // Generic PATCH seam must NOT touch the containment — a `PATCH {"pipelines":
    // []}` would otherwise bulk-delete the child rows (on_replace: :delete),
    // bypassing the aggregate's own `addPipeline` precondition.  Containment
    // mutation goes through operations, so `update_changeset` casts scalars only.
    const updateCs = cs.slice(cs.indexOf("def update_changeset"));
    expect(cs).toContain("def update_changeset(struct, attrs) do");
    expect(updateCs).not.toContain("cast_assoc(:pipelines");
  });

  it("the repository preloads the containment on every read (so the wire shape materialises)", async () => {
    const repo = file(await generateSystemFiles(SOURCE), "/catalog/project_repository.ex");
    // list + find_by_id both preload :pipelines.
    expect(repo).toContain("Repo.all(Api.Catalog.Project) |> Repo.preload([:pipelines])");
    expect(repo).toContain("record -> {:ok, record |> Repo.preload([:pipelines])}");
    // update preloads the existing assoc before cast_assoc.
    expect(repo).toContain("record |> Repo.preload([:pipelines])");
    // insert preloads the containment on its RESULT: a create body that omits
    // `pipelines` leaves the assoc `%Ecto.Association.NotLoaded{}` (cast_assoc
    // doesn't touch an absent key), and the serializer's `Map.from_struct` would
    // then hand that sentinel to Jason → `cannot encode association … not loaded`.
    expect(repo).toContain("      {:ok, record} -> {:ok, record |> Repo.preload([:pipelines])}");
  });

  it("the child-table migration matches the schema (project_id FK → projects)", async () => {
    const mig = file(await generateSystemFiles(SOURCE), "_create_pipelines.exs");
    expect(mig).toContain("create table(:pipelines");
    expect(mig).toContain("add :project_id, references(:projects");
    expect(mig).toContain("timestamps()");
  });
});

// ---------------------------------------------------------------------------
// §11c follow-up — in-operation mutation of a RELATIONAL containment.  An
// `operation addPipeline(...) { pipelines += Pipeline { … } }` body appends the
// part STRUCT (`%Api.Catalog.Pipeline{…}`) to the threaded `record` and the
// persist tail `put_assoc`s the mutated list (NOT `put_embed`, which is the
// embedded-shape path).  The schema's `on_replace: :delete` rewrites the child
// rows.  Mirrors `vanilla-embed-parts.test.ts`'s `put_embed` assertion.
// ---------------------------------------------------------------------------

const MUTATION_SOURCE = `
system RelMut {
  subdomain Core {
    context Catalog {
      aggregate Project {
        name: string
        contains pipelines: Pipeline[]
        entity Pipeline { label: string }
        operation addPipeline(label: string) {
          pipelines += Pipeline { label: label }
        }
      }
      repository Projects for Project {
        find byName(n: string): Project[] where this.name == n
      }
    }
  }
  api CatalogApi from Core
  storage pg { type: postgres }
  resource projectState { for: Catalog, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Catalog]
    dataSources: [projectState]
    serves: CatalogApi
    port: 4000
  }
}
`;

describe("vanilla relational containment mutation (§11c put_assoc)", () => {
  it("the op body appends the part struct and persists via put_assoc(__put_assoc_parts), not put_embed", async () => {
    const ctx = file(await generateSystemFiles(MUTATION_SOURCE), "/catalog.ex");
    // The body appends a part STRUCT (renderNew emits `%Ctx.Part{…}`) to the
    // threaded record's containment list.
    expect(ctx).toContain(
      "record = %{record | pipelines: (record.pipelines || []) ++ [%Api.Catalog.Pipeline{label: label}]}",
    );
    // RELATIONAL containment → put_assoc over the list NORMALISED to maps by the
    // context helper (a bare struct with a nil PK is not inserted by put_assoc —
    // boot-verified).  The schema carries `on_replace: :delete`.
    expect(ctx).toContain(
      "|> Ecto.Changeset.put_assoc(:pipelines, __put_assoc_parts(record.pipelines))",
    );
    // NOT the embedded path's put_embed.
    expect(ctx).not.toContain("put_embed(:pipelines");
    // The normalising helper is emitted once on the context module.
    expect(ctx).toContain("defp __put_assoc_parts(list) when is_list(list) do");
    expect(ctx).toContain("|> Map.drop([:__meta__, :inserted_at, :updated_at])");
  });
});
