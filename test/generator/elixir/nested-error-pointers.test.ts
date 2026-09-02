import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// F2-W-03 / `nested-errors-pointer-shape` (elixir arm) — a Phoenix 422's
// `errors[]` pointers could only ever be DEPTH-1.
//
// `ProblemDetails.validation_error_response/2` built the array from a flat
// `changeset.errors |> Enum.map(&render_changeset_error/1)` walk, and
// `render_changeset_error/1` called `pointer_of([field])` — one segment, always.
// That is wrong in two independent ways, and each has its own carrier:
//
//   * `Ecto.Changeset.errors` holds the TOP LEVEL ONLY.  A `cast_embed` /
//     `cast_assoc` child (a containment part, a value-object collection row)
//     keeps its errors on its own changeset under `changes`, so a nested
//     violation answered 422 with `errors: []` — a body naming no field at all.
//
//   * A VALUE OBJECT is not an embed: it persists as one jsonb `:map` column and
//     is checked by `validate_vo/3` under `validate_change/3`, which collapsed
//     the VO's whole changeset into `[{field, "is invalid"}]`.  That threw away
//     the inner field name, the AUTHORED message, and the `loom_code` the i18n
//     catalog is keyed by — so `{"sku": {"code": "ab"}}` answered
//     `{"pointer":"/sku","message":"is invalid"}` where the other four name
//     `/sku/code` and repeat the author's text.
//
// The other four backends all walk the full path — .NET's `PointerOf`
// (`Items[0].Qty` → `/items/0/qty`), node's `pointerOf(issue.path)`, python's
// `_pointer(loc)` — and java, the other half of the same ledger row, emits a
// non-RFC-6901 `/lineTotals[0].unitPrice`.  RFC 6901 is the target on both.
// ---------------------------------------------------------------------------

const SRC = `
system NP {
  subdomain Shop {
    context Sales {
      valueobject Sku {
        code: string
        invariant code.length >= 3 message "SKU code needs at least 3 characters"
      }
      aggregate Order with crudish {
        sku: Sku
        contains lines: LineItem[]
        entity LineItem { qty: int }
      }
      repository Orders for Order { }
    }
  }
  api A from Shop
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg }
  deployable d { platform: elixir, contexts: [Sales], dataSources: [salesState], serves: A, port: 4000 }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("elixir/vanilla — a 422 names the nested field it rejected", () => {
  it("ProblemDetails walks child changesets, prefixing field and collection index", async () => {
    const pd = file(await generateSystemFiles(SRC), "/problem_details.ex");

    // The entry point no longer reads `changeset.errors` directly.
    expect(pd).toContain("send_validation_problem(conn, collect_changeset_errors(changeset, []))");
    expect(pd).not.toContain("|> Enum.map(&render_changeset_error/1)");

    // The RECURSION IS CALLED.  Asserting only that the `collect_nested_errors`
    // clauses exist passes with the call site deleted — the helpers sit there as
    // dead code and every nested error is dropped exactly as before.  This is
    // the assertion the mutation has to break.
    expect(pd).toContain(
      "own ++ Enum.flat_map(changeset.changes, &collect_nested_errors(&1, prefix))",
    );

    // A single `cast_embed`/`cast_assoc` child contributes its parent's field…
    expect(pd).toContain(
      "defp collect_nested_errors({field, %Ecto.Changeset{} = child}, prefix) do",
    );
    expect(pd).toContain("collect_changeset_errors(child, prefix ++ [field])");
    // …and a COLLECTION contributes field + index, so the pointer is
    // `/lines/0/qty` — RFC 6901 — not java's `/lines[0].qty`.
    expect(pd).toContain(
      "defp collect_nested_errors({field, values}, prefix) when is_list(values) do",
    );
    expect(pd).toContain(
      "{%Ecto.Changeset{} = child, index} -> collect_changeset_errors(child, prefix ++ [field, index])",
    );
    // A non-changeset change (an ordinary scalar) contributes nothing.
    expect(pd).toContain("defp collect_nested_errors(_change, _prefix), do: []");

    // `pointer_of/1` already renders integer segments; the depth-1 call site is
    // what made it unreachable.
    expect(pd).toContain(
      "defp segment_to_string(seg) when is_integer(seg), do: Integer.to_string(seg)",
    );
    expect(pd).toContain("pointer_of(prefix ++ [field] ++ Keyword.get(opts, :loom_path, []))");
    expect(pd).not.toContain("pointer_of([field])");
  });

  it("a value object forwards its OWN errors — inner path, authored message, loom_code", async () => {
    const cs = file(await generateSystemFiles(SRC), "/order_changeset.ex");

    // The collapse this replaces.  `"is invalid"` survives only as the floor
    // for an `{:error, changeset}` carrying NO errors (see below).
    expect(cs).not.toContain("if is_map(value) and match?({:error, _}, new_fun.(value)),");

    expect(cs).toContain("if is_map(value), do: __vo_errors(field, new_fun.(value)), else: []");
    expect(cs).toContain(
      "defp __vo_errors(field, {:error, %Ecto.Changeset{errors: [_ | _] = errors}}) do",
    );
    // The message and its opts (which carry `loom_code`) ride through verbatim;
    // only the inner FIELD is added, on `loom_path`, for ProblemDetails to splice
    // into the pointer.
    expect(cs).toContain("{field, {msg, Keyword.put(opts, :loom_path, [inner_field])}}");
    // An error-less `{:error, _}` must NOT return `[]` — that would persist a
    // value the value object rejected.  Never a silent pass.
    expect(cs).toContain('defp __vo_errors(field, {:error, _}), do: [{field, "is invalid"}]');
    expect(cs).toContain("defp __vo_errors(_field, _ok), do: []");
  });
});
