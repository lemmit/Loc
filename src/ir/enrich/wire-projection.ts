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
  FieldAccess,
  FieldIR,
  TypeIR,
} from "../types/loom-ir.js";

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
 * For a **synthesised** create (no declared create, but every required
 * field is defaulted — see `isSynthesizedCreate`) the create is
 * parameterless: clients supply nothing and the factory applies the
 * field defaults, so the input set is empty. */
export function createInputFields(agg: AggregateIR): FieldIR[] {
  if (agg.canonicalCreate == null && isSynthesizedCreate(agg)) return [];
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

/** Whether every required (non-optional) create-input field carries a
 * default — so the aggregate can be constructed with no client input by
 * applying those defaults.  This is the constructibility-via-defaults
 * case the validator's constructibility check also recognises. */
export function isSynthesizedCreate(agg: AggregateIR): boolean {
  // Only meaningful when no create is declared; a declared create
  // (explicit/`crudish`) always wins.
  if (agg.canonicalCreate != null) return false;
  const required = forCreateInput(agg.fields).filter((f) => !f.optional);
  if (required.length === 0) return false;
  return required.every((f) => f.default !== undefined);
}

/** Whether a backend emits a create surface (route + request DTO +
 * factory) for this aggregate.  An aggregate is constructible — and so
 * gets a create — iff it declares one (explicit `create(...)` or via
 * `crudish`, recorded as `canonicalCreate`) **or** every required
 * create-input field is defaulted (a synthesised parameterless create).
 * Aggregates with neither emit no create: they are constructed only
 * through their own operations or seed data.  This replaces the
 * pre-Stage-4 unconditional hard-coded create. */
export function hasCreate(agg: AggregateIR): boolean {
  return agg.canonicalCreate != null || isSynthesizedCreate(agg);
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
