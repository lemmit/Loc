// ---------------------------------------------------------------------------
// Vanilla per-aggregate Changeset module — `lib/<app>/<ctx>/<agg>_changeset.ex`.
// Slice 2 of vanilla-foundation-tdd-plan.md.
//
// Plain Ecto.Changeset cast/3 + validate_required.  Per-action
// `change_<op>/2` helpers wrap the basic cast with the action's param
// allow-list, mirroring what `with crudish` would expose on the Ash
// path.  Per-field `validate_*` (length, format, …) deferred to a later
// slice.  The constraints ARE available at the IR layer now —
// `src/ir/validate/invariant-classify.ts`'s `singleFieldShape` yields
// min/max/between/len-*/regex patterns from invariants (the same
// classifier Zod and FluentValidation consume); this emitter just
// doesn't consume it yet.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  OperationIR,
  SystemIR,
} from "../../../ir/types/loom-ir.js";
import { singleFieldConstraints } from "../../../ir/validate/invariant-classify.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { ectoValidator, voHasConstraints } from "./changeset-validators.js";
import { isVanillaDocAgg, renderDocChangeset } from "./document-emit.js";
import { isEventSourced } from "./eventsourced-emit.js";
import { valueCollectionsWithVo } from "./value-collection-schema-emit.js";

interface AggField {
  name: string;
  type: { kind: string; name?: string; inner?: { kind: string; name?: string } };
  optional?: boolean;
  access?: string;
}

const SYSTEM_FIELDS = new Set(["id", "createdAt", "updatedAt"]);

/** A lifecycle-managed field (audit `createdBy`/`updatedBy`, etc.) is never cast
 *  from client attrs nor `validate_required`d — the server owns its value and
 *  the lifecycle stamp `put_change`s it on the changeset right before persist
 *  (see `stampPutChanges`).  Casting it would let a client spoof the actor; a
 *  `validate_required` on it would reject the create before the stamp runs. */
function isManaged(f: AggField): boolean {
  return f.access === "managed";
}

export function emitVanillaChangesets(
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
  sys?: SystemIR,
): void {
  const ctxModule = upperFirst(ctx.name);
  for (const agg of ctx.aggregates) {
    // Event-sourced aggregates mutate via emit+fold, not Ecto changesets.
    if (isEventSourced(agg)) continue;
    const aggSnake = snake(agg.name);
    const ctxSnake = snake(ctx.name);
    const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
    out.set(
      `lib/${appSnake}/${ctxSnake}/${aggSnake}_changeset.ex`,
      isVanillaDocAgg(agg, ctx, sys)
        ? renderDocChangeset(appModule, ctxModule, agg)
        : renderChangeset(appModule, ctxModule, agg, ctx),
    );
  }
}

function renderChangeset(
  appModule: string,
  ctxModule: string,
  agg: AggregateIR,
  ctx: BoundedContextIR,
): string {
  const aggPascal = upperFirst(agg.name);
  const aggModule = `${appModule}.${ctxModule}.${aggPascal}`;
  const changesetMod = `${aggModule}Changeset`;
  // Value-object collection fields (`charges: Money[]`) are `has_many`
  // associations cast via `cast_assoc`, NOT scalar columns — exclude them from
  // the flat `cast`/`validate_required` field lists (casting an association
  // field raises `unknown field`).
  const vcFieldNames = new Set(valueCollectionsWithVo(agg, ctx).map((v) => v.vc.fieldName));
  const allFields = (agg.fields as AggField[]).filter(
    (f) => !SYSTEM_FIELDS.has(f.name) && !isManaged(f) && !vcFieldNames.has(f.name),
  );
  const requiredFields = allFields.filter((f) => !f.optional);

  const allCols = allFields.map((f) => `:${snake(f.name)}`).join(", ");
  const requiredCols = requiredFields.map((f) => `:${snake(f.name)}`).join(", ");

  // Per-field constraint validators derived from single-field invariants (the
  // same `singleFieldConstraints` classifier Zod / FluentValidation / the Java
  // validator consume) — `f >= N` → `validate_number`, `f.length <= N` →
  // `validate_length`, `f.matches(r)` → `validate_format`.  Guarded / cross-field
  // invariants return null and keep their domain-level enforcement.  Only fields
  // that are actually cast (`@all_fields`) get a validator.
  const castFields = new Set(allFields.map((f) => snake(f.name)));
  const validatorLines = (agg.invariants ?? [])
    .flatMap((inv) => singleFieldConstraints(inv) ?? [])
    .filter((c) => castFields.has(snake(c.field)))
    .map((c) => ectoValidator(snake(c.field), c.pattern));
  const validatorBlock = validatorLines.length > 0 ? `\n${validatorLines.join("\n")}` : "";

  // Containments (`embeds_many`/`embeds_one`) round-trip via `cast_embed` — and
  // crucially it forces the embed into the INSERT (an untouched `embeds_many`
  // writes NULL, violating the `null: false` jsonb column the shared migration
  // emits).  Each delegates to the part module's `changeset/2`.
  const castEmbedLines = agg.contains.map((c) => `    |> cast_embed(:${snake(c.name)})`).join("\n");
  const castEmbedBlock = castEmbedLines.length > 0 ? `\n${castEmbedLines}` : "";

  // Value-object collections (`charges: Money[]`) round-trip via `cast_assoc`
  // onto the child schema (`on_replace: :delete` gives replace-on-update).  The
  // ordinal is stamped into the RAW attrs element maps up front (see
  // `prepare_vc_attrs/1`), NOT onto the cast child changesets — Ecto forbids a
  // second `put_change` over a `cast_assoc` result ("cannot replace related …"),
  // which is exactly what a post-cast ordinal stamp would do on update.
  const valueCollections = valueCollectionsWithVo(agg, ctx);
  const castAssocLines = valueCollections
    .map(({ vc }) => {
      const f = snake(vc.fieldName);
      const childMod = `${appModule}.${ctxModule}.${vc.childTable
        .split("_")
        .map(upperFirst)
        .join("")}`;
      return `    |> cast_assoc(:${f}, with: &${childMod}.changeset/2)`;
    })
    .join("\n");
  const castAssocBlock = castAssocLines.length > 0 ? `\n${castAssocLines}` : "";
  // Attrs preprocessing for every value-collection field, done ONCE on the raw
  // attrs before `cast`/`cast_assoc`: (1) alias the camelCase wire key onto the
  // snake_case association key (the wire body is camelCase, Ecto associations are
  // snake_case); (2) stamp a positional `:ordinal` into each element map (the
  // client body carries none) so the array round-trips in declared order.  The
  // child schema's `changeset/2` casts `:ordinal`, so it flows through naturally.
  const vcSnakeKeys = valueCollections.map(({ vc }) => `"${snake(vc.fieldName)}"`);
  const keyAliasPairs = valueCollections
    .map(({ vc }) => {
      const camel = vc.fieldName; // already camelCase as authored
      const snk = snake(vc.fieldName);
      return camel === snk ? null : `      {${JSON.stringify(camel)}, ${JSON.stringify(snk)}}`;
    })
    .filter((p): p is string => p !== null);
  const aliasReduce =
    keyAliasPairs.length > 0
      ? `Enum.reduce(
      [
${keyAliasPairs.join(",\n")}
      ],
      attrs,
      fn {camel, snake_key}, acc ->
        case Map.fetch(acc, camel) do
          {:ok, v} -> acc |> Map.delete(camel) |> Map.put(snake_key, v)
          :error -> acc
        end
      end
    )`
      : "attrs";
  const normalizeHelper =
    valueCollections.length > 0
      ? `

  # Normalize the raw attrs for every value-collection field: alias the
  # camelCase wire key → snake association key, then stamp a positional ordinal
  # into each element map (before cast_assoc, so Ecto tracks one change per assoc).
  defp prepare_vc_attrs(attrs) when is_map(attrs) do
    attrs = ${aliasReduce}

    Enum.reduce([${vcSnakeKeys.join(", ")}], attrs, fn key, acc ->
      case Map.fetch(acc, key) do
        {:ok, items} when is_list(items) ->
          stamped =
            items
            |> Enum.with_index()
            |> Enum.map(fn {item, i} ->
              if is_map(item), do: Map.put(item, "ordinal", i), else: item
            end)

          Map.put(acc, key, stamped)

        _ -> acc
      end
    end)
  end

  defp prepare_vc_attrs(attrs), do: attrs`
      : "";
  const ordinalHelper = "";

  // Value-object invariant enforcement (F5).  A VO field is stored as a plain
  // `:map`, so `cast` accepts any object; we run the VO's own validating
  // constructor over the cast value to reject an invariant-violating VO (e.g. a
  // negative `Money`) at the real create/update path — not just in tests.  Only
  // single VO fields whose VO declares a single-field invariant get a line; a
  // VO without invariants (or an array-of-VO field) is left as-is.
  const vosByName = new Map(ctx.valueObjects.map((vo) => [vo.name, vo]));
  const voFieldLines = allFields
    .map((f) => {
      // Resolve the VO name, unwrapping an `optional` (`price: Money?`) — the
      // optional wrapper otherwise hides the value-object type and the field
      // would skip validation (the negative-price-accepted regression).
      const voName =
        f.type.kind === "valueobject"
          ? f.type.name
          : f.type.kind === "optional" && f.type.inner?.kind === "valueobject"
            ? f.type.inner.name
            : undefined;
      if (!voName) return null;
      const vo = vosByName.get(voName);
      if (!vo || !voHasConstraints(vo)) return null;
      const voMod = `${appModule}.${ctxModule}.${upperFirst(vo.name)}`;
      return `    |> validate_vo(:${snake(f.name)}, &${voMod}.new/1)`;
    })
    .filter((l): l is string => l !== null);
  const voBlock = voFieldLines.length > 0 ? `\n${voFieldLines.join("\n")}` : "";
  // The shared helper is emitted only when a VO field uses it (no unused defp
  // under `mix compile --warnings-as-errors`).
  const voHelper =
    voFieldLines.length > 0
      ? `

  # Run a value object's validating constructor over a cast map field; an
  # invariant violation surfaces as a changeset error rather than persisting.
  defp validate_vo(changeset, field, new_fun) do
    validate_change(changeset, field, fn ^field, value ->
      if is_map(value) and match?({:error, _}, new_fun.(value)),
        do: [{field, "is invalid"}],
        else: []
    end)
  end`
      : "";

  // Per-action changeset helpers — create + destroy.  Named OPERATIONS no
  // longer get a `change_<op>` helper: their `<op>_<agg>` context fn renders the
  // body and `put_change`s the assigned columns directly (context-emit).  The
  // old operation helper `cast`d the op's *params*, which raises `unknown field`
  // at runtime whenever a param isn't a column (e.g. `reprice(qty, price)`).
  const actionHelpers = [
    ...(agg.creates ?? []).map((op) => renderActionHelper(aggModule, op, "create", vcFieldNames)),
    ...(agg.destroys ?? []).map((op) => renderActionHelper(aggModule, op, "destroy", vcFieldNames)),
  ]
    .filter(Boolean)
    .join("\n\n");

  return `# Auto-generated.
defmodule ${changesetMod} do
  @moduledoc false
  import Ecto.Changeset
  alias ${aggModule}

  @all_fields [${allCols}]
  @required_fields [${requiredCols}]

  @doc "Default cast/3 helper applied by every per-action changeset below."
  def base_changeset(struct \\\\ %${aggPascal}{}, attrs) do
    ${valueCollections.length > 0 ? "attrs = prepare_vc_attrs(attrs)\n\n    " : ""}struct
    |> cast(attrs, @all_fields)
    |> validate_required(@required_fields)${validatorBlock}${castEmbedBlock}${castAssocBlock}${voBlock}
  end${voHelper}${normalizeHelper}${ordinalHelper}

${actionHelpers}
end
`;
}

function renderActionHelper(
  aggModule: string,
  op: OperationIR,
  kind: "create" | "operation" | "destroy",
  /** Value-object collection field names — excluded from a cast allow-list
   *  (they are `has_many` associations cast via `cast_assoc`, not columns). */
  vcFieldNames: ReadonlySet<string> = new Set(),
): string {
  const aggPascal = aggModule.split(".").pop()!;
  const opName = snake(op.name);
  const paramCols = op.params
    .filter((p) => !vcFieldNames.has(p.name))
    .map((p) => `:${snake(p.name)}`)
    .join(", ");
  const allowList = paramCols ? `[${paramCols}]` : "[]";

  if (kind === "create") {
    return `  @doc "Changeset for the create action \`${op.name}\`."
  def change_${opName}(attrs) do
    %${aggPascal}{}
    |> cast(attrs, ${allowList})
    |> validate_required(${allowList})
  end`;
  }
  if (kind === "destroy") {
    // Destroy doesn't cast attrs — the caller supplies the record and
    // the changeset only marks the action.  Repository handles the
    // actual Repo.delete/2.
    return `  @doc "Changeset for the destroy action \`${op.name}\` — pass-through (Repo.delete handles the actual removal)."
  def change_${opName}(struct) do
    Ecto.Changeset.change(struct)
  end`;
  }
  // operation (mutate)
  return `  @doc "Changeset for the operation \`${op.name}\`."
  def change_${opName}(struct, attrs) do
    struct
    |> cast(attrs, ${allowList})
    |> validate_required(${allowList})
  end`;
}
