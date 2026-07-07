import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// vanilla-phoenix-gaps.md §14 — the vanilla (plain Ecto/Phoenix) aggregate REST
// controller's success-path `serialize/1` used to dump the raw Ecto struct
// (`Map.from_struct |> Map.drop([:__meta__, :__struct__])`), which diverged
// from the canonical cross-backend wire (Hono/.NET/Java/Python project from
// `wireShape` with the field name AS WRITTEN in the .ddd source):
//
//   1. snake_case keys — `commit_sha`/`build_state` instead of the canonical
//      `commitSha`/`buildState`.
//   2. leaked `inserted_at`/`updated_at` — Ecto's auto-`timestamps()` columns,
//      which are NOT in `wireShape` and no other backend emits.
//
// `serialize/1` is now driven by the aggregate's enriched `wireShape`: the key
// is the source name verbatim (camelCase), the Ecto column read resolves
// `snake(name)`, and contained parts get a nested `serialize_<part>/1` helper.
// ---------------------------------------------------------------------------

const SOURCE = `
system CamelWire {
  subdomain Core {
    context Builds {
      enum BuildState { queued, running, passed, failed }
      aggregate Build ids guid {
        name: string
        commitSha: string
        buildState: BuildState
        startedAt: datetime
        contains stages: Stage[]
        entity Stage { label: string  runCount: int }
      }
      repository Builds for Build { }
    }
  }
  api BuildsApi from Core
  storage pg { type: postgres }
  resource buildState { for: Builds, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Builds]
    dataSources: [buildState]
    serves: BuildsApi
    port: 4000
  }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla wireShape-driven serialize (camelCase keys, no timestamps)", () => {
  it("projects multi-word fields under their camelCase wire keys, not snake_case", async () => {
    const ctrl = file(await generateSystemFiles(SOURCE), "/controllers/build_controller.ex");
    // wireShape-driven map, not the raw struct dump.
    expect(ctrl).not.toContain("Map.from_struct()");
    expect(ctrl).toContain("defp serialize(record) do");
    // camelCase wire keys; the Ecto column read snake-cases the field name.
    expect(ctrl).toContain('"commitSha" => record.commit_sha');
    expect(ctrl).toContain('"buildState" => record.build_state');
    expect(ctrl).toContain('"startedAt" => record.started_at');
    // NOT the snake_case keys the struct dump produced.
    expect(ctrl).not.toContain('"commit_sha" =>');
    expect(ctrl).not.toContain('"build_state" =>');
  });

  it("does not leak Ecto's auto-timestamp columns onto the wire", async () => {
    const ctrl = file(await generateSystemFiles(SOURCE), "/controllers/build_controller.ex");
    expect(ctrl).not.toContain("inserted_at");
    expect(ctrl).not.toContain("updated_at");
  });

  it("emits a nested serialize helper for a contained part with camelCase keys", async () => {
    const ctrl = file(await generateSystemFiles(SOURCE), "/controllers/build_controller.ex");
    // The containment routes through a nil-safe nested serializer.
    expect(ctrl).toContain("defp serialize_stage(nil), do: nil");
    expect(ctrl).toContain("defp serialize_stage(record) do");
    expect(ctrl).toContain("Enum.map(record.stages || [], &serialize_stage/1)");
    // The multi-word child field is camelCase on the wire too.
    expect(ctrl).toContain('"runCount" => record.run_count');
  });

  it("keeps a bare single-word field as-is", async () => {
    const ctrl = file(await generateSystemFiles(SOURCE), "/controllers/build_controller.ex");
    expect(ctrl).toContain('"name" => record.name');
    expect(ctrl).toContain('"id" => record.id');
  });
});
