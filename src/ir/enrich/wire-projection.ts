// Wire-projection filters — the canonical per-boundary semantics for
// `FieldAccess`.  Backends import these helpers instead of reinventing
// the modifier matrix.  Generic over anything carrying `access`:
// works on `WireField[]` (where the synthetic id row participates) and
// on `FieldIR[]` (where only declared properties participate) without
// duplicating the rules.  See `FieldAccess` in `src/ir/types/loom-ir.ts`
// for the canonical role semantics this layer implements.

import type {
  AggregateIR,
  CreateInputFieldIR,
  EntityPartIR,
  ExprIR,
  FieldAccess,
  FieldIR,
  IdValueType,
  TypeIR,
  ValueObjectIR,
  WireField,
} from "../types/loom-ir.js";
import { hasTenantOwned, TENANT_OWNED_DATA_KEY_FIELD } from "../util/tenant-stance.js";
import { satisfiableAtConstruction } from "../validate/invariant-classify.js";

/** Any structure carrying a resolved access role.  Both `WireField`
 * and `FieldIR` satisfy this — backends choose the shape that suits
 * the call site (wire shape includes the synthetic id row; field list
 * is property-only). */
type WithAccess = { access?: FieldAccess };

/** Fields visible in an **API read** response (HTTP/OpenAPI surfaces).
 * Excludes:
 *   - `internal` — never exposed via API; views may still render it.
 *   - `secret`   — write-only, never disclosed in any read.
 * Everything else (editable, immutable, managed, token) is included. */
export function forApiRead<T extends WithAccess>(items: readonly T[]): T[] {
  return items.filter((f) => f.access !== "internal" && f.access !== "secret");
}

/** Fields visible in a **UI read** projection (in-system view; admin
 * surface, scaffolded detail/list pages).  Excludes only:
 *   - `secret`   — never disclosed anywhere.
 * `internal` is INCLUDED — admin UIs are exactly the audience the
 * modifier was designed for. */
export function forUiRead<T extends WithAccess>(items: readonly T[]): T[] {
  return items.filter((f) => f.access !== "secret");
}

/** Fields clients supply on a **create** request.  Excludes:
 *   - `managed`  — server lifecycle owns the value (audit fields, etc.).
 *   - `token`    — server-assigned on create (id) or absent (version
 *                  doesn't exist yet); never client-supplied here.
 *   - `internal` — domain-only state.
 * `immutable` is INCLUDED — this is when it's settable.
 * `secret` is INCLUDED — clients supply password hashes / API keys. */
export function forCreateInput<T extends WithAccess>(items: readonly T[]): T[] {
  return items.filter(
    (f) => f.access !== "managed" && f.access !== "token" && f.access !== "internal",
  );
}

/** The fields that make up an aggregate's **create input** — the single
 * source of truth every create surface (wire DTO, domain factory,
 * page-object fill, parity) derives from.  Centralising it here means the
 * create-input contract is defined once rather than re-derived per site.
 *
 * The full client-suppliable set: `forCreateInput` (drops
 * `managed`/`token`/`internal`, keeps `immutable`/`secret`) **including
 * optional fields**.  For a crudish/declared aggregate this is exactly
 * `canonicalCreate.params` — crudish builds those params from
 * `writableCreateFields`, the same access matrix `forCreateInput`
 * applies — so backends consuming this set consume the canonical create.
 * Optionals (`description?`) are part of the create contract; their
 * optionality rides their own type nullability through each backend's
 * optionality derivation (`zodFor`/`wireTypeInfo`/`renderCsType`), so no
 * consumer needs the `optional` flag re-passed.
 *
 * Every constructible aggregate's create is parameterized by this set —
 * there is no parameterless special case (a defaulted field is a create
 * param like any other; that a default could let the client omit it is the
 * separate required-ness axis, see `CreateInputFieldIR.requiredInput`). */
export function createInputFields(agg: AggregateIR): FieldIR[] {
  // Read the reified contract when present (post-enrichment); fall back to
  // deriving it for any pre-enrichment caller so the function stays total.
  return (agg.createInput ?? buildCreateInput(agg)).map((c) => c.field);
}

/** Build an aggregate's reified create-input contract: the client-
 *  suppliable field set (`forCreateInput`) paired with each field's
 *  required-ness.  Called once by `enrichLoomModel`; the result is stored
 *  on `agg.createInput` and consumed by every create surface so the
 *  field set and the required-set are defined here, once, rather than
 *  re-derived per backend.  See {@link CreateInputFieldIR}. */
export function buildCreateInput(agg: AggregateIR): CreateInputFieldIR[] {
  return forCreateInput(agg.fields).map((field) => ({
    field,
    requiredInput: isRequiredCreateInput(field),
  }));
}

/** A create-input field is **required** (client must supply it) unless it
 *  can be omitted: nullable fields, fields with an explicit `= default`,
 *  and fields whose type carries a language-defined implicit default all
 *  collapse onto the "may omit" side.  This is the canonical rule the
 *  per-backend required-set derivations should consume in place of each
 *  re-deciding from type nullability alone. */
function isRequiredCreateInput(f: FieldIR): boolean {
  if (f.optional) return false; // nullable → client may omit
  if (f.default !== undefined) return false; // explicit default → may omit
  if (hasImplicitDefault(f.type)) return false; // implicit default → may omit
  return true;
}

/** Whether a type has a language-defined implicit default, so an omitted
 *  value is well-defined without an explicit `= default`.  Only `bool`
 *  qualifies: an absent request bool is treated as `false` (the behaviour
 *  .NET model-binding and Phoenix already apply, and the Hono request
 *  schema approximates with `.default(false)`).  No other primitive has a
 *  domain-safe omission — `""`/`0` are not valid stand-ins for an absent
 *  `name`/`age`. */
function hasImplicitDefault(t: TypeIR): boolean {
  const base = t.kind === "optional" ? t.inner : t;
  return base.kind === "primitive" && base.name === "bool";
}

/** Names of the create-input fields the client MAY OMIT (`requiredInput`
 * is false): optional-typed, explicitly defaulted, or a bare `bool`.  The
 * single source every backend consults to mark a create-request field
 * optional — replacing each one's own type-nullability test and ad-hoc
 * bool special-case.  A name absent from this set is required input. */
export function omittableCreateInputs(agg: AggregateIR): ReadonlySet<string> {
  return new Set(
    (agg.createInput ?? buildCreateInput(agg))
      .filter((c) => !c.requiredInput)
      .map((c) => c.field.name),
  );
}

/** What an omitted, omittable create-input field initialises to:
 *   - `default`  — its explicit `= <expr>` default (render in-language);
 *   - `false`    — a bare `bool`'s implicit default;
 *   - `null`     — an optional-typed field with no default.
 * Backends apply this when the client omits the field (factory `?? …`,
 * Ecto changeset default), so a defaulted field's value is never lost just
 * because it became optional input. */
export type CreateOmissionValue =
  | { readonly kind: "default"; readonly expr: ExprIR }
  | { readonly kind: "false" }
  | { readonly kind: "null" };

export function createOmissionValue(f: FieldIR): CreateOmissionValue {
  if (f.default !== undefined) return { kind: "default", expr: f.default };
  const base = f.type.kind === "optional" ? f.type.inner : f.type;
  if (base.kind === "primitive" && base.name === "bool") return { kind: "false" };
  return { kind: "null" };
}

/** The explicit `= default` a create-input field carries onto the **wire**
 *  so the client may omit it (the default is applied at the wire boundary,
 *  dropping the field from the request's required-set).  Returns the
 *  default ExprIR for any explicitly-defaulted field — **including a
 *  `bool = true`** — or `undefined` when the field has no `= default`.  A
 *  *bare* `bool` (no explicit default) still returns `undefined`: its
 *  implicit-false optionality is owned by each backend's existing bool rule.
 *  Previously this dropped the default for *every* bool, so a declared
 *  `bool = true` silently arrived `false` at the wire boundary (the backend's
 *  hardcoded `.default(false)` won).  Backends render the result in their
 *  native default slot — Hono zod `.default(…)`, .NET record `= …`, Phoenix
 *  changeset default — so a defaulted field is optional input uniformly. */
export function wireCreateDefault(f: FieldIR): ExprIR | undefined {
  if (f.default === undefined) return undefined;
  const base = f.type.kind === "optional" ? f.type.inner : f.type;
  const isBool = base.kind === "primitive" && base.name === "bool";
  // A bare `bool` and an explicit `bool = false` are indistinguishable at
  // runtime (both default to false, owned by each backend's implicit bool
  // rule).  Returning `undefined` for a literal-`false` default keeps their
  // emitted bytes identical; any OTHER bool default — notably `bool = true` —
  // is a real declared value that must reach the wire, or the client's
  // omission silently arrives `false`.
  if (
    isBool &&
    f.default.kind === "literal" &&
    f.default.lit === "bool" &&
    f.default.value === "false"
  ) {
    return undefined;
  }
  return f.default;
}

/** Whether an aggregate is **constructible** under the Stage-4 invariant
 * gate: it declares a create (explicit / `crudish`), or — having none —
 * every one of its invariants can be satisfied from the create input
 * alone (`satisfiableAtConstruction` with `available` = the create-input
 * field names).  An aggregate whose invariant references state outside the
 * create payload (a managed field, a derived getter, a helper, post-create
 * state) is NOT constructible by a plain create: it is built via an
 * operation / event / seed instead.
 *
 * This replaces the defaults-based `isSynthesizedCreate` gate — whether a
 * field has a default no longer decides constructibility (a default only
 * makes that field optional *input*; see `CreateInputFieldIR`).  An
 * aggregate with required, undefaulted fields but no blocking invariant is
 * now constructible: those fields become required create params. */
export function isConstructible(agg: AggregateIR): boolean {
  if (agg.canonicalCreate != null) return true;
  const available = new Set(forCreateInput(agg.fields).map((f) => f.name));
  return agg.invariants.every((inv) => satisfiableAtConstruction(inv, available));
}

/** Whether a backend emits a create surface (route + request DTO +
 * factory) for this aggregate — i.e. whether it is {@link isConstructible}.
 * A constructible aggregate gets a parameterized create over its
 * create-input fields (`forCreateInput`); a non-constructible one emits no
 * create and is reached only through its own operations / events / seed. */
export function hasCreate(agg: AggregateIR): boolean {
  return isConstructible(agg);
}

/** Whether the auto-derived REST layer exposes a **create** endpoint
 * (`POST /<coll>`) — and the request DTO / create command / factory-call
 * that ride it — for this aggregate.  Symmetric with the DELETE gate
 * (`canonicalDestroy != null`): a create endpoint appears only when the
 * aggregate declares an EXPLICIT canonical `create` member (written by hand
 * or synthesised by `with crudish`), never merely because the aggregate
 * happens to be {@link isConstructible}.  An event-sourced aggregate keeps
 * the creation-event gate — it is created via its declared `create` event.
 *
 * This is deliberately distinct from {@link isConstructible} / {@link hasCreate},
 * which stay the gate for the DOMAIN factory (`Agg.create(...)`) that seeds
 * and tests call directly even when no REST create is exposed. */
export function emitsRestCreate(agg: AggregateIR): boolean {
  return agg.persistedAs === "eventLog"
    ? (agg.creates?.length ?? 0) > 0
    : agg.canonicalCreate != null;
}

/** Fields clients may modify in an **update** request's editable
 * payload.  Excludes:
 *   - `managed`  — server lifecycle.
 *   - `token`    — sent as precondition (see `updatePreconditions`),
 *                  not as a value to modify.
 *   - `internal` — domain-only.
 *   - `immutable`— frozen after create.
 * Only editable + `secret` remain. */
export function forUpdateInput<T extends WithAccess>(items: readonly T[]): T[] {
  return items.filter(
    (f) =>
      f.access !== "managed" &&
      f.access !== "token" &&
      f.access !== "internal" &&
      f.access !== "immutable",
  );
}

/** Tokens that an update request must carry as **preconditions** —
 * sent by the client, used by the server to identify the target row
 * (id) or detect a concurrency conflict (version), but never modified
 * by the request.  Backends emit these separately from the editable
 * payload — route param for identity, ETag/header or body field for
 * concurrency, depending on transport. */
export function updatePreconditions<T extends WithAccess>(items: readonly T[]): T[] {
  return items.filter((f) => f.access === "token");
}

// ---------------------------------------------------------------------------
// Wire-shape derivation — the scaffold-time walk.
//
// The canonical ordered field list an aggregate / part / value object takes on
// the network:
//
//   1. `id`              — always first (aggregates / parts only)
//   2. each `Property`   — declaration order
//   3. each `Containment` — declaration order, array vs single
//   4. each `Derived`    — declaration order
//
// Value objects skip steps 1 + 3 (no identity, no containment).
//
// This is a pure function of facts already on the (fully-lowered, enriched)
// IR node — `fields` / `contains` / `derived` / `capabilities` — so it is
// recomputed on demand at each emit site rather than stamped onto the node.
// See CLAUDE.md "Derive, don't stamp".  Callers pair it with the access-modifier
// filters above (`forApiRead(wireFieldsFor(ent))`) to project a boundary shape.
// ---------------------------------------------------------------------------

function idTypeFor(targetName: string, valueType: IdValueType = "guid"): TypeIR {
  return { kind: "id", targetName, valueType };
}

function containmentTypeFor(partName: string, collection: boolean): TypeIR {
  return collection
    ? { kind: "array", element: { kind: "entity", name: partName } }
    : { kind: "entity", name: partName };
}

export function wireFieldsForAggregate(agg: AggregateIR): WireField[] {
  const out: WireField[] = [
    {
      name: "id",
      type: idTypeFor(agg.name, agg.idValueType),
      optional: false,
      source: "id",
      access: "token",
    },
  ];
  for (const f of agg.fields) {
    // `tenantOwned`'s `dataKey` (multi-tenancy P2.3) is a persistence-only
    // materialized-path column — `authorization.md §2` calls for it "kept
    // out of wireShape" entirely, unlike `tenantId` which stays in wireShape
    // as `internal` (excluded from API reads by `forApiRead`, still visible
    // in `.loom/wire-spec.json`). The registry's own same-named `dataKey`
    // (from `tenantRegistry`, `managed`) is unaffected — the two capabilities
    // are mutually exclusive per aggregate (`classifyTenantStance`).
    if (f.name === TENANT_OWNED_DATA_KEY_FIELD && hasTenantOwned(agg)) continue;
    out.push({
      name: f.name,
      type: f.type,
      optional: f.optional,
      source: "property",
      access: f.access ?? "editable",
    });
  }
  for (const c of agg.contains) {
    out.push({
      name: c.name,
      type: containmentTypeFor(c.partName, c.collection),
      optional: !!c.optional && !c.collection,
      source: "containment",
      access: "editable",
    });
  }
  for (const d of agg.derived) {
    // `inspect` is the host-language debug-string hook (ToString /
    // util.inspect.custom / Inspect protocol) — emitted as a getter on
    // the domain class but kept out of JSON DTOs.  Exposing the
    // structural form on the wire would leak internal field layout to
    // every API client.
    if (d.name === "inspect") continue;
    out.push({
      name: d.name,
      type: d.type,
      // A derived's declared type carries its nullability (`derived x: T? = …`);
      // hardcoding `false` made an optional derived land in wire-spec.json's
      // `required` array while every backend serves it nullish.
      optional: d.type.kind === "optional",
      source: "derived",
      access: "editable",
    });
  }
  return out;
}

export function wireFieldsForPart(part: EntityPartIR): WireField[] {
  const out: WireField[] = [
    {
      name: "id",
      type: idTypeFor(part.name, part.parentIdValueType),
      optional: false,
      source: "id",
      access: "token",
    },
  ];
  for (const f of part.fields) {
    out.push({
      name: f.name,
      type: f.type,
      optional: f.optional,
      source: "property",
      access: f.access ?? "editable",
    });
  }
  for (const c of part.contains) {
    out.push({
      name: c.name,
      type: containmentTypeFor(c.partName, c.collection),
      optional: !!c.optional && !c.collection,
      source: "containment",
      access: "editable",
    });
  }
  for (const d of part.derived) {
    out.push({
      name: d.name,
      type: d.type,
      optional: d.type.kind === "optional",
      source: "derived",
      access: "editable",
    });
  }
  return out;
}

export function wireFieldsForValueObject(vo: ValueObjectIR): WireField[] {
  const out: WireField[] = [];
  for (const f of vo.fields) {
    out.push({
      name: f.name,
      type: f.type,
      optional: f.optional,
      source: "property",
      access: f.access ?? "editable",
    });
  }
  for (const d of vo.derived) {
    out.push({
      name: d.name,
      type: d.type,
      optional: d.type.kind === "optional",
      source: "derived",
      access: "editable",
    });
  }
  return out;
}

/** Recompute the canonical wire shape for an aggregate / part / value object,
 *  dispatching on the node's structural discriminator (aggregates carry
 *  `idValueType`, parts `parentIdValueType`, value objects neither).  A drop-in
 *  for the retired `wireShapeFor` stamp reader: byte-identical output because it
 *  runs the SAME walk the enrichment pass ran, over the same enriched fields. */
export function wireFieldsFor(ent: AggregateIR | EntityPartIR | ValueObjectIR): WireField[] {
  if ("idValueType" in ent) return wireFieldsForAggregate(ent);
  if ("parentIdValueType" in ent) return wireFieldsForPart(ent);
  return wireFieldsForValueObject(ent);
}
