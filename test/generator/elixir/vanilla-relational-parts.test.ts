import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// §11c — nested entity parts on a RELATIONAL (default-shape) vanilla (plain
// Ecto) aggregate.  `contains pipelines: Pipeline[]` persists as a child TABLE
// (`pipelines`): the part schema is table-backed (`schema "pipelines"`) with a
// `belongs_to` back to its owner (the `project_id` FK the shared child-table
// migration emits), the root `has_many`s + `cast_assoc`s it, and every read
// `Repo.preload`s it — the vanilla analogue of the value-object collection
// `has_many` path.  CORE slice: persist + read (no in-op containment mutation —
// that stays validator-gated as the §11c follow-up).
// ---------------------------------------------------------------------------

const SOURCE = `
system RelParts {
  subdomain Core {
    context Catalog {
      aggregate Project ids guid {
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
    platform: elixir { foundation: vanilla }
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
  });

  it("base_changeset cast_assocs the containment (replace-on-update via on_replace)", async () => {
    const cs = file(await generateSystemFiles(SOURCE), "/catalog/project_changeset.ex");
    expect(cs).toContain("|> cast_assoc(:pipelines, with: &Api.Catalog.Pipeline.changeset/2)");
    expect(cs).not.toContain("cast_embed(:pipelines)");
  });

  it("the repository preloads the containment on every read (so the wire shape materialises)", async () => {
    const repo = file(await generateSystemFiles(SOURCE), "/catalog/project_repository.ex");
    // list + find_by_id both preload :pipelines.
    expect(repo).toContain("Repo.all(Api.Catalog.Project) |> Repo.preload([:pipelines])");
    expect(repo).toContain("record -> {:ok, record |> Repo.preload([:pipelines])}");
    // update preloads the existing assoc before cast_assoc.
    expect(repo).toContain("record |> Repo.preload([:pipelines])");
  });

  it("the child-table migration matches the schema (project_id FK → projects)", async () => {
    const mig = file(await generateSystemFiles(SOURCE), "_create_pipelines.exs");
    expect(mig).toContain("create table(:pipelines");
    expect(mig).toContain("add :project_id, references(:projects");
    expect(mig).toContain("timestamps()");
  });
});

// ---------------------------------------------------------------------------
// §11c follow-up — in-operation MUTATION of a relational containment.
// `pipelines += Pipeline{…}` appends the part struct to the preloaded has_many
// and the named-op persist tail `put_assoc`s the mutated collection (the
// relational analog of the embedded path's `put_embed`).
// ---------------------------------------------------------------------------

const MUTATE_SOURCE = `
system RelMut {
  subdomain Core {
    context Catalog {
      aggregate Project ids guid {
        name: string
        active: bool
        contains pipelines: Pipeline[]
        entity Pipeline { label: string  runCount: int }
        operation addPipeline(label: string) {
          pipelines += Pipeline { label: label, runCount: 0 }
        }
      }
      repository Projects for Project { }
    }
  }
  api CatalogApi from Core
  storage pg { type: postgres }
  resource projectState { for: Catalog, kind: state, use: pg }
  deployable api {
    platform: elixir { foundation: vanilla }
    contexts: [Catalog]
    dataSources: [projectState]
    serves: CatalogApi
    port: 4000
  }
}
`;

describe("vanilla relational containment op-mutation (§11c follow-up)", () => {
  it("the named op local-binds the mutated child list and put_assocs it (not put_embed, not record-rebind)", async () => {
    const ctx = file(await generateSystemFiles(MUTATE_SOURCE), "/catalog.ex");
    // Local-bind the new child list (NOT `record = %{record | pipelines: …}`) so
    // the persist diffs the put list against the ORIGINAL loaded `has_many`.
    expect(ctx).toContain(
      "pipelines = (record.pipelines || []) ++ [%Api.Catalog.Pipeline{label: label, run_count: 0}]",
    );
    expect(ctx).not.toContain("record = %{record | pipelines:");
    // Persist put_assocs the LOCAL (not `record.pipelines`).
    expect(ctx).toContain("|> Ecto.Changeset.put_assoc(:pipelines, pipelines)");
    expect(ctx).not.toContain("put_embed(:pipelines");
  });
});
