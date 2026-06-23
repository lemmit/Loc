// ---------------------------------------------------------------------------
// Vanilla reference-collection (`X id[]`) support — the runtime side of the
// already-correct join-table migration.
//
// A `party: Pokemon id[]` field is NOT a stored `{:array, :binary_id}` column
// on the owner table (the migration emits no such column — only a
// `trainer_party` join table).  On the vanilla foundation it must be an Ecto
// `many_to_many` relationship through that join table, mirroring what the Ash
// foundation does with a `many_to_many ... do through ... end` + a
// `list :party, :party_through, :id` aggregate for the id-array wire field.
//
// This module owns the small structural query (`refCollFields`) plus the four
// runtime fragments the schema / changeset / repository / controller emitters
// each need so they stay in lockstep:
//   - the `many_to_many` schema line                       (schema-emit)
//   - the `Repo.preload([...])` read list                  (repository / context)
//   - the `put_assoc` create/update wiring                 (repository / context)
//   - the `serialize` id-array projection                  (api-emit)
//
// The IR already carries everything: each field lives in `agg.fields` as an
// `array`-of-`id`, and is mirrored in `agg.associations` (AssociationIR —
// joinTable / ownerFk / targetFk / targetAgg), populated by enrichment.  We're
// wiring the schema/runtime layer to the same metadata the join migration
// already consumes for DDL.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  AssociationIR,
  EnrichedAggregateIR,
  ExprIR,
  FieldIR,
} from "../../../ir/types/loom-ir.js";
import { refCollectionFieldName } from "../../../ir/util/ref-collection.js";
import { snake, upperFirst } from "../../../util/naming.js";

/** One reference-collection field paired with its enriched association. */
export interface RefCollField {
  field: FieldIR;
  assoc: AssociationIR;
}

/** Is this field an `X id[]` reference collection (array-of-id)? */
export function isRefCollField(f: { type: { kind: string; element?: { kind: string } } }): boolean {
  return f.type.kind === "array" && f.type.element?.kind === "id";
}

/** The aggregate's reference-collection fields, each paired with the
 *  AssociationIR enrichment derived for it.  A field without a matching
 *  association (shouldn't happen — enrichment derives one per array-of-id
 *  field) is skipped. */
export function refCollFields(agg: AggregateIR): RefCollField[] {
  const associations = (agg as EnrichedAggregateIR).associations ?? [];
  const out: RefCollField[] = [];
  for (const f of agg.fields) {
    if (!isRefCollField(f)) continue;
    const assoc = associations.find((a) => a.fieldName === f.name);
    if (assoc) out.push({ field: f, assoc });
  }
  return out;
}

/** The set of ref-collection field names (snake) — used by emitters to drop
 *  these fields from plain `field`/`cast`/`validate_required` handling. */
export function refCollFieldNames(agg: AggregateIR): Set<string> {
  return new Set(refCollFields(agg).map((rc) => snake(rc.field.name)));
}

/** Is `<fieldSnake>` (a snake-cased field name) a reference collection on
 *  `agg`?  Used by the named-operation body renderer to route `party += x` /
 *  `party -= x` writes to id-list normalisation + `put_assoc`. */
export function isRefCollFieldName(agg: AggregateIR, fieldSnake: string): boolean {
  return refCollFieldNames(agg).has(fieldSnake);
}

/** The target aggregate module for a ref-collection field (snake name), or
 *  null if the field isn't a reference collection. */
export function refCollTargetModule(
  appModule: string,
  ctxModule: string,
  agg: AggregateIR,
  fieldSnake: string,
): string | null {
  const rc = refCollFields(agg).find((r) => snake(r.field.name) === fieldSnake);
  return rc ? targetModule(appModule, ctxModule, rc.assoc) : null;
}

/** The fully-qualified Elixir module for the referenced aggregate, e.g.
 *  `Api.Roster.Pokemon`.  Reference collections only target an aggregate in
 *  the SAME bounded context (cross-context `X id[]` isn't admitted), so the
 *  context module is the owner's. */
function targetModule(appModule: string, ctxModule: string, assoc: AssociationIR): string {
  return `${appModule}.${ctxModule}.${upperFirst(assoc.targetAgg)}`;
}

/** The `many_to_many` schema line for one ref-collection field.  Mirrors the
 *  Ash `many_to_many ... through ...` — a plain Ecto join_through with explicit
 *  join_keys and `on_replace: :delete` so a `put_assoc` REPLACES the prior set
 *  (set semantics for `Id<T>[]`).
 *
 *  `join_through:` is the BARE table name even when the owner lives in a
 *  non-public Postgres schema: Ecto applies the owner schema's `@schema_prefix`
 *  to a string join_through at query time, so qualifying it here would
 *  DOUBLE-prefix the insert (`"pokedex"."pokedex.trainer_party"` → undefined
 *  table).  The join table always lives in the owner's schema (the migration
 *  creates it with the owner context's prefix), so inherited qualification is
 *  exactly right. */
export function manyToManyLine(appModule: string, ctxModule: string, rc: RefCollField): string {
  const rel = snake(rc.field.name);
  const target = targetModule(appModule, ctxModule, rc.assoc);
  const through = JSON.stringify(rc.assoc.joinTable);
  return `    many_to_many :${rel}, ${target}, join_through: ${through}, join_keys: [${rc.assoc.ownerFk}: :id, ${rc.assoc.targetFk}: :id], on_replace: :delete`;
}

/** The preload list for an aggregate's reads — `[:party, :caught]` — so every
 *  loaded record carries the relationship structs the serializer projects to
 *  ids.  Empty when the aggregate has no reference collections. */
export function preloadList(agg: AggregateIR): string[] {
  return refCollFields(agg).map((rc) => `:${snake(rc.field.name)}`);
}

/** `Map.from_struct`-projection lines that replace each ref-collection
 *  relationship with its id array in the serialized wire map (the Ash
 *  `calculate :party, {:array, :uuid}` analogue).  Returned as pipe segments
 *  appended after the `Map.drop`. */
export function serializeRefCollLines(agg: AggregateIR): string[] {
  return refCollFields(agg).map((rc) => {
    const name = snake(rc.field.name);
    return `    |> Map.put(:${name}, __ref_ids(record.${name}))`;
  });
}

/** Does the aggregate have any reference-collection fields? */
export function hasRefColls(agg: AggregateIR): boolean {
  return refCollFields(agg).length > 0;
}

/** A detected `this.<refColl>.contains(arg)` membership predicate inside a
 *  repository `find` `where` clause — the field name and the rendered Ecto pin
 *  for the argument.  `null` when the filter isn't this shape. */
export interface ContainsFind {
  fieldName: string;
}

/** If a find's filter is exactly `this.<refColl>.contains(arg)` over an
 *  `X id[]` field of `agg`, return the field name; else null.  The argument is
 *  always the find's first parameter (the validator only admits the membership
 *  form with a single id arg), so the caller binds `^<param>` directly. */
export function containsRefCollField(filter: ExprIR | undefined, agg: AggregateIR): string | null {
  if (filter?.kind !== "method-call") return null;
  if (filter.member !== "contains") return null;
  if (filter.receiverType.kind !== "array" || filter.receiverType.element.kind !== "id") {
    return null;
  }
  const fieldName = refCollectionFieldName(filter.receiver);
  if (!fieldName) return null;
  // Confirm it's a known reference collection on this aggregate.
  return refCollFields(agg).some((rc) => rc.field.name === fieldName) ? fieldName : null;
}

/** A `Repo.preload([...])` suffix for a read body, or `""` when the aggregate
 *  has no reference collections (keeps non-refcoll repos byte-identical).  Wraps
 *  a `Repo.all(...)` / `Repo.get(...)` result so every loaded record carries the
 *  relationship structs the serializer projects to ids. */
export function preloadSuffix(agg: AggregateIR): string {
  const list = preloadList(agg);
  return list.length > 0 ? ` |> Repo.preload([${list.join(", ")}])` : "";
}

/** Pipe lines that wire each ref-collection into a changeset via `put_assoc`,
 *  resolving the incoming `attrs["party"]` id list to target structs first.
 *  Appended after `base_changeset(attrs)` on the insert/update path.  Returns
 *  `[]` when the aggregate has no reference collections. */
export function putAssocLines(
  appModule: string,
  ctxModule: string,
  agg: AggregateIR,
  indent: string,
): string[] {
  return refCollFields(agg).map((rc) => {
    const name = snake(rc.field.name);
    const target = targetModule(appModule, ctxModule, rc.assoc);
    return `${indent}|> __put_ref_coll(:${name}, ${JSON.stringify(name)}, attrs, ${target})`;
  });
}

/** The shared private helpers a repository emits when it has ref collections:
 *  `__put_ref_coll/4` (resolve an id list to target structs, then `put_assoc`)
 *  and `__ref_ids/1` is on the controller, not here.  Only emitted when used,
 *  so it never sits unused under `--warnings-as-errors`. */
export function refCollRepoHelpers(appModule: string): string {
  return `
  # Resolve a reference-collection id list (\`attrs[key]\`) to target structs and
  # \`put_assoc\` them onto the changeset.  A missing/blank key leaves the existing
  # association untouched (so a partial update doesn't clear it); an empty list
  # explicitly clears it.  \`on_replace: :delete\` on the schema makes put_assoc
  # rewrite the join rows.
  defp __put_ref_coll(changeset, field, key, attrs, target_mod) do
    case __fetch_ref(attrs, key) do
      :absent ->
        changeset

      {:ok, ids} ->
        ids = ids |> List.wrap() |> Enum.map(&to_string/1)
        targets = ${appModule}.Repo.all(from(t in target_mod, where: t.id in ^ids))
        Ecto.Changeset.put_assoc(changeset, field, targets)
    end
  end

  defp __fetch_ref(attrs, key) do
    cond do
      Map.has_key?(attrs, key) -> {:ok, Map.get(attrs, key) || []}
      Map.has_key?(attrs, String.to_atom(key)) -> {:ok, Map.get(attrs, String.to_atom(key)) || []}
      true -> :absent
    end
  end`;
}
