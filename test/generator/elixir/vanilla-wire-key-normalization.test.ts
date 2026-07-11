import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Two runtime CRUD bugs the showcase 5-backend behavioral run surfaced on the
// vanilla Phoenix backend (invisible to the OpenAPI spec-diff):
//
//   1. camelCase wire keys weren't snake-normalized before `Ecto.cast`, so every
//      multi-word field (`commitSha` → `:commit_sha`) was dropped → spurious 422.
//   2. the changeset-error renderer `to_string`d composite-type opts
//      (`type: {:array, :string}`) → `Protocol.UndefinedError` (Tuple) → 500
//      instead of 422.
// ---------------------------------------------------------------------------

const SOURCE = `
system WireKeys {
  subdomain Core {
    context Shop {
      aggregate Order {
        commitSha: string
        startedAt: datetime
        tags: string[]?
        invariant commitSha.length > 0
      }
      repository Orders for Order { }
    }
  }
  api ShopApi from Core
  storage pg { type: postgres }
  resource orderState { for: Shop, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Shop]
    dataSources: [orderState]
    serves: ShopApi
    port: 4000
  }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla CRUD wire-key normalization + changeset-error rendering", () => {
  it("base_changeset snake-normalizes the top-level wire keys before cast", async () => {
    const cs = file(await generateSystemFiles(SOURCE), "/shop/order_changeset.ex");
    // The camelCase→snake normalization runs first, via Macro.underscore.
    expect(cs).toContain("attrs = __normalize_keys(attrs)");
    expect(cs).toContain("defp __normalize_keys(attrs) when is_map(attrs) do");
    expect(cs).toContain("{k, v} when is_binary(k) -> {Macro.underscore(k), v}");
    // Multi-word column is cast under its snake atom (so a normalized
    // "commitSha" → "commit_sha" matches).
    expect(cs).toContain(":commit_sha");
  });

  it("the ProblemDetails renderer stringifies non-String.Chars opt values safely", async () => {
    const pd = file(await generateSystemFiles(SOURCE), "_web/problem_details.ex");
    // Composite-type opts (e.g. type: {:array, :string}) must not crash the
    // 422 renderer — they fall through to inspect/1, not a bare to_string/1.
    expect(pd).toContain("error_opt_to_string(value)");
    expect(pd).toContain("defp error_opt_to_string(value), do: inspect(value)");
    // The reduce no longer calls to_string/1 directly on the opt value.
    expect(pd).not.toContain('String.replace(acc, "%{#{key}}", to_string(value))');
  });
});
