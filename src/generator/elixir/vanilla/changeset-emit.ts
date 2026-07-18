// ---------------------------------------------------------------------------
// Vanilla per-aggregate Changeset module — `lib/<app>/<ctx>/<agg>_changeset.ex`.
// Slice 2 of vanilla-foundation-tdd-plan.md.
//
// Plain Ecto.Changeset cast/3 + validate_required.  Per-action
// `change_<op>/2` helpers wrap the basic cast with the action's param
// allow-list.  Per-field `validate_*` (length, format, …) deferred to a later
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
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { singleFieldConstraints } from "../../../ir/validate/invariant-classify.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import {
  aggregateHasResidualInvariants,
  renderInvariantValidatorFn,
} from "./changeset-invariant-emit.js";
import { ectoValidator, voHasConstraints } from "./changeset-validators.js";
import { isVanillaDocAgg, renderDocChangeset } from "./document-emit.js";
import { isEventSourced } from "./eventsourced-emit.js";
import { isAbstractBase } from "./inheritance-emit.js";
import { NORMALIZE_KEYS_DEFP } from "./key-normalize.js";
import { managedTimestampNames } from "./managed-timestamps.js";
import { isRefCollField, refCollFieldNames } from "./ref-collection-emit.js";
import { usesRelationalContainments } from "./schema-emit.js";
import { stampedFieldNames } from "./stamp-emit.js";
import { valueCollectionsWithVo } from "./value-collection-schema-emit.js";

interface AggField {
  name: string;
  type: { kind: string; name?: string; inner?: { kind: string; name?: string } };
  optional?: boolean;
  access?: string;
}

/** A lifecycle-managed field (audit `createdBy`/`updatedBy`, etc.) is never cast
 *  from client attrs nor `validate_required`d — the server owns its value and
 *  the lifecycle stamp `put_change`s it on the changeset right before persist
 *  (see `stampPutChanges`).  Casting it would let a client spoof the actor; a
 *  `validate_required` on it would reject the create before the stamp runs. */
function isManaged(f: AggField): boolean {
  return f.access === "managed";
}

/** The scalar columns a changeset casts: declared fields minus the id, the
 *  server-managed fields (audit stamps, managed timestamps), the
 *  lifecycle-stamp targets (`tenantOwned`'s `tenantId`, `createdAt := now()`),
 *  and the association-backed fields (value-object collections, `X id[]`
 *  reference collections) — those are wired via `cast_assoc`/`put_assoc`, not
 *  `cast`.  A stamp target is server-owned: the repository `put_change`s it
 *  right before persist, so it must be neither `cast` (a client can't spoof it;
 *  a smuggled value is simply dropped) nor `validate_required`d (that runs
 *  BEFORE the stamp and rejects the create — the 422 `tenant_id can't be blank`
 *  bug for `tenantOwned`). */
function castScalarFields(agg: AggregateIR, ctx: BoundedContextIR): AggField[] {
  const vcFieldNames = new Set(valueCollectionsWithVo(agg, ctx).map((v) => v.vc.fieldName));
  const managedTs = managedTimestampNames(agg);
  const stampedFields = stampedFieldNames(agg);
  return (agg.fields as AggField[]).filter(
    (f) =>
      f.name !== "id" &&
      !isManaged(f) &&
      !managedTs.has(f.name) &&
      !stampedFields.has(snake(f.name)) &&
      !vcFieldNames.has(f.name) &&
      !isRefCollField(f),
  );
}

/** Update-editable scalar columns — {@link castScalarFields} minus `token` /
 *  `internal` / `immutable` (mirrors `wire-projection.forUpdateInput`).  A
 *  client PATCH may modify only these; `managed` is already dropped upstream. */
const UPDATE_EXCLUDED_ACCESS: ReadonlySet<string> = new Set(["token", "internal", "immutable"]);
function updateScalarFields(agg: AggregateIR, ctx: BoundedContextIR): AggField[] {
  return castScalarFields(agg, ctx).filter((f) => !UPDATE_EXCLUDED_ACCESS.has(f.access ?? ""));
}

/** Whether an aggregate needs a dedicated `update_changeset/2` distinct from
 *  `base_changeset/2` — true when the generic update must behave differently
 *  from create: it owns a contained part (whose bulk-replace on PATCH would
 *  bypass the part's own add/remove operation), carries an update-excluded
 *  field (immutable / token / internal that create sets but update must not),
 *  or is `versioned` (needs `optimistic_lock`).  When false, the update path
 *  reuses `base_changeset` unchanged (strict additivity — byte-identical). */
export function aggregateNeedsUpdateChangeset(
  agg: AggregateIR,
  ctx?: BoundedContextIR,
  _sys?: SystemIR,
): boolean {
  if (isEventSourced(agg) || isAbstractBase(agg)) return false;
  if (aggregateIsVersioned(agg)) return true;
  if ((agg.contains ?? []).length > 0) return true;
  // The update-excluded-field check needs the context (value-collection
  // resolution); the emitter always has one, so routing stays in step.
  if (!ctx) return false;
  return updateScalarFields(agg, ctx).length !== castScalarFields(agg, ctx).length;
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
    // An abstract inheritance base is never instantiated — it has no write seam
    // (insert/update/delete) and so no changeset.  Its concrete subtypes carry
    // their own.  Emitting one would reference a `%Base{}` struct the read-only
    // base schema (or, for TPC, no schema at all) doesn't back as a writable row.
    if (isAbstractBase(agg)) continue;
    const aggSnake = snake(agg.name);
    const ctxSnake = snake(ctx.name);
    const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
    out.set(
      `lib/${appSnake}/${ctxSnake}/${aggSnake}_changeset.ex`,
      isVanillaDocAgg(agg, ctx, sys)
        ? renderDocChangeset(appModule, ctxModule, agg)
        : renderChangeset(appModule, ctxModule, agg, ctx, sys),
    );
  }
}

function renderChangeset(
  appModule: string,
  ctxModule: string,
  agg: AggregateIR,
  ctx: BoundedContextIR,
  sys?: SystemIR,
): string {
  const aggPascal = upperFirst(agg.name);
  const aggModule = `${appModule}.${ctxModule}.${aggPascal}`;
  const changesetMod = `${aggModule}Changeset`;
  // Value-object collection fields (`charges: Money[]`) are `has_many`
  // associations cast via `cast_assoc`, NOT scalar columns — exclude them from
  // the flat `cast`/`validate_required` field lists (casting an association
  // field raises `unknown field`).
  // Reference-collection (`X id[]`) fields are `many_to_many` relationships, not
  // castable columns either — `cast`ing one raises `unknown field`, and a
  // `validate_required` on a relationship is meaningless.  They're wired via
  // `put_assoc` on the create/update path (repository-emit), so drop them too.
  const vcFieldNames = new Set(valueCollectionsWithVo(agg, ctx).map((v) => v.vc.fieldName));
  // `createdAt`/`updatedAt` stay out of the cast ONLY when they are actually
  // server-managed (a `stamp` target or `access: managed`); a plain declared
  // timestamp field is cast + validated like any column (see managed-timestamps).
  const allFields = castScalarFields(agg, ctx);
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
  const validatorLines = (agg.invariants ?? []).flatMap((inv) =>
    (singleFieldConstraints(inv) ?? [])
      .filter((c) => castFields.has(snake(c.field)))
      .map((c) => ectoValidator(snake(c.field), c.pattern, inv.message?.text)),
  );
  const validatorBlock = validatorLines.length > 0 ? `\n${validatorLines.join("\n")}` : "";

  // Containments round-trip via `cast_embed` (embedded jsonb) or `cast_assoc`
  // (relational child table, §11c — `on_replace: :delete` gives
  // replace-on-update, mirroring the value-object collection path).  `cast_embed`
  // forces the embed into the INSERT (an untouched `embeds_many` writes NULL,
  // violating the `null: false` jsonb column); `cast_assoc` casts each child via
  // the part module's `changeset/2`.
  const relationalContainment = usesRelationalContainments(agg, ctx, sys);
  const castEmbedLines = agg.contains
    .map((c) => {
      const f = snake(c.name);
      if (!relationalContainment) return `    |> cast_embed(:${f})`;
      const partMod = `${appModule}.${ctxModule}.${upperFirst(c.partName)}`;
      return `    |> cast_assoc(:${f}, with: &${partMod}.changeset/2)`;
    })
    .join("\n");
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

  // `unique (...)` domain invariants (D-UNIQUE-DOMAIN) — one
  // `unique_constraint/3` per key, tied to the SAME deterministic index name
  // the migration emits (`<table>_<cols>_uq`, `uniqueIndexName` in
  // migrations-builder; recomputed locally so the generator layer never imports
  // upward from `system/`).  This turns the DB unique-violation (which would
  // otherwise raise `Ecto.ConstraintError` → 500) into a `{:error, changeset}`
  // carrying a `constraint: :unique` error, which `ProblemDetails` then renders
  // as 409 Conflict (cross-backend parity with the Hono 23505 → 409 mapping).
  // The error attaches to the first column of a composite key (Ecto ties a
  // multi-column `unique_constraint` to the index by `name:`, not by field).
  const uniqueTable = plural(snake(agg.name));
  const uniqueLines = (agg.uniqueKeys ?? []).map((uk) => {
    const cols = uk.columns.map((c) => snake(c));
    const name = `${uniqueTable}_${cols.join("_")}_uq`;
    return `    |> unique_constraint(:${cols[0]}, name: ${JSON.stringify(name)})`;
  });
  const uniqueBlock = uniqueLines.length > 0 ? `\n${uniqueLines.join("\n")}` : "";

  // Cross-field aggregate invariants (`handle != email`) — no single-field
  // native chain fits, so they run through a custom `validate_invariants/1`
  // (changeset-invariant-emit).  Piped onto BOTH the create (`base_changeset`)
  // and PATCH (`update_changeset`) seams so the rule holds on every write path,
  // matching the other backends' domain-floor `AssertInvariants()`.  Empty when
  // the aggregate has none → byte-identical.
  const hasResidualInvariants = aggregateHasResidualInvariants(agg);
  const invBlock = hasResidualInvariants ? "\n    |> validate_invariants()" : "";
  const invariantFn = renderInvariantValidatorFn(agg, `${appModule}.${ctxModule}`);
  const invariantFnBlock = invariantFn ? `\n\n${invariantFn}` : "";

  // Dedicated `update_changeset/2` — the generic PATCH seam (repository `update`
  // routes here when `aggregateNeedsUpdateChangeset` is true).  It differs from
  // `base_changeset` (the create seam) in three ways, so the aggregate stays a
  // real consistency boundary on update, not just create:
  //   1. casts only the UPDATE-EDITABLE columns (`token`/`internal`/`immutable`
  //      dropped — a client can't rewrite an immutable field or a token on PATCH);
  //   2. does NOT cast contained parts (the `castEmbedBlock` — `cast_assoc`/
  //      `cast_embed` — is omitted), so `PATCH {"parts": []}` can't bulk-delete /
  //      replace containment, bypassing the part's own `add<Part>` precondition;
  //   3. adds `optimistic_lock(:version)` for a `versioned` aggregate (a stale
  //      write raises `Ecto.StaleEntryError`, rescued to 409 at `Repo.update`).
  // Gated on `aggregateNeedsUpdateChangeset` so an aggregate that needs none of
  // these keeps reusing `base_changeset` for update — byte-identical (strict
  // additivity).  Value-object fields/collections stay editable (they carry no
  // identity or precondition), so `voBlock` / `castAssocBlock` are retained.
  const versioned = aggregateIsVersioned(agg);
  const emitUpdateChangeset = aggregateNeedsUpdateChangeset(agg, ctx, sys);
  const updateFields = updateScalarFields(agg, ctx);
  const updateFieldsDiffer = updateFields.length !== allFields.length;
  const updateColsList = updateFieldsDiffer ? "@update_fields" : "@all_fields";
  const updateReqList = updateFieldsDiffer ? "@update_required" : "@required_fields";
  const updateAttrDecls = updateFieldsDiffer
    ? `\n  @update_fields [${updateFields.map((f) => `:${snake(f.name)}`).join(", ")}]\n  @update_required [${updateFields
        .filter((f) => !f.optional)
        .map((f) => `:${snake(f.name)}`)
        .join(", ")}]`
    : "";
  const optimisticLine = versioned ? "\n    |> optimistic_lock(:version)" : "";
  const updateVcPrep = valueCollections.length > 0 ? "attrs = prepare_vc_attrs(attrs)\n\n    " : "";
  const updateChangesetBlock = emitUpdateChangeset
    ? `\n\n  @doc "Update changeset — the generic PATCH seam.  Casts only the update-editable wire fields and does NOT touch contained parts (their mutation goes through the aggregate's own operations)${versioned ? "; guards the write with optimistic_lock(:version)" : ""}."
  def update_changeset(struct, attrs) do
    attrs = __normalize_keys(attrs)
    ${updateVcPrep}struct
    |> cast(attrs, ${updateColsList})
    |> validate_required(${updateReqList})${validatorBlock}${castAssocBlock}${voBlock}${uniqueBlock}${invBlock}${optimisticLine}
  end`
    : "";

  // Per-action changeset helpers — create + destroy.  Named OPERATIONS no
  // longer get a `change_<op>` helper: their `<op>_<agg>` context fn renders the
  // body and `put_change`s the assigned columns directly (context-emit).  The
  // old operation helper `cast`d the op's *params*, which raises `unknown field`
  // at runtime whenever a param isn't a column (e.g. `reprice(qty, price)`).
  // Reference-collection params are `many_to_many` relationships, not castable
  // columns — exclude them from the per-action helper's `cast`/`validate_required`
  // (the runtime create/update path wires them via `put_assoc`).
  const refColl = refCollFieldNames(agg);
  const actionHelpers = [
    ...(agg.creates ?? []).map((op) =>
      renderActionHelper(aggModule, op, "create", vcFieldNames, refColl),
    ),
    ...(agg.destroys ?? []).map((op) =>
      renderActionHelper(aggModule, op, "destroy", vcFieldNames, refColl),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");

  // Wire bodies arrive camelCase (the cross-backend contract); Ecto casts the
  // SNAKE-cased column atoms verbatim, so the top-level keys are snaked before any
  // cast (§15).  Nested `cast_assoc`/`cast_embed` children snake their own keys in
  // their own changesets (`key-normalize.ts`).
  const keyNormalizeHelper = `\n\n${NORMALIZE_KEYS_DEFP}`;

  return `# Auto-generated.
defmodule ${changesetMod} do
  @moduledoc false
  import Ecto.Changeset
  alias ${aggModule}

  @all_fields [${allCols}]
  @required_fields [${requiredCols}]${updateAttrDecls}

  @doc "Default cast/3 helper applied by every per-action changeset below."
  def base_changeset(struct \\\\ %${aggPascal}{}, attrs) do
    attrs = __normalize_keys(attrs)
    ${valueCollections.length > 0 ? "attrs = prepare_vc_attrs(attrs)\n\n    " : ""}struct
    |> cast(attrs, @all_fields)
    |> validate_required(@required_fields)${validatorBlock}${castEmbedBlock}${castAssocBlock}${voBlock}${uniqueBlock}${invBlock}
  end${updateChangesetBlock}${invariantFnBlock}${keyNormalizeHelper}${voHelper}${normalizeHelper}${ordinalHelper}

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
  /** Reference-collection field names (snake-cased) — excluded too; they are
   *  `many_to_many` relationships wired via `put_assoc`, not castable columns. */
  refColl: ReadonlySet<string> = new Set(),
): string {
  const aggPascal = aggModule.split(".").pop()!;
  const opName = snake(op.name);
  const paramCols = op.params
    .filter((p) => !vcFieldNames.has(p.name) && !refColl.has(snake(p.name)))
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
