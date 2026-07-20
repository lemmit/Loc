// ---------------------------------------------------------------------------
// Loom IR — semantic, platform-neutral representation of the DSL.
//
// The pipeline is:
//
//   .ddd source  ──parse──▶  Langium AST
//                                │
//                                ▼
//                            lowering
//                                │
//                                ▼
//                            Loom IR  (this file)
//                                │
//                                ▼
//                  per-platform shaping  (typescript-ir, dotnet-ir)
//                                │
//                                ▼
//                  procedural builders  ──▶  source files
//
// All implicit DDD plumbing — entity ids, parent FKs, name resolution of
// expression references, enum-value qualification, value-object constructor
// recognition, lambda parameter scoping — is fully resolved here so the
// per-platform layers only need to deal with naming conventions and the
// platform-specific shape of the surrounding code.
// ---------------------------------------------------------------------------

// The `*UsesCurrentUser` helpers below traverse the IR via the one shared,
// exhaustive child-walker (`src/ir/util/walk.ts`).  This is a value import from
// `ir/types` → `ir/util`; the reverse edge (walk.ts → loom-ir.ts) is `import
// type` only (erased at emit), so no runtime cycle forms.
import type { DurationUnit } from "../../util/temporal.js";
import { walkExprDeep, walkStmtExprsDeep, walkWorkflowStmtExprsDeep } from "../util/walk.js";
import type { OriginRef } from "./origin.js";

export type IdValueType = "guid" | "int" | "long" | "string";

export type PrimitiveName =
  | "int"
  | "long"
  | "decimal"
  | "money"
  | "string"
  | "bool"
  | "datetime"
  | "guid"
  /** Opaque JSON blob — interior is not modelled by Loom.  Maps to
   *  JSONB / jsonb / `Map` per backend; a leaf in `wireShape` (never
   *  expanded or structurally diffed).  See
   *  `docs/old/proposals/document-and-json-hierarchies.md` (Option 1,
   *  D-DOCUMENT-AXIS). */
  | "json"
  /** A file attachment — a leaf primitive (like `json`), passive/wire-only:
   *  NO arithmetic, operators, or expression semantics.  Its wire shape is a
   *  FIXED typed object `{ url: string, key: string, contentType: string,
   *  size: int }` (a `FileRef`), and it is stored as a JSONB / jsonb column
   *  exactly like `json` (never expanded or structurally diffed in
   *  `wireShape`).  The bytes themselves live in object storage (an
   *  `objectStore` data source — `s3` / `localDisk`); the column carries only
   *  the reference.  A File-bearing aggregate requires its host deployable to
   *  bind an `objectStore` (`loom.file-field-needs-object-storage`). */
  | "File"
  /** An ABSOLUTE span of time (A5 temporal, docs/old/plans/stdlib.md) — fixed
   *  millisecond width per unit, so it renders uniformly on every backend.
   *  EXPRESSION-ONLY in this slice: not in the grammar's `PrimitiveType`
   *  rule, so it can never appear in field / param / wire position — it only
   *  arises from the `days(n)`/`hours(n)`/`minutes(n)` constructors and the
   *  temporal arithmetic rules (`datetime - datetime`, `duration ±
   *  duration`, `duration * int`).  Calendar-relative offsets (`months`,
   *  `years`) are deliberately excluded — no fixed width, so they would
   *  break the uniform translation.  Deliberately NOT in `PRIMITIVES` below
   *  (that list feeds user-facing type pickers; a type you cannot write does
   *  not belong in one). */
  | "duration";

/** Canonical ordering for UI surfaces that enumerate primitives —
 *  playground type picker, docs tables, completion provider, future
 *  tooling.  Keeps related primitives adjacent (numeric block,
 *  money-after-decimal so the precision contrast is visible, scalars
 *  last) so the dropdown reads top-to-bottom by "most user-facing
 *  first."  Sourced from here, not duplicated per-consumer, so a
 *  future primitive addition shows up everywhere without touching
 *  N call sites. */
export const PRIMITIVES: readonly PrimitiveName[] = [
  "string",
  "int",
  "long",
  "decimal",
  "money",
  "bool",
  "datetime",
  "guid",
  "json",
  "File",
] as const;

/** Information-flow sensitivity tags carried by a value's type.  See
 * `docs/old/proposals/sensitivity-and-compliance.md`.  Mirror of
 * `SensitivityTags` in `src/language/type-system.ts`; kept as a sorted,
 * unique `readonly string[]` so the IR remains JSON-serialisable for
 * `.loom/wire-spec.json`. */
export type SensitivityTags = readonly string[];

/** Canonical type-discriminated union for every type that appears in
 *  the IR — primitives, ids, enums, value objects, entities, arrays,
 *  optionals, and the UI-only `slot` marker.
 *
 *  Switch-dispatch convention for the `"slot"` arm: sites that consume
 *  a type as wire / schema / source-code (backend renderers, migrations
 *  builder, wire-spec, OpenAPI schema, Zod schema) MUST `throw` — the
 *  validator (`checkSlotTypePosition`) guarantees `slot` never reaches
 *  a storage / wire position, so encountering it there is a bug.
 *  Sites that produce display strings (mermaid, loomsnap,
 *  structural-print, playground inspector) return the literal
 *  `"slot"` so editors and diagnostics still read sensibly when a
 *  slot-typed component param surfaces in a label.  React's
 *  `propType` recognises the variant and emits `ReactNode`. */
export type TypeIR =
  | { kind: "primitive"; name: PrimitiveName; sensitivity?: SensitivityTags }
  | { kind: "id"; targetName: string; valueType: IdValueType; sensitivity?: SensitivityTags }
  | { kind: "enum"; name: string; sensitivity?: SensitivityTags }
  | { kind: "valueobject"; name: string; sensitivity?: SensitivityTags }
  | { kind: "entity"; name: string; sensitivity?: SensitivityTags }
  | { kind: "array"; element: TypeIR; sensitivity?: SensitivityTags }
  | { kind: "optional"; inner: TypeIR; sensitivity?: SensitivityTags }
  /** Carrier-bounded generic payload instantiation — `customer paged`,
   *  `event envelope` (payload-transport-layer.md, P3).  `ctor` names a
   *  blessed stdlib shape (see `src/ir/stdlib/generics.ts`); `arg` is the
   *  single carrier type argument.  Nesting is left-associative postfix:
   *  `string envelope paged` lowers to
   *  `genericInstance(paged, genericInstance(envelope, primitive string))`.
   *  P3a represents this in the IR but blocks emission at IR-validate; P3b
   *  monomorphizes each distinct instance into a concrete payload. */
  | { kind: "genericInstance"; ctor: GenericCtorName; arg: TypeIR; sensitivity?: SensitivityTags }
  /** Discriminated union (payload-transport-layer.md, P4) — both the named
   *  form (`payload Foo = A | B`) and the anonymous `or` form (`A or B` in any
   *  type position) lower to this.  `variants` is the source-order variant
   *  list, each a distinct carrier type; identity is structural on the
   *  variant *set* (associative-commutative — see `unionVariantKey`), so
   *  `A or B` and `B or A` are the same type.  The wire form is tagged by a
   *  per-variant discriminator (the `type` field — see P4 emission); P4a
   *  represents this in the IR but blocks emission at IR-validate. */
  | { kind: "union"; variants: TypeIR[]; sensitivity?: SensitivityTags }
  /** The unit variant of an `option` (payload-transport-layer.md, P4):
   *  `T option` lowers to `union[T, none]`.  Carries no payload; on the wire
   *  it is the tagged-empty variant.  A blessed nullary marker (like `slot`),
   *  not an author-writable type — it only ever appears inside an option's
   *  union. */
  | { kind: "none"; sensitivity?: SensitivityTags }
  /** Element-shaped param marker — only valid on a `component`'s
   *  parameter list.  Values flow as JSX (any walker expression) from
   *  the caller's scope into the component body; a bare ref to a
   *  slot-typed param renders the caller's expression at that
   *  position.  See `docs/page-metamodel.md`. */
  | { kind: "slot"; sensitivity?: SensitivityTags }
  /** Function-valued param marker — `slot`'s behavioural sibling
   *  (extern-component-escape-hatch.md, Tier 2).  Only valid on a
   *  `component`'s parameter list; the caller passes a (block-body)
   *  lambda walked + hoisted in the caller's scope, and the React
   *  props type gains `(arg: TWire) => void`.  `arg` is the declared
   *  callback argument type; undefined for a bare zero-arg `action`. */
  | { kind: "action"; arg?: TypeIR; sensitivity?: SensitivityTags };

/** The blessed closed set of generic-payload **record** carriers — the ones
 *  that monomorphize to a `PayloadIR` record.  Kept in lockstep with the
 *  record arms of the `GenericCtor` grammar rule and the stdlib registry in
 *  `src/ir/stdlib/generics.ts`.  The grammar's third ctor, `option`, is a
 *  *union* carrier: `T option` lowers straight to `union[T, none]` rather than
 *  a `genericInstance`, so it never appears here. */
export type GenericCtorName = "paged" | "envelope";

export interface ParamIR {
  name: string;
  type: TypeIR;
  /** Lowered default-value expression from `param: T = <expr>` — the
   *  parameter analogue of {@link FieldIR.default}.  Present only where the
   *  lowering site had an env to resolve the expression (operation / create /
   *  destroy / workflow-start / function params); the expression is
   *  fully-resolved like any other `ExprIR` and may reference `this` (the
   *  target instance) for an operation param.  Consumed by the scaffolded
   *  operation / workflow form to seed its inputs; a default the target UI
   *  can't evaluate falls back to the type-zero seed. */
  default?: ExprIR;
}

/** Resolved access role for a stored field.  Controls the field's
 * presence in create/update inputs, the update wire envelope, and
 * view/API read exposure.  See `src/ir/enrich/enrichments.ts` for resolution
 * rules.
 *
 *   editable  — default; client may read and write freely
 *   immutable — client may write on create only; read otherwise
 *   managed   — server lifecycle owns the value; client read-only
 *   token     — server-managed but echoed by the client on update
 *               (identity, concurrency); always non-nullable
 *   internal  — views may read; never exposed via API; no client input
 *   secret    — client may write (create + update); never disclosed
 *               in any read */
export type FieldAccess = "editable" | "immutable" | "managed" | "token" | "internal" | "secret";

export interface FieldIR {
  name: string;
  type: TypeIR;
  optional: boolean;
  /** True iff the source declared this property with the `provenanced`
   * modifier.  Every assignment statement (`:=`/`+=`/`-=`) targeting such
   * a field becomes a per-site rule snapshot; see `ProvSite`.  The provenance
   * runtime is emitted on the Hono (`node`), .NET (`dotnet`) and `elixir`
   * backends — hosting a provenanced context on another surface (e.g.
   * react) is rejected at validate time
   * (`loom.provenanced-backend-unsupported`, `validateProvenancedStorage`)
   * rather than silently dropping the trail. */
  provenanced?: boolean;
  /** Information-flow sensitivity tags declared at the property site via
   * `sensitive(<tag>, ...)`.  Sorted + deduped; omitted when the field
   * declared no tags.  Phase 1 only captures the declaration; later
   * phases wire it through the wire-shape, DTO emitters, and sink
   * type-checking.  See `docs/old/proposals/sensitivity-and-compliance.md`. */
  sensitivity?: SensitivityTags;
  /** Resolved access role.  Populated by `enrichLoomModel`; lowering
   * leaves this undefined when the source declared no modifier so
   * enrichment can apply its precedence (declared > default).
   * After enrichment every `FieldIR` carries a value. */
  access?: FieldAccess;
  /** Where `access` came from.  Diagnostic-only: used by the validator
   * to phrase conflict messages and by the wire-spec diff to explain
   * the field's role.  Same nullability as `access`. */
  accessSource?: "declared" | "default" | "stamp";
  /** Lowered default-value expression from `field: T = <expr>`.  Present
   *  only on aggregate / entity-part / value-object fields that declared a
   *  default (events / views never lower one).  Fully-resolved like any
   *  other `ExprIR`; consumed when synthesising a create for an aggregate
   *  with no explicit one. */
  default?: ExprIR;
  /** Provenance chain back to the `.ddd` source — see
   * src/ir/types/origin.ts.  Populated at lowering; absent on purely
   * derived nodes. */
  origin?: OriginRef;
}

/** One entry in an aggregate's reified **create-input contract** — the
 *  single source of truth every create surface derives from (wire DTO,
 *  domain factory, page-object fill, OpenAPI, cross-backend parity).
 *  Built once by `enrichLoomModel` (see `buildCreateInput`) so every
 *  backend reads the same field set AND the same per-field required-ness,
 *  instead of each re-deriving it — the divergence the per-backend
 *  required-set hacks papered over. */
export interface CreateInputFieldIR {
  field: FieldIR;
  /** Whether the client MUST supply this field on create.  A field is
   *  required input iff it is non-optional, carries no explicit default,
   *  and has no language-defined implicit default (a bare `bool` defaults
   *  to `false`).  A default — explicit or implicit — collapses a field
   *  onto the same "client may omit" axis as `optional`; whether the
   *  *aggregate* gets a create at all is a separate, invariant-based
   *  decision and does not consult this flag. */
  requiredInput: boolean;
}

export interface ContainmentIR {
  name: string;
  partName: string;
  collection: boolean;
  /** Singular containments only — when true, the part may be absent at
   *  runtime; backends serialise it as a nullable wire field.  Validators
   *  reject the combination `collection && optional` (an empty list already
   *  encodes absence). */
  optional?: boolean;
}

/** A many-to-many association derived from an aggregate field whose
 * type is a collection of references to another aggregate
 * (`field: Target id[]`).  Populated by `enrichLoomModel`; backends
 * that persist relationally emit a join table from this rather than
 * re-deriving it.  See `src/ir/enrich/enrichments.ts`. */
export interface AssociationIR {
  /** The owning aggregate's field name (`party`). */
  fieldName: string;
  /** The aggregate that declares the field (`Trainer`). */
  ownerAgg: string;
  /** The referenced aggregate (`Pokemon`). */
  targetAgg: string;
  /** The id value type of the target reference. */
  valueType: IdValueType;
  /** Join-table name, `snake(owner)_snake(field)` — distinct per
   * field even when several fields target the same aggregate. */
  joinTable: string;
  /** FK column pointing at the owner row, `snake(owner)_id`. */
  ownerFk: string;
  /** FK column pointing at the target row, `snake(target)_id`. */
  targetFk: string;
}

export interface DerivedIR {
  name: string;
  type: TypeIR;
  expr: ExprIR;
}

/** A named, typed page/component event handler — `action next(p: T) { … }`
 *  (named-actions-and-stores.md, Proposal A Stage 1).  The named form of
 *  today's anonymous handler lambda: a stable identity, a typed payload
 *  param list (declared by the action; the call-site primitive supplies the
 *  value), and a statement block reusing the existing `StmtIR` set — no new
 *  statement semantics.  Each JSX frontend hoists one named handler function
 *  per action at the page/component top; a bare `onSubmit: <name>` reference
 *  binds the handler instead of an inline arrow. */
export interface ActionIR {
  name: string;
  /** Declared payload params (zero or one in v1 — a Form `into:` two-way
   *  binding ⇒ nullary; a Form value / List row id ⇒ a single payload
   *  param).  The validator gates arity + assignability against what the
   *  call-site primitive supplies. */
  params: ParamIR[];
  /** Handler body — the same `StmtIR` block an anonymous handler lambda
   *  lowers to (`:=` / `+=` / `-=` / `let` / calls / `navigate` / `emit`). */
  body: StmtIR[];
}

/** A shared client-side state container — `store Cart { state {…} action …}`
 *  (named-actions-and-stores.md §3, Stage 5).  A top-level `ui` member, sibling
 *  to page/component, holding named state + named actions.  Referenced purely
 *  by DOTTED qualified name from a page/component body (`Cart.lines` read,
 *  `Cart.clear()` call) — there is no `use` binding; each consuming page's
 *  store dependency is DERIVED at emit time by walking its already-resolved
 *  refs (the `store-field` refs + `store-action` calls carry the store name).
 *  The `state`/`actions` reuse the exact `StateFieldIR`/`ActionIR` shapes a
 *  page/component carries.  v1 is `"memory"` only — the lifetime ladder has no
 *  grammar surface yet (the keywords would collide with common identifiers; see
 *  the `Store` grammar rule), so `lifetime` is always `"memory"` today.  The
 *  field + the `loom.store-lifetime-unsupported` gate stay so the persistence
 *  follow-up only adds the (soft-keyword-careful) syntax. */
export interface StoreIR {
  name: string;
  /** v1: always `"memory"`.  `"persistLocal"`/`"persistSession"`/`"url"` have
   *  no syntax yet (see `Store` grammar rule) but the IR + validator carry them
   *  so the persistence follow-up only adds the surface.  The validator gate
   *  stays as a defensive check on programmatic IR construction. */
  lifetime: "memory" | "persistLocal" | "persistSession" | "url";
  /** Shared reactive fields — the store twin of `PageIR.state`. */
  state: StateFieldIR[];
  /** Named actions that transition the store state — the store twin of
   *  `PageIR.actions`.  A store action `:=`-writes only its own store state
   *  and may call another store action (acyclic); it may NOT call a page
   *  action (scope-resolution failure) nor a view-scoped effect
   *  (`navigate`/`toast` — `loom.store-action-view-effect`). */
  actions: ActionIR[];
}

/** An author-written, user-facing validation message attached to a rule via a
 *  `message "..."` clause. A descriptor (not a bare string) so the i18n mission
 *  can later add `key`/`args` without changing the shape every emitter reads;
 *  v1 carries only `text` (the one genuine input). The wire/i18n `code` is a
 *  pure content-hash of `text` — derived on demand via `messageCode`
 *  (`src/util/message-code.ts`), never stored (derive, don't stamp). */
export interface MessageIR {
  /** The author-written text, shown to the user (STRING-terminal-stripped). */
  text: string;
}

export interface InvariantIR {
  expr: ExprIR;
  guard?: ExprIR;
  source: string;
  /** When present, a `message "..."` clause forces this rule onto the wire/refine
   *  carrier (never the native-chain optimisation) so the text reaches the
   *  frontend inline error, the wire 422 `errors[]`, and the domain floor. */
  message?: MessageIR;
  /** When `"server-only"`, the invariant skips wire-boundary
   *  validators (frontend Zod, Hono routes, FluentValidation) even
   *  when its expression would translate cleanly.  Domain-layer
   *  enforcement via `AssertInvariants()` always runs.  Set by
   *  the `@server-only` annotation in the DSL. */
  scope?: "server-only";
}

/** A uniqueness invariant declared via `unique (a, b)` on the aggregate
 *  (uniqueness-and-indexes.md, D-UNIQUE-DOMAIN).  A set-level natural-key
 *  rule — no two rows may share the `columns` tuple.  The compiler DERIVES
 *  its enforcement (never runs it in the per-instance invariant floor): a DB
 *  unique index (partial under `softDeletable`) named deterministically so a
 *  23505 violation can be mapped back to a field → 409.  `columns` are
 *  aggregate field names, validated to exist. */
export interface UniqueKeyIR {
  columns: string[];
  source: string;
}

/** A pure helper over its parameters (domain-services.md).  The body is a
 *  variant — NOT a replacement — so the inlinable expression path is
 *  untouched:
 *    - `{ expr }`  — expression form (`= Expression`); SQL-inlinable.
 *    - `{ stmts }` — block form (rev. 4); `let` + branch + bug-regime
 *                    `throw`/`require`, still PURE.  NOT queryable.
 *  Backends discriminate on `"expr" in body`. */
export type FunctionBodyIR = { expr: ExprIR } | { stmts: StmtIR[] };

export interface FunctionIR {
  name: string;
  params: ParamIR[];
  returnType: TypeIR;
  body: FunctionBodyIR;
}

/** Lifecycle kind of an aggregate action (lifecycle-operations.md).
 * `mutate` is today's `operation` keyword; `create` / `destroy` are the
 * factory / terminator keywords.  The kind tag — not the body syntax —
 * carries the lifecycle asymmetry; bodies are identical across kinds. */
export type OperationKind = "create" | "mutate" | "destroy";

export interface OperationIR {
  name: string;
  /** Declared `or`-union return type (exception-less.md, spike).  Absent on a
   *  legacy mutation operation (no `: T` clause).  When present, the operation
   *  body produces the value via a `return` statement and the route translates
   *  an `error`-variant result to a ProblemDetails status. */
  returnType?: TypeIR;
  /** Lifecycle kind discriminator.  Absent ⇒ `"mutate"` (the legacy
   * `operation` keyword and every pre-lifecycle IR literal).
   * `agg.operations` only ever holds `"mutate"` actions; `"create"` /
   * `"destroy"` actions live in `agg.creates` / `agg.destroys`. */
  kind?: OperationKind;
  /** True for an unnamed canonical `create(...)` / `destroy { }`.  The
   * synthesised `name` is then the keyword itself (`"create"` /
   * `"destroy"`).  Drives the bare-collection-URL route slug derived in
   * Phase 2 (`urlStyle` enrichment).  Only meaningful on create/destroy. */
  canonical?: boolean;
  /** HTTP path segment for this action, derived in enrichment from the
   * surfacing api's `urlStyle` (D-URLSTYLE).  `undefined` ⇒ a canonical
   * action ⇒ the bare collection / canonical-id URL.  Otherwise the
   * action `name` (`urlStyle: literal`) or its plural (`resource`).
   * Consumed by every backend's route emitter (`snake(op.routeSlug ??
   * op.name)` on Hono / .NET / elixir, plus the React API client and
   * the OpenAPI emitters). */
  routeSlug?: string;
  visibility: "public" | "private";
  params: ParamIR[];
  statements: StmtIR[];
  /** When true, the body contains preconditions only — the
   * generator emits a wrapper that loads the aggregate, runs the
   * preconditions, dispatches to a user-supplied handler
   * (registered via DI on .NET, via a typed registry on TS),
   * persists, and drains pending events.  The aggregate class
   * itself does NOT get a method body for an extern operation;
   * the user owns the business decision. */
  extern: boolean;
  /** When true, every HTTP invocation of this operation appends an
   * audit record (who/what/when + before/after wire snapshot) to the
   * generated Hono project's in-memory audit sink.  Inert on private
   * operations (no route).  Emission is implemented on the Hono (`node`)
   * backend only — hosting an `audited` operation on another backend is
   * rejected at validate time (`loom.audited-backend-unsupported`,
   * `validateAuditedOperationSupport`) rather than silently recording
   * nothing.  See `docs/old/proposals/audit-and-logging.md`. */
  audited: boolean;
  /** The `when Expr` canCommand state gate (criterion.md, use site 2):
   * a pure predicate over the aggregate's own state, evaluated against
   * the loaded instance before the body runs.  False → 409 Disallowed
   * ProblemDetails; an auto-exposed side-effect-free
   * `GET /{id}/can_<op>` returns `{ allowed }` for UI enablement.
   * Lowered in the aggregate env (operation params are out of scope —
   * `loom.when-references-op-param`); named criteria / aggregate
   * functions inline like any boolean position.  Emission: Hono +
   * .NET; gated on elixir (`loom.when-unsupported`). */
  when?: ExprIR;
  /** Provenance chain back to the `.ddd` source — see
   * src/ir/types/origin.ts.  Populated at lowering; absent on purely
   * derived nodes. */
  origin?: OriginRef;
}

/** Event-fold applier — the lowered form of an `apply(e: Event) { … }`
 * member on an event-sourced (`persistedAs(eventLog)`) aggregate.  Folds
 * one event type into aggregate state.  Under the event-log discipline
 * the command bodies (`operation`/`create`) only `emit`; the actual
 * state transition lives in the matching applier.  Bodies are pure folds
 * — assignment statements and derivations only (enforced by
 * `validateEventSourcedDiscipline` in phase ⑦); no `emit`, no
 * side-effecting calls.  Not yet consumed by backends (emission is the
 * deferred Phase A2; the event-store/fold/projection layer).  See
 * docs/old/proposals/workflow-and-applier.md. */
export interface ApplyIR {
  /** The event type this applier folds, by name (resolved to a context
   * `EventDecl`).  One applier per event type per aggregate. */
  event: string;
  /** The lambda-style parameter name the event instance is bound to in
   * the body (e.g. `e` in `apply(e: OrderPlaced)`).  Resolves as
   * `refKind: "param"` inside the body. */
  param: string;
  /** The fold body — assignments / derivations against `this`. */
  statements: StmtIR[];
}

export interface EntityPartIR {
  name: string;
  parentName: string;
  parentIdValueType: IdValueType;
  fields: FieldIR[];
  contains: ContainmentIR[];
  derived: DerivedIR[];
  invariants: InvariantIR[];
  functions: FunctionIR[];
}

/** One field in an aggregate / part / value object's canonical
 * wire shape.  See `src/ir/enrich/enrichments.ts`. */
export type WireFieldSource = "id" | "property" | "containment" | "derived";

export interface WireField {
  /** JSON key on the wire.  Stays as the user wrote it in the
   * `.ddd` source — backends that prefer PascalCase / camelCase
   * decide their own casing rule. */
  name: string;
  /** Domain-typed value the wire field carries.  For containment
   * collections, this is `array { element: entity { name } }`; for
   * single containments it's `entity { name }`. */
  type: TypeIR;
  /** True iff the source field was declared `T?`. */
  optional: boolean;
  /** Where the wire field came from in the IR. */
  source: WireFieldSource;
  /** Resolved access role.  Always set after enrichment.  For
   * `source: "id"` this is always `"token"`; for `source: "property"`
   * it mirrors the originating `FieldIR.access`; for `"containment"`
   * and `"derived"` it is `"editable"` until a real case demands
   * otherwise. */
  access: FieldAccess;
}

export interface AggregateIR {
  name: string;
  idValueType: IdValueType;
  fields: FieldIR[];
  contains: ContainmentIR[];
  derived: DerivedIR[];
  invariants: InvariantIR[];
  /** Uniqueness invariants declared via `unique (...)`
   * (uniqueness-and-indexes.md).  Populated by lowering; omitted when the
   * aggregate declares none.  The migrations builder derives a DB unique
   * index (partial under `softDeletable`) from each entry; backends derive
   * the constraint-name → field map for the 23505 → 409 conflict mapping. */
  uniqueKeys?: UniqueKeyIR[];
  functions: FunctionIR[];
  /** Mutate-kind actions only (the legacy `operation` keyword).
   * `create` / `destroy` actions are intentionally NOT here — they live
   * in `creates` / `destroys` so the ~50 existing operation consumers
   * (route emitters, OpenAPI, page-objects, …) keep seeing only
   * mutate-style endpoints until per-kind emission lands (Phase 3). */
  operations: OperationIR[];
  /** `kind: "create"` lifecycle factory actions.  Populated by lowering;
   * empty array when the aggregate declares none.  Not yet consumed by
   * backends (Phase 3). */
  creates?: OperationIR[];
  /** `kind: "destroy"` lifecycle terminator actions.  Populated by
   * lowering; empty array when none. */
  destroys?: OperationIR[];
  /** The single unnamed canonical `create`, if declared, else null.
   * Convenience accessor over `creates`. */
  canonicalCreate?: OperationIR | null;
  /** The single unnamed canonical `destroy`, if declared, else null. */
  canonicalDestroy?: OperationIR | null;
  parts: EntityPartIR[];
  tests: TestIR[];
  /** Reified create-input contract — the client-suppliable field set with
   * per-field required-ness.  Populated by `enrichLoomModel`
   * (`buildCreateInput`); the single source backends consume instead of
   * re-deriving the create payload.  See {@link CreateInputFieldIR}. */
  createInput?: CreateInputFieldIR[];
  /** Many-to-many associations derived from `Target id[]` fields.
   * Populated by `enrichLoomModel`; one entry per reference-collection
   * field.  Empty array when the aggregate has none. */
  associations?: AssociationIR[];
  /** Filter predicates contributed by `filter <expr>` declarations
   * (hand-written or macro-emitted) on the aggregate, plus any
   * propagated from the enclosing context.  Each entry is a lowered
   * Loom expression evaluated against a lambda-bound row in the
   * query layer.  Backends install them via their query-filter API
   * (.NET: per-capability `HasQueryFilter` loops in OnModelCreating;
   * Drizzle: query wrapper; Ecto: base query helper).
   *
   * Composes additively — N filters become N conjunctively-applied
   * predicates at the storage layer. */
  contextFilters?: ExprIR[];
  /** Per-`contextFilters` entry: set when that filter expression is
   * *exactly* one named `criterion` reference — index-aligned with
   * `contextFilters`, `undefined` for composed/anonymous predicates.
   * Mirrors `FindIR.criterionRef` (the predicate itself stays inlined in
   * `contextFilters`, so non-reifying consumers are unaffected).  Backends
   * that reify capability filters consume this — the Hono repository calls
   * the module-level `<name>Criterion` predicate fn instead of re-inlining
   * the body (reified-criteria.md, the anonymous-`filter` row). */
  contextFilterRefs?: ({ name: string; args: ExprIR[] } | undefined)[];
  /** Per-`contextFilters` entry: the name of the capability that contributed
   * the filter (e.g. `softDeletable`), or `undefined` for a hand-written /
   * context-level bare filter — index-aligned with `contextFilters`, set by the
   * expander on the spliced `FilterDecl` and threaded through lowering.  This is
   * the provenance the `ignoring <Cap>` bypass surface resolves against: a
   * backend maps a bypassed capability name to the predicate(s) it owns.  Purely
   * additive — no consumer until the bypass surface lands, so byte-neutral. */
  contextFilterOrigins?: (string | undefined)[];
  /** The WRITE-scope predicate an INSTANCE mutation's command load must satisfy
   *  (authorization Phase 3 P3.1 — `docs/old/plans/authorization-phase3.md`).
   *  Derived in enrichment from the aggregate's `policy` read + write levels,
   *  and set **only when the write scope is strictly narrower than the read
   *  scope** — i.e. when the mutation load (which reuses the read filter on
   *  every backend) must be tightened below what a read can see.  Two shapes:
   *  the flat `tenantId ==` floor (`write local` under a widened read) or the
   *  `deep` descendant-or-self sentinel (`write deep` under a `global` read).
   *  `undefined` = the command load already matches the write scope, so the
   *  mutation seam stays byte-identical.  Uses `currentUser`, so backends
   *  render it through their existing principal-filter path. */
  writeScopeFilter?: ExprIR;
  /** Lifecycle stamping rules contributed by `stamp onCreate { ... }`
   * / `stamp onUpdate { ... }` declarations (hand-written or
   * macro-emitted) on the aggregate, plus any propagated from the
   * enclosing context.  Each rule lists field/value pairs to assign
   * at the matching lifecycle event.  Backends iterate this in their
   * per-entity stamping path (.NET: registry-driven
   * SaveChangesInterceptor; Drizzle: insert/update middleware;
   * Ecto: changeset functions).
   *
   * Composes additively — N stamping declarations yield N rule sets
   * concatenated per event. */
  contextStamps?: ContextStampIR[];
  /** Typed capabilities this aggregate implements (via `with <Cap>` /
   * `implements <Cap>`, at aggregate or context scope).  Sorted + deduped at
   * lowering time; undefined when the aggregate implements none.  Capability
   * application has already spliced the fields/filter/stamp by this point — this
   * is the surviving identity record, consumed by capability-aware emission
   * (marker interfaces `I<Cap>` and the stamp-interceptor dedup —
   * docs/old/proposals/capability-emission-dedup.md) and by tooling
   * (find-implementors). */
  capabilities?: readonly string[];
  /** Pointer to the `derived display: string` field, if the
   * aggregate declared one.  Populated by `enrichLoomModel`.
   * When set, `string(aggregate)` and implicit `string + aggregate`
   * compile by lowering to a member access on this derived; when
   * unset, both are validator errors. */
  displayDerived?: DerivedIR;
  /** Pointer to the `derived inspect: string` field; always populated
   * after enrichment (auto-injected by the `defaultInspect()` macro
   * when the user didn't declare one).  Read by the host-language
   * debug-string emitters (TS `toString()`/`util.inspect.custom`,
   * C# `ToString()` override, Elixir `defimpl Inspect`). */
  inspectDerived?: DerivedIR;
  /** Primary truth kind declared on the aggregate's header via the
   * `persistedAs(…)` modifier (D-DOCUMENT-AXIS; replaces the former
   * body `persistenceStrategy:` clause).  Values align to the
   * `dataSource` `kind` set — `state` → `kind: state`, `eventLog` →
   * `kind: eventLog` — so `resolve-datasource.ts` is an identity.
   * Omitted in the IR when not declared in source (default `state`);
   * the IR preserves source fidelity for the AST → IR → printer
   * round-trip. */
  persistedAs?: PersistenceStrategy;
  /** Saving shape of the materialised read model / snapshot
   * (D-DOCUMENT-AXIS, `shape(relational | embedded | document)` header
   * modifier).  One of three points on the relational↔document
   * spectrum (see {@link SavingShape}).  Omitted when not declared
   * (default `relational`); a per-projection `dataSource shape:` knob
   * can override it (see {@link effectiveSavingShape}). */
  savingShape?: SavingShape;
  /** Event-fold appliers declared via `apply(e: Event) { … }` members.
   * One per event type the aggregate folds.  Only meaningful on
   * event-sourced aggregates (`persistedAs(eventLog)`); the discipline
   * validator (phase ⑦) rejects appliers on state-sourced aggregates and
   * requires a matching applier for every emitted event.  Omitted /
   * empty when the aggregate declares none.  Not yet consumed by
   * backends (deferred Phase A2). */
  appliers?: ApplyIR[];
  /** Aggregate-inheritance (aggregate-inheritance.md, I1).  `true` for an
   * `abstract aggregate` base — never instantiated, no repository, emits no
   * table of its own.  Omitted (≡ false) for ordinary/concrete aggregates. */
  isAbstract?: boolean;
  /** Tenancy header flag (multi-tenancy Phase 1a).  `true` for an
   * `aggregate X crossTenant { … }` — shared reference data that opts out
   * of the tenant filter under a `tenancy by` system.  Omitted (≡ false)
   * when not declared.  The aggregate's tenancy *stance* (owned / cross /
   * unmarked / registry) is classified on demand by the phase-⑦ tenancy
   * checks from this flag + capabilities + `SystemIR.tenancy` — never
   * stamped here (derive-don't-stamp). */
  crossTenant?: boolean;
  /** Name of the `abstract` base this aggregate `extends`, if any.  Always
   * resolves to an abstract aggregate (enforced by the validator).  Field
   * inheritance into the concrete's `wireShape` is an I2 concern; in I1 this
   * only records the declared relationship. */
  extendsAggregate?: string;
  /** Inheritance table layout declared via the `inheritanceUsing(…)` header
   * modifier (D-RENAME).  `sharedTable` = TPH (one table + `kind`
   * discriminator); `ownTable` = TPC (table per concrete).  Omitted when not
   * declared; only meaningful on an `abstract` base or an `extends` subtype.
   * A `persistedAs(eventLog)` / `shape(document)` concrete of a `sharedTable`
   * base is forced to `ownTable` (D-ES-TPH; enforced by the validator). */
  inheritanceUsing?: InheritanceLayout;
  /** Provenance chain back to the `.ddd` source — see
   * src/ir/types/origin.ts.  Populated at lowering; absent on purely
   * derived nodes. */
  origin?: OriginRef;
}

/** Inheritance table layout — the aggregate-inheritance layout axis
 *  (D-RENAME, amended by D-DOCUMENT-AXIS §4).  Spelled in source as the
 *  `inheritanceUsing(sharedTable | ownTable)` header paren modifier.
 *    - `sharedTable` — TPH: the whole hierarchy shares one table with a
 *      `kind` discriminator column; `Party id` refs target that base table.
 *    - `ownTable` — TPC: one table per concrete, no base table; bare
 *      `Party id` refs to the base are forbidden (FK target ambiguous). */
export type InheritanceLayout = "sharedTable" | "ownTable";

/** How an aggregate's hierarchy is physically laid out — the saving-shape
 *  axis of D-DOCUMENT-AXIS (orthogonal to {@link PersistenceStrategy},
 *  the truth-kind axis).  Three points on the relational↔document
 *  spectrum:
 *    - `relational` — table-per-entity: root columns + child tables +
 *      join tables.  The default.  Queryable everywhere.
 *    - `embedded` — queryable root row (its scalar / `X id` fields stay
 *      columns) with contained parts folded into JSONB columns; no child
 *      tables.  EF owned-types `.ToJson()`, Drizzle jsonb column, Phoenix
 *      embedded schemas.
 *    - `document` — the whole aggregate (root included) serialised as one
 *      opaque JSONB blob (`id, data, version`); schema-flexible,
 *      load-by-id (Marten-style).  Not every backend supports it (see
 *      `PersistenceAdapter.supportedShapes`). */
export type SavingShape = "relational" | "embedded" | "document";

/** The aggregate's primary truth kind.  Named to match the
 *  `dataSource` `kind` vocabulary (`state` / `eventLog`); surfaced in
 *  source as `persistedAs(state | eventLog)`. */
export type PersistenceStrategy = "state" | "eventLog";

/** A single stamping rule attached to an aggregate.  Backends
 * dispatch on `event` and emit assignments for the matching
 * lifecycle moment.  Values are arbitrary lowered Loom
 * expressions — `currentUser`, `now()`, constants, derived
 * expressions, etc. — translated by the backend's normal
 * expression renderer. */
export interface ContextStampIR {
  event: "create" | "update";
  assignments: ContextStampAssignmentIR[];
}

export interface ContextStampAssignmentIR {
  /** Field name on the aggregate that gets stamped.  Must match a
   * declared field (validated when the IR is consumed; an unknown
   * field is a generator-side error). */
  field: string;
  /** Lowered expression whose result is assigned to `field`. */
  value: ExprIR;
}

export interface TestIR {
  name: string;
  statements: TestStmtIR[];
  /** Traceability back-link: the `verifies <TC-id>` clause
   *  naming the TestCase this executable test realises.  Undefined when
   *  the test declares no link.  Enrichment uses it to mark a TestCase
   *  as backed by an executable test. */
  verifiesTestCase?: string;
}

export type TestStmtIR =
  | StmtIR
  | { kind: "expect"; expr: ExprIR; source: string }
  | { kind: "expect-throws"; expr: ExprIR; source: string; status?: number };

export interface EnumIR {
  name: string;
  values: string[];
}

export interface ValueObjectIR {
  name: string;
  fields: FieldIR[];
  derived: DerivedIR[];
  invariants: InvariantIR[];
  functions: FunctionIR[];
  /** Unit tests anchored to this value object (nested `test` member, or a
   *  hoisted `test … for <VO>`).  Same `TestIR` shape as `AggregateIR.tests`;
   *  emitted as a colocated unit file (test-placement.md, Phase 2). */
  tests: TestIR[];
  /** Provenance chain back to the `.ddd` source — see
   * src/ir/types/origin.ts.  Populated at lowering; absent on purely
   * derived nodes. */
  origin?: OriginRef;
}

export interface EventIR {
  name: string;
  fields: FieldIR[];
  /** Provenance chain back to the `.ddd` source — see
   * src/ir/types/origin.ts.  Populated at lowering; absent on purely
   * derived nodes. */
  origin?: OriginRef;
}

/** A channel — the publisher-side contract for how a context's events are
 *  transported (channels.md, Slice 1).  Declared as a context member; its
 *  `carries` list names events of the enclosing context, and the orthogonal
 *  `delivery` x `retention` knobs select pub/sub vs work-queue vs durable
 *  stream.  The contract is transport-neutral — a `ChannelSourceIR` binds it
 *  to a physical storage at system scope.  Defaults (when a knob is omitted)
 *  reproduce today's in-process broadcast/ephemeral behaviour. */
export interface ChannelIR {
  name: string;
  /** Carried event type names (resolved). */
  carries: string[];
  delivery: "broadcast" | "queue";
  retention: "ephemeral" | "log" | "work";
  /** Partition/ordering key — a field common to the carried events. */
  key?: string;
}

/** The payload-family discriminator (payload-transport-layer.md, P1).
 *  `payload` is the umbrella; `event` / `command` / `query` / `response`
 *  / `error` are sugar subtypes carrying the same structural-record wire
 *  contract.  `event` is the only one that also has its own legacy
 *  declaration surface (`EventDecl`) — it is projected into the unified
 *  `payloads` view at lowering time; the rest parse via `PayloadDecl`. */
export type PayloadKind = "payload" | "event" | "command" | "query" | "response" | "error";

/** A structured-data carrier crossing a boundary (payload-transport-layer.md,
 *  P1).  Either a **record** (structurally typed field list — the P1+P2 shape)
 *  or a **named discriminated union** (`payload Foo = A | B`, P4) when
 *  `variants` is set.  The two forms are mutually exclusive: a union payload
 *  carries `variants` and an empty `fields`. */
export interface PayloadIR {
  name: string;
  kind: PayloadKind;
  fields: FieldIR[];
  /** Set for a named union (`payload Foo = A | B | C`, P4) — the source-order
   *  variant types.  Absent on record payloads.  Identity is by the payload's
   *  name; the variant set is canonicalized for duplicate detection via
   *  `unionVariantKey`.  The anonymous `A or B` form produces a `union` TypeIR
   *  inline instead of a named `PayloadIR`. */
  variants?: TypeIR[];
  /** True for compiler-synthesized payloads (P2's per-aggregate
   *  `<Agg>Wire`), false/absent for author-declared ones.  Lets later
   *  phases and the validator distinguish derived shapes from source. */
  synthesized?: boolean;
  /** Set on a payload monomorphized from a generic carrier instantiation
   *  (P3b) — carries the originating `ctor` + carrier `arg` so backends can
   *  emit it as a DTO and resolve a `genericInstance` reference to this
   *  payload's name.  Absent on `<Agg>Wire` and author payloads. */
  generic?: { ctor: GenericCtorName; arg: TypeIR };
}

export interface FindIR {
  name: string;
  params: ParamIR[];
  returnType: TypeIR;
  /** Authorization gate (D-AUTH-OIDC / default-deny).  An optional
   *  `requires <expr>` clause — a boolean evaluated against `currentUser`
   *  *before* the query runs; failure → 403.  Distinct from `filter`: the
   *  filter scopes which rows come back (queryable, pushed to SQL), the gate
   *  decides whether the caller may hit the endpoint at all.  Lowered in the
   *  bare context scope (currentUser only, no aggregate row / params), so it
   *  can reference `currentUser` + constants but not the source row's fields.
   *  `requires true` is the explicit intentionally-public escape (the
   *  read-side twin of the view / operation gate). */
  requires?: ExprIR;
  /** Optional `where ...` filter expression in IR form. */
  filter?: ExprIR;
  /** Set when the `where` filter is *exactly* one named `criterion`
   *  reference — its name + lowered args, for backends that consume the
   *  reified `Criterion`.  `filter` still carries the inlined predicate, so
   *  composed/anonymous filters and non-reifying backends are unaffected. */
  criterionRef?: { name: string; args: ExprIR[] };
  /** `ignoring *` — bypass EVERY capability query-filter on the aggregate for
   *  this read (named-filter-bypass.md §11).  Resolved from the grammar
   *  `bypassAll` flag.  Mutually exclusive with `bypassCaps`. */
  bypassAll?: boolean;
  /** `ignoring A, B` — the resolved capability NAMES whose query-filters this
   *  read bypasses (named-filter-bypass.md §11).  Index-aligned with nothing;
   *  a backend maps each name to the predicate(s) it contributed via
   *  `AggregateIR.contextFilterOrigins`.  Only the capability *name* is stored
   *  (fully-resolved IR) — the per-backend filter identity (e.g. the EF
   *  `HasQueryFilter` name) is derived in the emitter. */
  bypassCaps?: string[];
  /** Compiler-synthesized find — NOT author-declared and NOT auto-exposed as
   *  its own HTTP route.  Set by enrich when a paged `queryHandler` over
   *  `Repo.run(<Criterion>)` (paged-run) needs the #1904 paged FIND repo-method
   *  emitted for it to call; the exposure is the queryHandler's own route, so
   *  the aggregate router skips this find (route + query schema + paged DTO).
   *  The repository builder still emits the method. */
  synthesized?: boolean;
}

export interface RepositoryIR {
  name: string;
  aggregateName: string;
  finds: FindIR[];
  /** Provenance chain back to the `.ddd` source — see
   * src/ir/types/origin.ts.  Populated at lowering; absent on purely
   * derived nodes. */
  origin?: OriginRef;
}

/** A named, parameterised, pure boolean predicate over a candidate
 *  type — the Specification Pattern (Evans / Spring-Data style).  See
 *  docs/criterion.md.
 *
 *  A criterion is *inlined* wherever it is referenced from a boolean
 *  expression position (`view ... where`, repository `find ... where`,
 *  an `invariant`, an operation guard): the use-site re-lowers the
 *  predicate body with its parameters substituted and the candidate
 *  rebound to the host receiver, so no backend consumes `CriterionIR`
 *  directly today.  The IR record is retained for tooling, traceability
 *  and the forthcoming `Repo.findAll(criterion, …)` surface. */
export interface CriterionIR {
  name: string;
  params: ParamIR[];
  /** The `of <T>` candidate type.  `kind: "entity"` for an aggregate
   *  candidate; `kind: "primitive", name: "bool"` for a pure ambient
   *  predicate with no candidate. */
  targetType: TypeIR;
  /** The lowered predicate body, lowered in the criterion's own scope
   *  (parameters as `param` refs, candidate fields as `this-prop`).
   *  Use-sites inline a freshly-substituted copy rather than reading
   *  this; it exists for tooling / traceability / future query
   *  emission. */
  body: ExprIR;
}

/** A stateless, named, context-level container of NON-mutating
 *  operations — the pure-calculator floor (domain-services.md, v1 Shape
 *  A).  Operations take aggregates / value objects / primitives by
 *  value and return a value or an `or`-union error; they may `throw`
 *  for the bug regime but never touch infrastructure (a phase-⑦
 *  validator rejects repo / extern / api / workflow-start / emit /
 *  this-write).  Unlike a `criterion`, a domain service is NOT
 *  queryable (it does not inline to SQL `where`); a member call
 *  `Pricing.quote(...)` lowers to a Call with `callKind:
 *  "domain-service"`, so each backend emits a real call into the
 *  generated service module — no re-resolution. */
export interface DomainServiceIR {
  name: string;
  operations: DomainServiceOperationIR[];
  /** Unit tests anchored to this domain service (nested `test` member, or a
   *  hoisted `test … for <Service>`).  Same `TestIR` shape as
   *  `AggregateIR.tests`; emitted as a colocated unit file
   *  (test-placement.md, Phase 2). */
  tests: TestIR[];
}

/** One operation of a `domainService` (domain-services.md).  Mirrors the
 *  param/return/body shape of an aggregate `OperationIR`, but is always
 *  non-mutating (no `this`) — there is no `mutating` field to stamp; the
 *  no-infra contract is derived by the validator from the body. */
export interface DomainServiceOperationIR {
  name: string;
  params: ParamIR[];
  /** Declared `or`-union (or plain) return type; absent ⇒ no `: T` clause. */
  returnType?: TypeIR;
  body: StmtIR[];
}

/** One `sort` term of a retrieval — a structural path through the
 *  candidate aggregate plus an ordering direction. */
export interface SortTermIR {
  /** Dotted path segments, candidate-rooted (`this` stripped).  A
   *  segment flagged `collection` carried a `[]` marker. */
  path: LoadSegmentIR[];
  direction: "asc" | "desc";
}

/** One segment of a structural `loads` / `sort` path. */
export interface LoadSegmentIR {
  name: string;
  /** True when the segment carried a `[]` collection marker. */
  collection: boolean;
}

/** The fetch shape for a retrieval (load-specifications.md /
 *  reified-criteria.md §"The internal seam").  `kind: "whole"` is the
 *  default-whole load (full owned aggregate tree, cross-aggregate refs
 *  as ids) — structural, no analysis.  `kind: "explicit"` carries the
 *  author's `loads:` paths, which restrict or expand the default. */
export type LoadPlanIR = { kind: "whole" } | { kind: "explicit"; paths: LoadSegmentIR[][] };

/** A named query *bundle* (retrieval.md): a composed predicate plus the
 *  shaping a real query carries — ordering and a load shape.  Lowered
 *  from a `retrieval` declaration; the source-level realisation of the
 *  RetrievalIR bundle node (reified-criteria.md).
 *
 *  No `page` field — pagination is a call-site argument on
 *  `Repo.run(R(args), page?)`, never part of the declaration. */
export interface RetrievalIR {
  name: string;
  params: ParamIR[];
  /** The `of <T>` candidate type (entity aggregate). */
  targetType: TypeIR;
  /** The lowered `where` predicate, in the retrieval's own scope
   *  (parameters as `param` refs, candidate fields as `this-prop`).
   *  Composes criteria + bare predicates like a `find … where`. */
  where: ExprIR;
  /** Set when the `where` is *exactly* one named `criterion` reference
   *  (`where: NamedLike(needle)`) — the criterion name + its lowered
   *  argument expressions, for backends that consume the reified
   *  `Criterion`/Specification (the `.where` body is still the inlined
   *  predicate, so non-reifying backends are unaffected).  Omitted when
   *  the `where` is composed or an anonymous expression. */
  criterionRef?: { name: string; args: ExprIR[] };
  /** Ordering terms, in declaration order.  Empty when no `sort:`. */
  sort: SortTermIR[];
  /** Fetch shape; `{ kind: "whole" }` when no `loads:` clause. */
  loadPlan: LoadPlanIR;
}

export interface BoundedContextIR {
  name: string;
  enums: EnumIR[];
  valueObjects: ValueObjectIR[];
  events: EventIR[];
  /** Unified payload-family view (payload-transport-layer.md, P1+P2):
   *  author-declared `PayloadDecl`s (payload/command/query/response/error),
   *  the context's `event`s projected in with `kind: "event"`, and the
   *  P2 synthesized per-aggregate `<Agg>Wire` payloads.  `events` stays
   *  populated independently so existing event emission is untouched. */
  payloads: PayloadIR[];
  aggregates: AggregateIR[];
  repositories: RepositoryIR[];
  workflows: WorkflowIR[];
  /** Top-level `commandHandler` application-layer members
   *  (unfoldable-api-derivation.md, Layer 3).  Present when the context declares
   *  any; ride alongside the IR, unread by backends in this slice. */
  commandHandlers?: CommandHandlerIR[];
  /** Top-level `queryHandler` application-layer members
   *  (unfoldable-api-derivation.md, Layer 3). */
  queryHandlers?: QueryHandlerIR[];
  views: ViewIR[];
  /** Named predicate specifications declared in this context. */
  criteria: CriterionIR[];
  /** Stateless pure-calculator domain services declared in this context
   *  (domain-services.md, v1 Shape A). */
  domainServices: DomainServiceIR[];
  /** Channel declarations in this context (channels.md, Slice 1) — the
   *  publisher-side transport contracts over this context's events. */
  channels: ChannelIR[];
  /** Projection read models declared in this context (projection.md) — read
   *  models folded from foreign events.  Populated by lowering; empty when the
   *  context declares none. */
  projections: ProjectionIR[];
  /** Named query bundles declared in this context (retrieval.md). */
  retrievals: RetrievalIR[];
  /** First-boot seed datasets declared in this context (database-seeding.md).
   *  Platform-neutral; the system-level seed builder (phase ⑨) groups these
   *  per (module, dataset) and the backends emit native seeders. */
  seeds: SeedIR[];
  /** Per-error HTTP status overrides reaching this context, merged from the
   *  `httpStatus <Error> -> <Code>` clauses of every api over its subdomain
   *  (exception-less.md A1).  Populated by `enrichLoomModel`; the route
   *  translator reads `errorStatusOverrides?.[name] ?? defaultErrorStatus(name)`.
   *  Undefined in single-context (no-api) lowering — defaults apply. */
  errorStatusOverrides?: Record<string, number>;
  /** App-wide resolved HTTP status for each structural-conflict built-in
   *  (`UniquenessConflict` / `ConcurrencyConflict` / `Disallowed` /
   *  `ReferencedInUse` — expressible-builtins.md §3 / M-T3.4a). Folded across
   *  every api (first-declared `httpStatus` wins), defaulting each to 409.
   *  The backend runtime arms + OpenAPI declarations for the hardcoded 409s read
   *  `structuralErrorStatuses?.[name] ?? 409` so the two can no longer drift and
   *  `httpStatus UniquenessConflict -> 422` retargets both. Populated by
   *  `enrichLoomModel`; undefined in single-context (no-api) lowering. */
  structuralErrorStatuses?: Record<string, number>;
  /** Provenance chain back to the `.ddd` source — see
   * src/ir/types/origin.ts.  Populated at lowering; absent on purely
   * derived nodes. */
  origin?: OriginRef;
  /** Per-aggregate read reachability levels declared by `policy {}` blocks in
   *  this context (authorization.md §3; multi-tenancy Phase 2 P2.4).  Each
   *  entry names a tenant-owned aggregate and its directional read level
   *  (`local`/`deep`/`global`).  Consumed by `enrichLoomModel`
   *  (`applyPolicyReadLevels`), which rewrites the aggregate's `tenantOwned`
   *  capability filter (`contextFilters`) to the level-appropriate predicate.
   *  Undefined / empty when the context declares no policy. */
  policyReadLevels?: PolicyReadLevelIR[];
  /** Per-aggregate WRITE reachability levels declared by `policy { allow write
   *  <level> on X }` blocks in this context (authorization Phase 3 P3.1 —
   *  `docs/old/plans/authorization-phase3.md`).  A write level gates INSTANCE
   *  mutations (update-style ops, destroy, applier dispatch) on the target
   *  row's write scope; `local` is the flat `tenantId ==` floor (the default),
   *  `deep` the caller's org + descendants.  Consumed by `enrichLoomModel`,
   *  which derives each tenant-owned aggregate's `writeScopeFilter` from the
   *  read + write levels.  Undefined / empty when the context declares no
   *  `allow write` rule. */
  policyWriteLevels?: PolicyWriteLevelIR[];
  /** Per-aggregate DENY carve-outs declared by `policy { deny [write] on X }`
   *  blocks in this context (authorization Phase 4 —
   *  docs/old/plans/authorization-phase4-deny.md).  Each entry names an aggregate
   *  and the access it denies (`read` = total carve-out, the aggregate becomes
   *  invisible; `write` = read-only carve-out).  Consumed by `enrichLoomModel`
   *  (`applyPolicyDenies`), which — AFTER the allow read/write-level passes, so
   *  DENY WINS — appends an always-false predicate to the aggregate's read
   *  `contextFilters` (deny read) or overwrites its `writeScopeFilter` (deny
   *  write) with `buildDenyFilter`.  Undefined / empty when the context declares
   *  no `deny` rule. */
  policyDenies?: PolicyDenyIR[];
}

/** One `allow <level> on <Aggregate>` rule lowered from a `policy {}` block —
 *  a tenant-owned aggregate's directional read reachability level
 *  (multi-tenancy Phase 2 P2.4).  `local` is today's `tenantId ==` tenant
 *  floor (and the default when no policy names an aggregate); `deep` widens to
 *  the caller's org + all descendants (a `dataKey` materialized-path prefix
 *  match); `global` is all rows in the caller's tenant (tenant-root-floored). */
export interface PolicyReadLevelIR {
  /** The tenant-owned aggregate this level applies to (by name, in this
   *  context).  Resolution + tenant-owned-ness is validated in phase ⑦. */
  aggregate: string;
  /** The directional read level. */
  level: "local" | "deep" | "global";
  /** Source span text for diagnostics (`allow deep on Invoice`). */
  source: string;
}

/** One `allow write <level> on <Aggregate>` rule lowered from a `policy {}`
 *  block (authorization Phase 3 P3.1).  `local` is the flat `tenantId ==`
 *  tenant floor (and the default write scope when no rule names an aggregate);
 *  `deep` widens to the caller's org + all descendants (a `dataKey`
 *  materialized-path prefix).  `global` parses but is rejected in P3.1
 *  (`loom.policy-write-global-unsupported`). */
export interface PolicyWriteLevelIR {
  /** The tenant-owned aggregate this write level applies to (by name, in this
   *  context).  Resolution + tenant-owned-ness is validated in phase ⑦. */
  aggregate: string;
  /** The directional write level. */
  level: "local" | "deep" | "global";
  /** Source span text for diagnostics (`allow write deep on Invoice`). */
  source: string;
}

/** One `deny [write] on <Aggregate>` carve-out lowered from a `policy {}` block
 *  (authorization Phase 4 — deny-wins, docs/old/plans/authorization-phase4-deny.md).
 *  Deny is all-or-nothing at the aggregate (no level word).  `read` denies reads
 *  (the aggregate becomes invisible; because the write command load reuses the
 *  read filter, writes fail too); `write` denies only mutations (reads stay).
 *  Unlike the allow ladder, deny is NOT restricted to tenant-owned aggregates —
 *  it composes through `contextFilters` / `writeScopeFilter`, which every
 *  aggregate carries. */
export interface PolicyDenyIR {
  /** The aggregate this carve-out denies (by name, in this context).  Resolution
   *  is validated in phase ⑦ (`loom.policy-deny-unknown-aggregate`). */
  aggregate: string;
  /** Which access the rule denies. */
  access: "read" | "write";
  /** Source span text for diagnostics (`deny write on Order`). */
  source: string;
}

/** A first-boot seed dataset for a context's aggregates
 *  (database-seeding.md).  Declarative form only in this slice: each row is
 *  the create-parameter shape of one aggregate, lowered through the domain
 *  `create` by default (D-SEED-PATH).  `module` is attached later by the
 *  system-level builder; at context-lowering time only `dataset`/`path`/`rows`
 *  are known. */
export interface SeedIR {
  /** Dataset name; `"default"` runs unconditionally, others gate on
   *  `LOOM_SEED` / the test harness.  Defaults to `"default"` when the
   *  source omits it. */
  dataset: string;
  /** Through the domain `create` (default) or straight to tables (`raw`). */
  path: "domain" | "raw";
  /** Ordered records, in source order.  (Topological reorder by `@handle`
   *  cross-row refs is a later slice.) */
  rows: SeedRowIR[];
}

/** One seeded aggregate instance — the create-parameter shape, no `id`. */
export interface SeedRowIR {
  /** Target aggregate name. */
  aggregate: string;
  /** Field initialisers, fully-resolved to `ExprIR`. */
  fields: { name: string; value: ExprIR }[];
}

/** A saved, strongly-typed query over one source aggregate.  Two
 *  forms share one IR shape:
 *
 *   - **Shorthand** (`view X = Y where ...`): `output` is undefined;
 *     result is the source aggregate's enriched wire shape (an
 *     array thereof).
 *   - **Full form** (`view X { fields ... from Y where? ... bind ... }`):
 *     `output` is populated with the declared field set and a
 *     bind expression per field.  The view's response shape is a
 *     fresh record matching `output.fields`; the bind expressions
 *     project from the hydrated source aggregate to the row.
 *
 *  Compiles to a per-view method on the source aggregate's
 *  repository plus a `GET /views/<snake_name>` route on each
 *  backend.  Joined sources and per-view parameters are not yet
 *  supported. */
/** A view's source — an aggregate (read through its repository), a
 *  workflow (read through its persisted instance / saga-state row;
 *  workflow-instance-views.md), or a projection (read through its persisted
 *  `<Proj>Row` read-model row; projection.md v1.1).  Must live in the same
 *  context as the view. */
export interface ViewSourceIR {
  kind: "aggregate" | "workflow" | "projection";
  name: string;
}

export interface ViewIR {
  name: string;
  /** Source aggregate or workflow.  Must live in the same context as the
   *  view declaration. */
  source: ViewSourceIR;
  /** Authorization gate (D-AUTH-OIDC / default-deny).  An optional
   *  `requires <expr>` clause — a boolean evaluated against `currentUser`
   *  *before* the query runs; failure → 403.  Distinct from `filter`: the
   *  filter scopes which rows come back (queryable, pushed to SQL), the gate
   *  decides whether the caller may hit the endpoint at all.  Lowered in the
   *  bare context scope (currentUser only, no source row), so it can reference
   *  `currentUser` + constants but not aggregate fields.  `requires true` is
   *  the explicit intentionally-public escape. */
  requires?: ExprIR;
  /** Queryable predicate.  Required by the shorthand grammar;
   *  optional in the full form.  Subject to the same restrictions
   *  as repository find filters. */
  filter?: ExprIR;
  /** `ignoring *` — bypass EVERY capability query-filter on the source
   *  aggregate for this view read (named-filter-bypass.md §11).  Mutually
   *  exclusive with `bypassCaps`.  See `FindIR.bypassAll`. */
  bypassAll?: boolean;
  /** `ignoring A, B` — resolved capability names whose filters this view read
   *  bypasses (named-filter-bypass.md §11).  See `FindIR.bypassCaps`. */
  bypassCaps?: string[];
  /** Custom output shape.  Undefined for the shorthand form. */
  output?: {
    fields: FieldIR[];
    binds: { name: string; expr: ExprIR; type: TypeIR }[];
    /** Foreign aggregates referenced by bind expressions via
     *  `X id` follow.  Multi-hop supported: `path` is the chain of
     *  Id-typed field accesses from the source aggregate outward —
     *  `["customerId"]` for `customerId.name`,
     *  `["customerId", "regionId"]` for
     *  `customerId.regionId.name`.  Each unique path produces one
     *  bulk-load + map at view-emission time.  Auxiliaries are
     *  ordered by path length (shortest first) so each load's
     *  prerequisites are already in scope.  Empty when the view has
     *  no follows. */
    auxiliaries: { path: string[]; aggName: string; mapVar: string }[];
  };
  /** Provenance chain back to the `.ddd` source — see
   * src/ir/types/origin.ts.  Populated at lowering; absent on purely
   * derived nodes. */
  origin?: OriginRef;
}

/** SQL-92 isolation levels — optional on `transactional` workflows.
 *  When omitted, the connection's default level applies (Postgres
 *  defaults to `readCommitted`). */
export type IsolationLevel =
  | "readUncommitted"
  | "readCommitted"
  | "repeatableRead"
  | "serializable";

/** Context-level orchestration that loads + creates aggregates,
 *  invokes their public operations, and emits orchestration-level
 *  events.  Default save semantics: each aggregate's save commits
 *  independently.  `transactional: true` wraps everything in one DB
 *  transaction. */
export interface WorkflowIR {
  name: string;
  /** @deprecated Facade over the primary (unnamed, command-triggered) create —
   *  see `creates`.  Kept so the backend emitters (Hono / .NET / Phoenix /
   *  React) keep reading `params`/`statements`/`savesAtExit` unchanged after
   *  the A2-S5f reshape; they migrate to `creates` in a later slice. */
  params: ParamIR[];
  transactional: boolean;
  /** Set only when the source declared `transactional(<level>)`.
   *  Bare `transactional` leaves this undefined and the backend
   *  emits a transaction without an explicit level (connection
   *  default applies). */
  isolation?: IsolationLevel;
  /** @deprecated Facade over the primary create's body — see `creates`. */
  statements: WorkflowStmtIR[];
  /** @deprecated Facade over the primary create's saves — see `creates`.
   *  Which let-bindings need a save call at exit, in declaration order. */
  savesAtExit: { name: string; aggName: string; repoName: string }[];
  /** Workflow starters declared via `create [name](params) [by <expr>] { … }`
   *  members (workflow-and-applier.md A2-S5f).  The legacy paren-body lowers to
   *  a single unnamed command-triggered create.  This is the source of truth;
   *  `params`/`statements`/`savesAtExit` are a facade over the primary one. */
  creates: CreateIR[];
  /** Event-subscription reactors declared via `on(e: Event) [by <expr>] { … }`
   *  members (workflow-and-applier.md Phase A2, surface slice).  Omitted when
   *  the workflow declares none.  Consumed by the in-process dispatcher
   *  emission on node / dotnet / python (channels.md); the `by`
   *  correlation-field type-check runs in the IR validator (workflow-checks.ts).
   *  Java and elixir dispatch emission are the remaining gaps. */
  subscriptions?: OnIR[];
  /** Workflow state fields declared as `Property` members — the correlation
   *  field plus saga state (workflow-and-applier.md A2-S2).  Lowered with the
   *  same `lowerField` as aggregate fields.  Omitted when the workflow
   *  declares none.  Emitted as a persisted correlation-state row by the saga
   *  dispatcher (node / dotnet / elixir / python) and read back through the
   *  instance endpoints derived from `instanceWireShape`. */
  stateFields?: FieldIR[];
  /** The single id-shaped state field the runtime routes inbound events to
   *  (workflow-and-applier.md §"Identity and correlation").  Set only when
   *  exactly one id-shaped state field exists; absence / ambiguity are
   *  diagnosed by the IR validator. */
  correlationField?: string;
  /** `eventSourced` workflow (workflow-and-applier.md A2-S5b): command /
   *  reactor handlers may only `emit`, and state transitions live in
   *  `apply(...)` folds — exactly the event-sourced discipline aggregates
   *  carry via `persistedAs(eventLog)`. */
  eventSourced: boolean;
  /** Event-fold appliers declared via `apply(e: Event) { … }` members on an
   *  `eventSourced` workflow.  Lowered with the workflow's `this`-bound env
   *  (A2-S5a), so bodies fold events into workflow state.  Omitted when the
   *  workflow declares none. */
  appliers?: ApplyIR[];
  /** Named orchestration command handlers declared via `handle name(params)
   *  { … }` members (A2-S5c) — a multi-command saga's continuation commands.
   *  Each carries its own params + saves, lowered like the legacy paren-form
   *  body.  Omitted when the workflow declares none. */
  handlers?: HandleIR[];
  /** Private, expression-bodied pure helpers declared via `function f(...): T =
   *  expr` members — the aggregate-parity helper (a workflow is a state-bearing
   *  entity, so it factors shared expressions the same way).  A workflow body is
   *  not a class, so each backend emits these as per-workflow-scoped module
   *  helpers (`<wf><fn>`), and a call to one lowers to `callKind: "workflow-fn"`.
   *  Block-bodied helpers are rejected by the AST validator
   *  (`loom.workflow-function-block-body`).  Omitted when the workflow declares none. */
  functions?: FunctionIR[];
  /** Tail-position success type of the primary `run` body, derived once in
   *  enrichment (`enrichWorkflowReturnType`).  The value the workflow returns
   *  on the happy path is the last value-binding statement's result (the same
   *  `last-bind` rule the backends use to pick the `{:ok, <bind>}` return), so
   *  this is the `T` in a `{:ok, T}` success.  Set only when that type can be
   *  computed precisely and narrowed safely (no loop/sequence tail, a
   *  renderable leaf type); left `undefined` otherwise, so a backend keeps its
   *  conservative `{:ok, term()}` arm.  Consumed today by the Phoenix `@spec`
   *  emitter to tighten Dialyzer narrowing on every workflow call site. */
  returnType?: TypeIR;
  /** The canonical wire shape of a *persisted workflow instance* — the
   *  correlation-state row this workflow's saga persists (the same row
   *  `workflowStateTableShape` derives a table for).  Set by enrichment
   *  only when `correlationField` is present (a correlation-bearing,
   *  state-table-backed workflow): the correlation field as the `id`-shaped
   *  `token` row, then the remaining `stateFields` as `property` rows, in
   *  declaration order.  This is the workflow-instance analogue of an
   *  aggregate's canonical wire shape (`wireFieldsForAggregate`) — the
   *  read-only "instance" API + scaffold pages
   *  (workflow-instance-visibility.md) consume it the way the aggregate
   *  read surface consumes that wire shape.  Carried for both
   *  state-table-backed sagas and `eventSourced` workflows (the instance shape
   *  is identical — only the read body differs: a `<wf>_state` row select vs a
   *  fold of the per-correlation `<wf>_events` stream).  Absent only for
   *  stateless workflows (no correlation field ⇒ no instance to read). */
  instanceWireShape?: WireField[];
  /** Provenance chain back to the `.ddd` source — see
   * src/ir/types/origin.ts.  Populated at lowering; absent on purely
   * derived nodes. */
  origin?: OriginRef;
}

/** A named `handle name(params) { … }` command handler on a workflow
 *  (workflow-and-applier.md A2-S5c) — structurally the legacy paren-form
 *  workflow body, but named and repeatable. */
export interface HandleIR {
  name: string;
  params: ParamIR[];
  statements: WorkflowStmtIR[];
  /** Which let-bound aggregates need a save call at handler exit, in
   *  declaration order — same derivation as `WorkflowIR.savesAtExit`. */
  savesAtExit: { name: string; aggName: string; repoName: string }[];
}

/** A top-level `commandHandler name(params): T { … }` application-layer member
 *  (unfoldable-api-derivation.md, Layer 3) — a workflow `handle` lifted out of a
 *  workflow when the orchestration is single-aggregate.  `returnType` is optional
 *  (a `commandHandler` may omit it, `: void`-equivalent).  Body statements are
 *  `WorkflowStmtIR` (load → mutate → save → return), same as `HandleIR`.  Every
 *  backend's explicit-handlers emitter reads these. */
export interface CommandHandlerIR {
  name: string;
  params: ParamIR[];
  returnType?: TypeIR;
  /** Stamped SOURCE FACT — the user wrote `extern commandHandler … ;`.  An
   *  extern handler is BODYLESS: its implementation is a scaffold-once,
   *  user-owned impl file the generated dispatch calls (the "case-2" home).
   *  When set, `statements` / `returnValue` / `savesAtExit` are empty and only
   *  the signature (`params` + optional `returnType`) is load-bearing.  Same
   *  kind of stamped fact as `OperationIR.extern`; do NOT derive an
   *  `isBodyless` from it. */
  extern?: boolean;
  statements: WorkflowStmtIR[];
  savesAtExit: { name: string; aggName: string; repoName: string }[];
  /** The lowered `return <expr>` value, when the body ends in a return.  Held
   *  separately from `statements` (which are `WorkflowStmtIR`, and the shared
   *  workflow statement renderer has no `return` arm — workflow handles never
   *  return a value).  A backend renders the body statements, then
   *  `return <returnValue>`.  Absent for a `: void`-equivalent handler. */
  returnValue?: ExprIR;
}

/** A top-level `queryHandler name(params): T { … }` application-layer member
 *  (unfoldable-api-derivation.md, Layer 3).  Like `CommandHandlerIR` but the
 *  `returnType` is REQUIRED (a query always produces a response) and the body
 *  must not mutate/save (validator `loom.query-handler-saves`). */
export interface QueryHandlerIR {
  name: string;
  params: ParamIR[];
  returnType: TypeIR;
  /** Stamped SOURCE FACT — the user wrote `extern queryHandler … ;`.  See
   *  {@link CommandHandlerIR.extern}.  For a queryHandler the `returnType` is
   *  required and load-bearing as the user impl file's return contract (the
   *  external read-projection it produces). */
  extern?: boolean;
  statements: WorkflowStmtIR[];
  savesAtExit: { name: string; aggName: string; repoName: string }[];
  /** The lowered `return <expr>` value (see `CommandHandlerIR.returnValue`).  A
   *  query always produces a response, so this is effectively always present —
   *  optional only so a malformed (return-less) body lowers without a cast. */
  returnValue?: ExprIR;
}

/** A workflow starter declared via `create [name](params) [by <expr>] { … }`
 *  (workflow-and-applier.md A2-S5f).  `triggerKind` is discriminated at lowering
 *  from the param shape: a sole param whose type is an event reference →
 *  `"event"` (allocate-if-correlation-misses); otherwise `"command"`. */
export interface CreateIR {
  /** Declared name, or null for the canonical unnamed create (the legacy
   *  paren-body migrates to one of these). */
  name: string | null;
  triggerKind: "event" | "command";
  params: ParamIR[];
  /** The `by <expr>` routing expression (event-triggered starters), lowered in
   *  the create's scope.  Undefined for command-triggered creates. */
  correlation?: ExprIR;
  statements: WorkflowStmtIR[];
  savesAtExit: { name: string; aggName: string; repoName: string }[];
  /** Event-triggered only: the bound event-param name and its event type. */
  eventBinding?: string;
  eventRef?: string;
}

/** A `on(e: Event) [by <expr>] { … }` reactor on a workflow — an extrinsic
 *  event subscription / continuation handler.  Mirrors `ApplyIR`: the event
 *  instance binds as a `refKind: "param"` local in the body.  Distinct from an
 *  applier in that the body is a workflow continuation (it may load/save
 *  aggregates and emit), so its statements are `WorkflowStmtIR`. */
export interface OnIR {
  /** The event type this reactor subscribes to, by name (resolved to a
   *  context `EventDecl`). */
  event: string;
  /** The parameter name the inbound event instance binds to in the body
   *  (e.g. `paid` in `on(paid: PaymentReceived)`). */
  param: string;
  /** The `by <expr>` routing expression (workflow-and-applier.md A2-S3),
   *  lowered in the event-binding scope — e.g. `paid.orderId`.  Undefined when
   *  the source omits `by`; the runtime then routes by name-match against the
   *  workflow's correlation field (resolved at validation time). */
  correlation?: ExprIR;
  /** The reactor body — workflow statements (emit / let / op-call / …). */
  statements: WorkflowStmtIR[];
  /** Which let-bound aggregates need a save call at reactor exit, in
   *  declaration order — same `computeSaves` derivation as `HandleIR` /
   *  `CreateIR`.  A reactor is a workflow continuation, so a created /
   *  loaded-and-mutated aggregate is persisted on the way out. */
  savesAtExit: { name: string; aggName: string; repoName: string }[];
}

/** A `projection <Name> keyed by <field> { … }` read model (projection.md) —
 *  the passive read-half of an event-sourced workflow.  Declared state fields
 *  (the read-model schema + wire shape) plus pure `on(e: Event)` folds over
 *  FOREIGN events, keyed by an explicit correlation column.  No command side:
 *  a projection never emits, calls repos/operations, or starts anything — it
 *  only reflects an event stream into a queryable table.  Reuses the
 *  event-triggered saga machinery (load-or-allocate on every handler,
 *  `wireShape` read surface, state-table migration). */
export interface ProjectionIR {
  name: string;
  /** Query parameters — a query-time projection may be parameterised
   *  (`projection OrdersInRegion(region: string) …`), exactly like a
   *  criterion / retrieval.  Empty for the folded flavor. */
  params: ParamIR[];
  /** The read-model schema — the fold-target columns and the wire shape.
   *  Lowered with the same `lowerField` as aggregate / workflow state. */
  stateFields: FieldIR[];
  /** The explicit id-shaped state field inbound events route to (`keyed by`).
   *  Required for the KEYED flavor — no inference (unlike
   *  `WorkflowIR.correlationField`).  **Absent** for a SINGLETON projection
   *  (no `keyed by`); its absence is the singleton discriminant — see
   *  `isSingletonProjection`. */
  correlationField?: string;
  /** One pure fold per subscribed foreign event.  Non-empty ⇒ the read model
   *  is MATERIALIZED (needs a table); empty ⇒ query-time (computed per read).
   *  See `isMaterializedProjection`. */
  handlers: ProjectionOnIR[];
  /** The query-time comprehension.  Present when the projection declares a
   *  `from`/`where`/`join`/`select` clause (read-path-architecture.md
   *  rev.13, § "projection generalises").  Absent ⇒ a pure folded read model
   *  (today's projection).  The `materialized`/`singleton`/`query-time` facts
   *  are DERIVED from clause presence (never stamped) — see the predicates
   *  below `ProjectionIR`. */
  query?: ProjectionQueryIR;
  /** Canonical wire shape of a projection row — correlation field as an id
   *  token then the state fields, mirroring `WorkflowIR.instanceWireShape`.
   *  Populated by `enrichLoomModel`. */
  wireShape?: WireField[];
  /** Provenance chain back to the `.ddd` source. */
  origin?: OriginRef;
}

/** The query-time comprehension clauses of a generalised projection
 *  (read-path-architecture.md rev.13).  Every expression inside is Loom's one
 *  candidate-rooted language (the same `criterion` / `find … where` dialect);
 *  the LINQ shape is purely structural. */
export interface ProjectionQueryIR {
  /** `from <Source> [as <alias>]` — the query source aggregate, by name.
   *  Undefined for the folded+`join` hybrid (no `from`; `join`s resolve
   *  stored id columns instead). */
  source?: string;
  /** The author's alias for the source candidate (`from Order as o`).  `this`
   *  / bare stays the default; the alias resolves identically (like
   *  `criterion … of T as o`). */
  sourceAlias?: string;
  /** `where <criterion-expr>` — a single-aggregate queryable predicate over
   *  the source, in the criterion position (composes named criteria). */
  filter?: ExprIR;
  /** Named criterion this `where` reifies to when it is exactly one criterion
   *  reference (mirrors `RetrievalIR.criterionRef`) — the criterion name plus
   *  its lowered argument expressions. */
  criterionRef?: { name: string; args: ExprIR[] };
  /** `join <Aggregate> as <c> on <idRef>` clauses — by-id follows.  Each is
   *  one batched load through the aggregate's own repository (boundary-safe).
   *  Also surfaced pre-planned as `auxiliaries` (path + mapVar) below, reusing
   *  the machinery relocated from `lower-view`. */
  joins: ProjectionJoinIR[];
  /** `select <field> = <expr>, …` — fills the declared row fields from the
   *  source (`this`/alias) and join aliases.  Undefined ⇒ the projection
   *  exposes the source's own shape (shorthand, deferred). */
  selects?: { field: string; expr: ExprIR; type: TypeIR }[];
  /** Bulk-load plan derived from the `join` clauses — the `auxiliaries` shape
   *  `lower-view` builds for view follows, now populated by reading the
   *  DECLARED `join`s rather than walking binds for id-dots. */
  auxiliaries: { path: string[]; aggName: string; mapVar: string }[];
}

/** One `join <Aggregate> as <alias> on <idRef>` follow. */
export interface ProjectionJoinIR {
  /** The joined aggregate, by name. */
  aggregate: string;
  /** The alias the loaded aggregate binds to (`select`/`where` read from it). */
  alias: string;
  /** The id-typed reference the join resolves on — types to `<aggregate> id`;
   *  the join condition is always the aggregate's identity (`c.id == <idRef>`). */
  idRef: ExprIR;
}

/** True when the projection is MATERIALIZED (folded from events → needs a
 *  table).  Derived from clause presence — a fold `on(e)` handler present. */
export function isMaterializedProjection(p: ProjectionIR): boolean {
  return p.handlers.length > 0;
}

/** True when the projection is a SINGLETON (exactly one row).  Derived: no
 *  `keyed by` clause ⇒ no correlation field. */
export function isSingletonProjection(p: ProjectionIR): boolean {
  return p.correlationField === undefined;
}

/** True when the projection is QUERY-TIME (computed per read, always-current,
 *  no table).  Derived: a query source with no fold handlers. */
export function isQueryTimeProjection(p: ProjectionIR): boolean {
  return p.query?.source !== undefined && p.handlers.length === 0;
}

/** One `on(e: Event) [by <expr>] { … }` pure fold on a projection.  Shares the
 *  reactor SUBSCRIPTION surface with `OnIR` (foreign event + param + optional
 *  key-extraction expr) but the body is an apply-style PURE fold — `StmtIR`,
 *  not `WorkflowStmtIR` — against the pre-loaded projection row bound as `this`.
 *  Enforced pure by `loom.projection-fold-impure` (reuses the applier gate). */
export interface ProjectionOnIR {
  /** The foreign event type this handler folds, by name. */
  event: string;
  /** The parameter name the inbound event instance binds to in the body. */
  param: string;
  /** The `by <expr>` key-extraction expression, lowered in the event-binding
   *  scope (e.g. `e.orderId`).  Undefined when the source omits `by`; the
   *  runtime then routes by `e.<correlationField>` (the key field is required
   *  present on every subscribed event). */
  correlation?: ExprIR;
  /** The fold body — pure assignments / derivations against the row (`this`). */
  statements: StmtIR[];
}

export type WorkflowStmtIR =
  | { kind: "precondition"; expr: ExprIR; source: string; message?: MessageIR; origin?: OriginRef }
  | { kind: "requires"; expr: ExprIR; source: string; origin?: OriginRef }
  | {
      kind: "emit";
      eventName: string;
      fields: { name: string; value: ExprIR }[];
      origin?: OriginRef;
    }
  | {
      kind: "factory-let";
      name: string;
      aggName: string;
      fields: { name: string; value: ExprIR }[];
      origin?: OriginRef;
    }
  | {
      kind: "repo-let";
      name: string;
      repoName: string;
      aggName: string;
      method: string;
      args: ExprIR[];
      returnType: TypeIR;
      origin?: OriginRef;
    }
  | {
      kind: "expr-let";
      name: string;
      type: TypeIR;
      expr: ExprIR;
      origin?: OriginRef;
    }
  | {
      // `let xs = Repo.run(<Retrieval>(args), page?)` — bind the named
      // query bundle's result array (retrieval.md).  Distinct from
      // `repo-let` (which forbids array returns): a `repo-run` is always
      // an aggregate array, consumable only by a `for-each` loop.
      kind: "repo-run";
      name: string;
      repoName: string;
      aggName: string;
      retrievalName: string;
      retrievalArgs: ExprIR[];
      page?: { offset?: ExprIR; limit?: ExprIR };
      /** Set when this `repo-run` was lowered from `Repo.findAll(<Criterion>)`
       *  (criterion.md, use site 3) rather than `Repo.run(<Retrieval>)`.  The
       *  enrich pass synthesises a `RetrievalIR` named `retrievalName` (=
       *  `findAllBy<Criterion>`) from `ctx.criteria[name]` so the call rides
       *  the existing retrieval pipeline on every backend.  `name` is the
       *  referenced criterion. */
      synthCriterion?: { name: string };
      /** `sort:` / `loads:` shaping carried from an anonymous retrieval
       *  (`Repo.run(retrieval { where: <Criterion> sort: […] loads: […] })`,
       *  criterion.md use site 3).  Only set alongside `synthCriterion`; the
       *  enrich pass attaches them to the synthesised retrieval so the existing
       *  retrieval emitters apply `.orderBy(...)` + the load shape on every
       *  backend.  `retrievalName` carries a content hash of the shaping, so
       *  distinct shapes over one criterion get distinct retrievals. */
      synthSort?: SortTermIR[];
      synthLoadPlan?: LoadPlanIR;
      /** `ignoring *` on the inline `Repo.findAll(...)`/`Repo.run(...)` read —
       *  bypass EVERY capability query-filter on the aggregate (named-filter-
       *  bypass.md §11).  Mutually exclusive with `bypassCaps`.  See
       *  `FindIR.bypassAll`. */
      bypassAll?: boolean;
      /** `ignoring A, B` on the inline read — resolved capability names whose
       *  filters this read bypasses (named-filter-bypass.md §11).  See
       *  `FindIR.bypassCaps`. */
      bypassCaps?: string[];
      /** Element aggregate array type `{ kind: "array", element: entity }`. */
      returnType: TypeIR;
      origin?: OriginRef;
    }
  | {
      kind: "op-call";
      target: string;
      aggName: string;
      op: string;
      args: ExprIR[];
      origin?: OriginRef;
    }
  | {
      // `<Repo>.delete(o)` / `<Repo>.remove(o)` — a repository DELETE
      // (destroy) call inside a handler body.  `entity` is the loaded
      // aggregate reference to remove (e.g. the `o` from `let o =
      // Orders.getById(id)`).  Each backend renders it to its already-emitted
      // repository delete verb, with the argument shape that backend expects
      // (aggregate value for .NET/Java/Elixir, `<entity>.id` for Hono/Python).
      // Distinct from `op-call`: a delete is not an aggregate operation, and
      // the removed entity must NOT be re-saved at handler exit (`computeSaves`
      // never registers a `repo-delete` as a mutation target).
      kind: "repo-delete";
      repoName: string;
      aggName: string;
      entity: ExprIR;
      origin?: OriginRef;
    }
  | {
      // `for <var> in <iterable> { <body> }` (retrieval.md).  Iterates an
      // aggregate array, binding each element to `var`.  Mutations to
      // `var` inside the body persist via `savesPerIteration` — the same
      // dirtiness rule as workflow-exit saves, applied to the loop scope
      // and emitted INSIDE the loop (the flat workflow-level `savesAtExit`
      // can't express a per-element save).
      kind: "for-each";
      var: string;
      varAggName: string;
      iterable: ExprIR;
      body: WorkflowStmtIR[];
      savesPerIteration: { name: string; aggName: string; repoName: string }[];
      origin?: OriginRef;
    }
  | {
      // A bare (unbound) resource-op call statement — `files.put(k, v)`
      // (Phase 4).  The `let`-bound form (`let x = files.get(k)`) rides
      // `expr-let` instead.  `call` is the lowered `resource-op` call IR.
      kind: "resource-call";
      call: ExprIR;
      origin?: OriginRef;
    }
  | {
      // A bare orchestrator call into a `domainService` operation —
      // `Transfer.run(src, dst, amount)` written as a workflow statement
      // (domain-services.md rev. 4, the `mutating` tier).  Distinct from
      // `op-call` (which targets an aggregate let-binding): a service call is
      // NOT an aggregate operation, so it carries the resolved `service`/`op`
      // and a render-ready `call` (a `callKind: "domain-service"` Call that
      // rides each backend's `render-expr`).  The orchestrator owns
      // persistence: a `mutating` service mutates the aggregate ARGS it is
      // passed (their own ops), so those args become exit-save targets —
      // derived in `computeSaves` (NOT stamped here), exactly as a `repo-let`
      // that an `op-call` targets does.  The `let`-bound form
      // (`let q = Pricing.quote(...)`) rides `expr-let` instead.
      kind: "domain-service-call";
      service: string;
      op: string;
      call: ExprIR;
      origin?: OriginRef;
    }
  | {
      // `if let <var> = Repo.find(<Criterion>) { then } else { else }`
      // (criterion.md, use site 3) — the workflow body's only option/null
      // handling construct.  Binds the lookup's first match to `var`
      // (unwrapped, non-null) in `thenBody`; `elseBody` runs on no match.
      //
      // Rides the SAME synthetic retrieval as `findAll` (`retrievalName` =
      // `findAllBy<Criterion>`): the enrich pass materialises it from
      // `ctx.criteria[name]` via `synthesizeFindAllRetrievals`, so a `find` and
      // a `findAll` over one criterion share a single internal retrieval.  The
      // if-let codegen runs it with `limit: 1` and takes the first row (or
      // null) — retrievals are internal query bundles (no route leak), unlike a
      // repository `find` which would auto-expose a query endpoint.  This is
      // why the optional never becomes a standalone `repo-let` (which forbids
      // nullable returns) nor a public `find`.
      kind: "if-let";
      var: string;
      repoName: string;
      aggName: string;
      /** Name of the shared synthetic retrieval (`findAllBy<Criterion>`). */
      retrievalName: string;
      retrievalArgs: ExprIR[];
      synthCriterion: { name: string };
      thenBody: WorkflowStmtIR[];
      elseBody?: WorkflowStmtIR[];
      /** Saves for aggregates created/mutated inside `thenBody` (the bound
       *  `var` if an op-call targets it, plus factory-lets) — emitted at the
       *  end of the then-branch, the same dirtiness rule as `for-each`'s
       *  `savesPerIteration`.  Conditional branches can't hoist their saves to
       *  the flat `savesAtExit`, so each branch carries its own. */
      savesInThen: { name: string; aggName: string; repoName: string }[];
      /** Saves for aggregates created in `elseBody` (e.g. a not-found →
       *  `Agg.create(...)` fallback) — emitted at the end of the else-branch. */
      savesInElse: { name: string; aggName: string; repoName: string }[];
      origin?: OriginRef;
    }
  | {
      // `field := value` — assignment to one of the workflow's OWN state
      // fields inside a `create`/`handle`/`on` body (workflow.md, "handle =
      // own-state mutation").  The `target` PathIR resolves to a `this-prop`
      // on the workflow's persisted correlation/instance state row; the write
      // lands on that state object (NOT an aggregate `this`).  Mirrors the
      // aggregate-op `StmtIR` `assign` (loom-ir.ts) exactly.  Only `:=` lowers
      // here — `+=`/`-=` and cross-aggregate mutations stay `__bad__` and are
      // rejected at IR-validate.
      kind: "assign";
      target: PathIR;
      value: ExprIR;
      targetType: TypeIR;
      origin?: OriginRef;
    };

export interface LoomModel {
  /**
   * Explicit `system` declarations.  Each one is a complete deployment
   * plan with modules + deployables.
   */
  systems: SystemIR[];
  /**
   * Bounded contexts declared at the top level of the source file
   * (legacy single-deployable mode).  Empty when the source uses the
   * `system` vocabulary.  When non-empty, the CLI treats these as an
   * implicit anonymous system with one deployable of the platform
   * picked by the user.
   */
  contexts: BoundedContextIR[];
  /** Root-level value objects, declared at the top of any `.ddd` file
   *  outside any context.  Form the implicit shared kernel: visible
   *  as a type from every context in the workspace.  Backends emit
   *  them once into a shared module/namespace each deployable can
   *  reach.  See `docs/multi-file-source.md`. */
  rootValueObjects: ValueObjectIR[];
  /** Root-level enums.  Same visibility / emission rules as
   *  `rootValueObjects`. */
  rootEnums: EnumIR[];
  /** Root-level payloads — `payload`/`command`/`query`/`response`/`error`
   *  declared at the top of any `.ddd` file outside any context (the ambient
   *  shared kernel for transport types, exception-less.md A1).  Folded into
   *  every context's `payloads` during enrichment (mirroring `rootValueObjects`)
   *  so a `find`/operation `or`-union can name `NotFound` without a per-context
   *  re-declaration.  A context-local payload of the same name shadows. */
  rootPayloads: PayloadIR[];
  /** Root-level components — declared at the top of any `.ddd` file
   *  outside any `ui { … }`.  Pure render functions visible to every
   *  page in every ui workspace-wide; the import-graph walk merges
   *  them into the same global symbol space as `rootValueObjects` /
   *  `rootEnums`.  A `ui`-scope component with the same name wins on
   *  resolution (override semantics).  Backends emit one
   *  `src/components/<Name>.tsx` per ui that references the
   *  component. */
  components: ComponentIR[];
  /** Traceability artifacts — model-wide, since a Solution
   *  or TestCase may reference code across modules and systems. */
  requirements: RequirementIR[];
  solutions: SolutionIR[];
  testCases: TestCaseIR[];
  /** Derived traceability index, populated by `enrichLoomModel`.  Left
   *  undefined by lowering so an unenriched model is a type error to
   *  consume from a report generator. */
  traceability?: TraceabilityIR;
  /** Schema-evolution rename intents (M-T2.1) — lowered from top-level
   *  `migration "<name>" { Agg.old -> new }` blocks.  Consumed only by
   *  the phase-⑨ migration builder (`src/system/migrations-builder.ts`) to
   *  disambiguate the snapshot→model diff into explicit `renameColumn` steps;
   *  no backend reads them for domain-code emission.  Ledger-style: a block
   *  stays in source permanently and is naturally inert once its rename is
   *  baked into the baseline snapshot.  Empty when the source declares no
   *  migration block. */
  renameIntents: RenameIntentIR[];
  /** Table/aggregate rename intents (M-T2.1) — lowered from `OldName ->
   *  NewAggregate` steps in a `migration` block.  Sibling of `renameIntents`
   *  (column renames); consumed only by the migration builder, which turns
   *  each into a `renameTable` step for the aggregate's root table plus the
   *  owned-child cascade (part / value-collection / association tables and
   *  their owner FK columns).  Empty when no table renames are declared. */
  tableRenameIntents: TableRenameIntentIR[];
  /** Backfill intents (M-T2.3) — lowered from `Agg.field = <expr>` steps in
   *  a `migration` block.  Consumed only by the migration builder: a NOT-NULL
   *  `addColumn` (or NULL→NOT-NULL flip) with a matching backfill rewrites to
   *  the safe add-nullable → UPDATE → SET NOT NULL sequence WITHOUT the
   *  destructive gate.  Naturally ledger-inert: fires only when the diff
   *  contains the matching structural step.  Empty when none are declared. */
  backfillIntents: BackfillIntentIR[];
  /** Raw `sql "…"` migration steps (M-T2.3), in declaration order.  Consumed
   *  only by the migration builder, which emits each exactly once (recording
   *  `"<migration>#<index>"` in the snapshot's `appliedDataMigrations`
   *  ledger) after the generation's structural steps.  Empty when none are
   *  declared. */
  sqlMigrationSteps: SqlStepIR[];
}

/** One `rename Agg.old -> new` step lowered from a `migration` block.  Field
 *  names are the RAW source names (the migration builder snake-cases them to
 *  column names, exactly as it does for aggregate fields).  `context` scopes
 *  the aggregate to a bounded context so the builder can resolve the owning
 *  module + Postgres schema, disambiguating same-named aggregates. */
export interface RenameIntentIR {
  /** Block label — the `"<name>"` on the owning `migration` block.  Carried
   *  for diagnostics and duplicate-name validation. */
  migration: string;
  /** Target aggregate name (resolves to table `plural(snake(aggregate))`). */
  aggregate: string;
  /** Owning bounded-context name — for module/schema resolution. */
  context: string;
  /** Old (pre-rename) field name — absent from the current model. */
  from: string;
  /** New (post-rename) field name — a live field of `aggregate`. */
  to: string;
  /** Provenance back to the `rename` step's `.ddd` source. */
  origin?: OriginRef;
}

/** One `OldName -> NewAggregate` step lowered from a `migration` block — a
 *  whole-aggregate (table) rename.  `fromAggregate` is the OLD, now-absent
 *  aggregate name (its old table is `plural(snake(fromAggregate))`);
 *  `toAggregate` is the live post-rename aggregate name (resolves the owning
 *  context/module/schema and enumerates the owned child tables to cascade).
 *  Both are RAW names — the builder snake-cases + pluralises them exactly as
 *  it does elsewhere. */
export interface TableRenameIntentIR {
  /** Block label — the `"<name>"` on the owning `migration` block. */
  migration: string;
  /** Old (pre-rename) aggregate name — table `plural(snake(fromAggregate))`. */
  fromAggregate: string;
  /** New (post-rename) aggregate name — the live cross-referenced aggregate. */
  toAggregate: string;
  /** Owning bounded-context name (of the new aggregate) — for module/schema
   *  resolution. */
  context: string;
  /** Provenance back to the step's `.ddd` source. */
  origin?: OriginRef;
}

/** One `Agg.field = <expr>` backfill step (M-T2.3) lowered from a `migration`
 *  block.  Unlike a rename's dead-side names, `field` names a LIVE field of
 *  `aggregate` (the newly-added / newly-required column); `value` is lowered
 *  in the aggregate's scope, so sibling fields appear as `this-prop` refs the
 *  SQL renderer turns into column references.  The builder snake-cases names
 *  exactly as it does for table/column derivation. */
export interface BackfillIntentIR {
  /** Block label — the `"<name>"` on the owning `migration` block. */
  migration: string;
  /** Target aggregate name (table `plural(snake(aggregate))`). */
  aggregate: string;
  /** Owning bounded-context name — for module/schema resolution. */
  context: string;
  /** The LIVE field being backfilled (column `snake(field)`). */
  field: string;
  /** The backfill expression, restricted to the SQL-renderable subset
   *  (`sqlRenderableExpr` — validated at phase ⑦, rendered at phase ⑨). */
  value: ExprIR;
  /** Provenance back to the step's `.ddd` source. */
  origin?: OriginRef;
}

/** One raw `sql "…"` step (M-T2.3) lowered from a `migration` block.
 *  `index` is the step's position among the block's steps — the ledger key
 *  is `"<migration>#<index>"`, recorded in the snapshot's
 *  `appliedDataMigrations` so the statement runs exactly once. */
export interface SqlStepIR {
  /** Block label — the `"<name>"` on the owning `migration` block. */
  migration: string;
  /** Position among the owning block's steps (ledger key component). */
  index: number;
  /** The raw Postgres statement, verbatim. */
  sql: string;
  /** Provenance back to the step's `.ddd` source. */
  origin?: OriginRef;
}

// ---------------------------------------------------------------------------
// Branded phase types — distinguish the IR shape at two pipeline points.
//
//   `RawLoomModel`      — the structural output of `lowerModel`.  Optional
//                         derivation fields (`associations`, `createInput`,
//                         `traceability`, …) are absent.
//   `EnrichedLoomModel` — the output of `enrichLoomModel`.  Every derived
//                         field is populated; downstream consumers can
//                         dereference them without nullability defense.
//
// The brand is a phantom property — purely a TypeScript-level
// discriminator.  Carries zero runtime cost (the value never carries
// `__phase`).  Mostly catches the "forgot to enrich" mistake at the
// generator entry point.  See PR #517 for the canary failure mode this
// shape prevents.
//
// `EnrichedAggregateIR` is a required-field overlay that mirrors the
// structural type — its enrich-derived members (`associations`,
// `createInput`, enriched `parts`) are non-optional, so a generator that
// takes an `EnrichedLoomModel` dereferences them without nullability
// defense.  (`EnrichedEntityPartIR` / `EnrichedValueObjectIR` carry no
// enrich-time members of their own — the canonical wire shape is
// recomputed on demand via `wireFieldsForPart` / `wireFieldsForValueObject`
// — so they alias their base types.)
// ---------------------------------------------------------------------------

export type RawLoomModel = LoomModel & { readonly __phase?: "raw" };

export type EnrichedLoomModel = Omit<LoomModel, "systems" | "contexts" | "rootValueObjects"> & {
  readonly __phase: "enriched";
  systems: EnrichedSystemIR[];
  contexts: EnrichedBoundedContextIR[];
  rootValueObjects: EnrichedValueObjectIR[];
  /** Always populated post-enrichment. */
  traceability: TraceabilityIR;
};

export type EnrichedAggregateIR = AggregateIR & {
  /** Always populated by `enrichLoomModel` (empty when none derived). */
  associations: AssociationIR[];
  /** Always populated by `enrichLoomModel` (empty when the aggregate has
   * no client-suppliable create fields). */
  createInput: CreateInputFieldIR[];
  parts: EnrichedEntityPartIR[];
};

// Parts / value objects carry no enrich-time derivation of their own (the
// canonical wire shape is recomputed on demand via `wireFieldsForPart` /
// `wireFieldsForValueObject`), so the enriched brand is their base type — kept
// as a named alias so consumers keep expressing "post-enrichment" intent.
export type EnrichedEntityPartIR = EntityPartIR;

export type EnrichedValueObjectIR = ValueObjectIR;

/** A channel-routed event subscription — the enrich-time join of a workflow
 *  consumer (`on(e: Event)` reactor or event-triggered `create(e: Event) by`)
 *  against the channels that `carries:` that event (channels.md; the
 *  in-process dispatch slice).  Computed per context by `enrichContext`; the
 *  Hono backend reads it to wire the in-process `DomainEventDispatcher` to the
 *  reactor/starter handlers.  Only events a channel in this context carries
 *  appear — the "channel-routed" rule.  Empty for channel-less contexts, so
 *  their generated output stays byte-identical (Noop dispatcher). */
export interface EventSubscriptionIR {
  /** The carried event type the consumer subscribes to. */
  event: string;
  /** The channel (in this context) that carries `event` and routes it.  When
   *  more than one carries it, the first by declaration order — disambiguation
   *  is a deferred validation rule (`reactor-channel-ambiguous`). */
  channel: string;
  /** Owning workflow name. */
  workflow: string;
  /** `"on"` reactor or event-triggered `"create"` starter. */
  trigger: "on" | "create";
  /** The event-instance binding name in the handler body (`paid` in
   *  `on(paid: E)` / `create(paid: E) by …`). */
  param: string;
  /** For `trigger: "create"`, the create's declared name (null for the
   *  canonical unnamed create).  Undefined for `on` reactors. */
  createName?: string | null;
  /** Set when the consumer is a projection fold (projection.md) rather than a
   *  workflow saga — carries the projection name (also mirrored into
   *  `workflow`).  The dispatcher branches on this to emit an upsert fold
   *  (load-or-allocate on every event) instead of a saga's create/route split.
   *  Undefined for workflow subscriptions (they stay byte-identical). */
  projection?: string;
}

export type EnrichedBoundedContextIR = Omit<BoundedContextIR, "aggregates" | "valueObjects"> & {
  aggregates: EnrichedAggregateIR[];
  valueObjects: EnrichedValueObjectIR[];
  /** Channel-routed event subscriptions in this context (in-process dispatch
   *  slice).  Derived by `enrichContext`; empty when the context declares no
   *  channel that carries a subscribed event. */
  eventSubscriptions: EventSubscriptionIR[];
};

export type EnrichedSubdomainIR = Omit<SubdomainIR, "contexts"> & {
  contexts: EnrichedBoundedContextIR[];
};

export type EnrichedSystemIR = Omit<SystemIR, "subdomains"> & {
  subdomains: EnrichedSubdomainIR[];
  /** Derived logical needs, one per `(context, required kind)` — the
   *  implicit "need" layer (RFC §3.3).  Populated by `enrichLoomModel`. */
  needs: NeedIR[];
  /** Resolved default access interface per resource name (RFC §3.5),
   *  derived from the resource's sourceType + kind.  A consuming
   *  operation may override it once the consumption surface exists
   *  (Phase 4); until then this is the per-resource default. */
  resourceInterfaces: Record<string, LoomInterface>;
  /** App-wide resolved HTTP status for each structural-conflict built-in —
   *  see `BoundedContextIR.structuralErrorStatuses`. Threaded to the app-global
   *  exception handlers (.NET `DomainExceptionFilter`, Python handlers, Java
   *  `ApiExceptionAdvice`, Elixir `ProblemDetails`) which have no per-context
   *  tag. Folded across every api, each defaulting to 409. */
  structuralErrorStatuses: Record<string, number>;
};

// ---------------------------------------------------------------------------
// Traceability
// ---------------------------------------------------------------------------

export type RequirementType = "UserStory" | "UseCase" | "AcceptanceCriteria" | "BusinessReq";

export type RequirementStatus = "Draft" | "Approved" | "InProgress" | "Done";

export interface RequirementIR {
  id: string;
  type: RequirementType;
  title: string;
  status?: RequirementStatus;
  priority?: number;
  /** Parent requirement id (hierarchy), or undefined for a root. */
  parentId?: string;
}

/** The kind of code symbol a CodeRefIR points at — read off the
 *  resolved AST node's type at lowering time so backends never
 *  re-resolve. */
export type CodeRefKind =
  | "subdomain"
  | "context"
  | "aggregate"
  | "operation"
  | "valueobject"
  | "event"
  | "repository"
  | "workflow"
  | "view"
  | "deployable"
  | "api";

/** A resolved, qualified reference from a Solution/TestCase into the
 *  domain model (`Identity.Auth.LoginSession.start`). */
export interface CodeRefIR {
  qualifiedName: string;
  kind: CodeRefKind;
}

export interface SolutionIR {
  id: string;
  /** Requirement this solution justifies (`for <req>`). */
  forRequirement: string;
  title: string;
  /** Code symbols this solution legitimises (`entitles [...]`). */
  entitles: CodeRefIR[];
}

export interface TestCaseIR {
  id: string;
  /** Requirement this test case verifies (`verifies <req>`). */
  verifies: string;
  title: string;
  /** Code symbols this test case exercises (`covers [...]`). */
  covers: CodeRefIR[];
}

/** Derived traceability / coverage index built by `enrichLoomModel`
 *  in one pure pass.  Every report generator reads these precomputed
 *  views rather than recomputing — the same contract `wireShape` has. */
export interface TraceabilityIR {
  /** Requirement id → its direct child requirement ids. */
  childrenOf: Record<string, string[]>;
  /** Requirement id → TestCase ids that verify it directly OR verify
   *  one of its (transitive) descendants. */
  testsByRequirement: Record<string, string[]>;
  /** Requirement id → Solution id justifying it, or null if none. */
  solutionByRequirement: Record<string, string | null>;
  /** Every targetable code symbol referenced anywhere, keyed by
   *  qualified name (union of all entitles + covers). */
  codeElements: Record<string, CodeRefKind>;
  /** Code qualified name → TestCase ids that `cover` it. */
  testsByCodeElement: Record<string, string[]>;
  /** Code qualified name → ids of executable tests (TestIR /
   *  TestE2EIR names) whose `verifies` testCase covers it. */
  execTestsByCodeElement: Record<string, string[]>;
  /** TestCase id → executable-test names backing it (via the test's
   *  `verifies` back-link). */
  execTestsByTestCase: Record<string, string[]>;
  /** Flat provenance list of every executable test, carrying the
   *  `suite` + `kind` that identify it in a runner's results.  The
   *  verification rollup joins results to testCases through this
   *  (names alone are unique only within an aggregate). */
  execTests: ExecTestRef[];
}

/** One executable test located for the verification join.  `suite`
 *  matches the runner's reported suite EXACTLY: the aggregate name for
 *  a unit test (`describe("<Aggregate>")`) and `"<System> e2e"` for an
 *  api/ui e2e test (`describe("<System> e2e")`). */
export interface ExecTestRef {
  name: string;
  suite: string;
  kind: "unit" | "api" | "ui";
  /** TestCase id from the test's `verifies` clause, or null. */
  testCaseId: string | null;
}

// ---------------------------------------------------------------------------
// Verification (Definition of Done) — the runtime overlay on the
// traceability graph.  Given test-execution results, `computeVerification`
// (`src/verify/verification.ts`) rolls each testCase up to a status and
// each requirement up to a verdict.  Pure: it reads the precomputed
// `TraceabilityIR` index + a normalized result list, nothing else.
// ---------------------------------------------------------------------------

/** One executed test, normalized from any runner (the playground
 *  harness's `TestResult`, a vitest/xUnit/Playwright JSON report, …). */
export interface TestOutcome {
  /** Display name — the DSL `test`/`test e2e` string, emitted verbatim
   *  as `it("…")` / `[Fact(DisplayName="…")]` / `test("…")`. */
  name: string;
  status: "pass" | "fail" | "skip";
  /** Optional disambiguators when a `name` is not unique model-wide
   *  (unit-test names are unique only within an aggregate). */
  suite?: string;
  kind?: string;
}

export type TestCaseStatus = "VERIFIED" | "FAILING" | "UNVERIFIED";

export type RequirementVerdict = "VERIFIED" | "FAILING" | "UNTESTED" | "UNVERIFIED";

export interface VerificationIR {
  version: 1;
  testCases: Record<
    string,
    { status: TestCaseStatus; backing: { name: string; status: string }[] }
  >;
  requirements: Record<
    string,
    {
      verdict: RequirementVerdict;
      testCaseIds: string[];
      failingTestCaseIds: string[];
    }
  >;
  summary: {
    verified: number;
    failing: number;
    untested: number;
    unverified: number;
    total: number;
  };
  diagnostics: {
    /** Result rows that matched no backing executable test. */
    unknownTests: TestOutcome[];
    /** TestCase ids referenced by a test's `verifies` that don't exist. */
    unmappedTestCases: string[];
  };
}

/** A deployment plan: subdomains grouping bounded contexts, plus the
 * deployable artefacts that ship subsets of those contexts. */
export interface SystemIR {
  name: string;
  subdomains: SubdomainIR[];
  deployables: DeployableIR[];
  e2eTests: TestE2EIR[];
  /** Optional system-wide user-claim shape.  Populated when the source
   *  declares a `user { ... }` block at system scope.  Required when
   *  any deployable has `auth: { required: true }` (validator
   *  enforces).  The fields are the typed claims that backends decode
   *  JWT tokens into; `currentUser` references in expression bodies
   *  resolve members against this shape. */
  user?: UserIR;
  /** Optional system-wide OIDC auth config.  Populated when the source
   *  declares an `auth { ... }` block at system scope.  Requires a
   *  `user { ... }` block (validator enforces).  Drives the generated
   *  OIDC verifier + `/auth/*` handshake on opted-in deployables. */
  auth?: AuthIR;
  /** Optional system-wide tenancy declaration (multi-tenancy Phase 1a).
   *  Populated when the source declares `tenancy by user.<claim> of
   *  <Registry>` at system scope.  At most one per system (validator
   *  enforces).  Claim-exists / registry-exists / stance checks are the
   *  phase-④/⑦ tenancy validators' job — this carries the declared
   *  facts only. */
  tenancy?: TenancyIR;
  /** Optional system-wide visual-identity tokens.  Populated when the
   *  source declares a `theme { ... }` block at system scope.  Each
   *  React deployable consumes the same ThemeIR; the platform's
   *  emitter translates the framework-agnostic tokens into Mantine /
   *  shadcn / etc. theming knobs. */
  theme?: ThemeIR;
  /** UI declarations at system scope.  Each is referenced by
   *  zero-or-more deployables via `DeployableIR.uiName`.  Empty when
   *  the system declares no `ui { ... }` blocks.  Order preserves
   *  source order (matters for stable scaffold expansion). */
  uis: UiIR[];
  /** API declarations at system scope.  Each is a contract derived
   *  from a module's domain — its aggregates, repositories,
   *  workflows, views become the api's exposed operations.  UIs
   *  reference apis via their `api X: ApiName` parameters; backend
   *  deployables `serves:` a named api; frontend deployables
   *  `consumes:` an api from a named target. */
  apis: ApiIR[];
  /** Storage declarations at system scope.  Each is a physical
   *  infrastructure instance referenced from a `dataSource` binding.
   *  Reusable across deployables. */
  storages: StorageIR[];
  /** DataSource declarations at system scope.  Each binds a
   *  `(BoundedContext, DataSourceKind)` pair to a physical storage,
   *  optionally with per-kind config (`schema:` / `every:` / `ttl:` /
   *  …).  Deployables list which dataSources they host via the
   *  `dataSources:` clause. */
  dataSources: DataSourceIR[];
  /** ChannelSource declarations at system scope (channels.md, Slice 1) —
   *  the physical binding of a `channel` to a `storage`, the messaging twin
   *  of `dataSource`.  Deployables will list which they wire in a later
   *  slice; Slice 1 carries the bindings and emits `.loom/asyncapi.yaml`. */
  channelSources: ChannelSourceIR[];
  /** TimerSource declarations at system scope (scheduling.md, M-T4.1) — a
   *  wall-clock cadence that fires a plain domain `event`, which workflows
   *  react to via the existing `on`/`create … by` triggers.  Time modelled as
   *  an event source, not a new trigger.  The emit owner is DERIVED (not stored
   *  here): the backend deployable whose `migrationsOwner` owns the for-event's
   *  context emits the scheduler, so single-fire lock and DB owner coincide. */
  timerSources: TimerSourceIR[];
  /** Named `layout <Name> { … }` SystemMembers (Phase 8).  Pages
   *  reference one via `layout: <Name>` — the React generator emits
   *  one `<Name>Layout` wrapper component per entry and routes
   *  matching pages through it. */
  layouts: LayoutIR[];
}

/** Physical binding of a `channel` to a `storage` (channels.md, Slice 1).
 *  System-scope, mirroring `DataSourceIR`.  `channelName` is the bare
 *  channel name; `storageName` the bound storage instance. */
export interface ChannelSourceIR {
  name: string;
  channelName: string;
  storageName: string;
}

/** A wall-clock cadence bound to a domain event (scheduling.md, M-T4.1).
 *  System-scope, the clock twin of `ChannelSourceIR`.  `event` is the resolved
 *  name of the plain `EventDecl` the timer fires; `context` is the bounded
 *  context that declares it (used to derive the emit/lock owner from the
 *  subdomain's `migrationsOwner`).  `cadence` is discriminated by which of the
 *  grammar's `cron:` / `every:` fields was set.  `timezone` / `overlap` parse in
 *  Phase 1 but are inert (Phase 2). */
export interface TimerSourceIR {
  name: string;
  event: string;
  context: string;
  cadence: TimerCadenceIR;
  /** `in: "<tz>"` — inert in Phase 1, carried for Phase 2 timezone support. */
  timezone?: string;
  /** `overlap: allow` — inert in Phase 1 (default is skip-on-overlap). */
  overlap?: boolean;
}

/** Timer cadence, discriminated by the grammar field that set it.  `cron` is a
 *  real 5-field expression (or an `@nickname`) passed through to the backend's
 *  native scheduler; `everyMs` is a fixed interval in milliseconds, used only
 *  for cadences cron cannot express (sub-minute / non-dividing). */
export type TimerCadenceIR = { kind: "cron"; cron: string } | { kind: "every"; everyMs: number };

/** A single typed storage instance.  v0 type enum covers the
 *  common roles seen in real deployments — postgres / mysql /
 *  sqlite / inMemory for transactional, redis for cache, elastic
 *  / meilisearch for search, kafka for events, clickhouse /
 *  bigquery for analytics. */
export interface StorageIR {
  name: string;
  type: StorageKind;
  /** Compose-service handle the deployable shares with the storage,
   *  used as the host name in generated connection strings.  Optional
   *  in v1; when omitted the system orchestrator derives a default. */
  instance?: string;
  /** Source of the runtime connection string — `service(name)` for
   *  intra-compose discovery, `env("VAR")` for environment lookup,
   *  `secret(handle)` for a future secrets-manager binding, or
   *  `literal("…")` for a hard-coded URL.  Optional in v1. */
  connection?: ConnectionSourceIR;
  /** Generic vendor-parameter map (region, bucket, vhost, …), validated
   *  per sourceType against the registry config schema. */
  config?: readonly ConfigEntryIR[];
}

export type ConnectionSourceIR =
  | { kind: "service"; service: string }
  | { kind: "env"; env: string }
  | { kind: "secret"; secret: string }
  | { kind: "literal"; literal: string };

/** A single generic `config` entry value (RFC §3.1/§8) — a typed scalar
 *  so the registry's per-sourceType config schema can validate it. */
export type ConfigValueIR =
  | { kind: "string"; value: string }
  | { kind: "int"; value: number }
  | { kind: "bool"; value: boolean };

/** One `key: value` pair from a `config { … }` map, in declaration order. */
export interface ConfigEntryIR {
  key: string;
  value: ConfigValueIR;
}

export type StorageKind =
  | "postgres"
  | "mysql"
  | "sqlite"
  | "inMemory"
  | "redis"
  | "elastic"
  | "meilisearch"
  | "kafka"
  | "clickhouse"
  | "bigquery"
  | "s3"
  | "localDisk"
  | "rabbitmq"
  | "restApi"
  | "smtp"
  | "ses"
  | "sendgrid";

/** System-level `theme { ... }` block.  Tokens are semantic so the
 *  same source applies to whatever target the React generator
 *  picks (Mantine today; shadcn/ui or others tomorrow).  All
 *  fields optional — a `theme {}` block is allowed but produces
 *  the platform's defaults.  Color values are validated to be
 *  CSS hex strings (#RGB / #RRGGBB / #RRGGBBAA); radius is one
 *  of the five named scale steps. */
export interface ThemeIR {
  /** Brand color — e.g. "#3b82f6".  Mantine emitter generates a
   *  10-shade ramp from this hex and registers it as the project's
   *  `primaryColor`. */
  primary?: string;
  /** Secondary brand colour — used by packs that ship a second
   *  named accent (e.g. CSS `--color-secondary`).  Optional. */
  secondary?: string;
  /** Accent colour — third accent slot (e.g. highlight chips,
   *  callouts).  Optional. */
  accent?: string;
  /** Success semantic colour (positive feedback / confirmations). */
  success?: string;
  /** Warning semantic colour (cautions, non-blocking notices). */
  warning?: string;
  /** Error semantic colour (destructive actions, validation errors). */
  error?: string;
  /** Neutral / gray palette source.  Mantine emitter sets
   *  `colors.gray` to a 10-shade ramp from this hex, which Mantine
   *  uses for muted text, borders, dimmed backgrounds, etc. */
  neutral?: string;
  /** Border-radius scale step.  One of the five named values. */
  radius?: "none" | "sm" | "md" | "lg" | "xl";
  /** Body / control font stack.  Passed through verbatim — caller
   *  is responsible for ensuring the named fonts are available
   *  (web font import, system fallback chain). */
  fontFamily?: string;
  /** Monospace font stack — used for code blocks, ID displays,
   *  and other tabular content.  Same pass-through semantics as
   *  `fontFamily`. */
  fontFamilyMono?: string;
  /** Initial colour scheme — `"light"`, `"dark"`, or `"auto"`
   *  (follow system preference).  Packs that support theme
   *  toggling read this as the boot-time default. */
  colorScheme?: "light" | "dark" | "auto";
}

/** System-level `user { ... }` block.  Each field carries an
 *  ordinary TypeIR — primitives, `X id`, enums, value-objects,
 *  optional `T?` — and contributes to the emitted User type plus
 *  the `currentUser` magic identifier's member-access surface. */
export interface UserIR {
  fields: FieldIR[];
}

/** A resolved auth config value — an inline literal or a runtime
 *  `env(VAR)` reference (the deployment supplies the value; it never
 *  bakes into generated source). */
export type AuthValueIR = { kind: "literal"; value: string } | { kind: "env"; env: string };

/** One IdP-claim → `user { ... }`-field mapping. */
export interface ClaimMappingIR {
  /** Target field on the `user { ... }` shape. */
  field: string;
  /** Dotted IdP claim path, e.g. `realm_access.roles`. */
  path: string;
}

/** Fully-resolved OIDC endpoint config.  Provider presets
 *  (`keycloak` / `google` / …) are resolved into this record during
 *  lowering so backends never special-case provider names — they
 *  always consume concrete endpoints. */
export interface OidcConfigIR {
  issuer?: AuthValueIR;
  clientId?: AuthValueIR;
  clientSecret?: AuthValueIR;
  audience?: AuthValueIR;
  scopes: string[];
}

/** System-level OIDC authentication config (D-AUTH-OIDC).  Populated
 *  when the source declares an `auth { ... }` block; requires a
 *  `user { ... }` block (validator enforces).  Drives the generated
 *  token verifier (filling the existing per-backend verifier seam) and
 *  the `/auth/*` redirect handshake — Loom owns no auth runtime. */
export interface AuthIR {
  /** Provider preset name as written in source (`keycloak` / `custom`
   *  / `google` / …).  `undefined` when only a raw `oidc { ... }` block
   *  was given.  Already resolved into `oidc`; retained for emission
   *  hints (e.g. the bundled dev Keycloak). */
  provider?: string;
  /** Resolved endpoints (preset ⊕ explicit `oidc { ... }` overrides). */
  oidc: OidcConfigIR;
  /** How the app holds the post-login session. */
  sessions: "cookie" | "jwt";
  /** IdP-claim → user-field projections. */
  claims: ClaimMappingIR[];
  /** Default-deny posture.  `opt` (default) preserves today's
   *  per-`requires` opt-in; `denyByDefault` forces every reachable
   *  command on an `auth: required` deployable to declare a gate. */
  enforcement: "denyByDefault" | "opt";
}

/** System-level tenancy declaration (multi-tenancy Phase 1a —
 *  docs/old/plans/multi-tenancy-implementation.md).  Lowered from
 *  `tenancy by user.<claimField> of <registryName>`: `claimField` names
 *  the `user { … }` claim that partitions the data; `registryName` the
 *  aggregate acting as the tenant registry.  Both are plain names here,
 *  read off real cross-references at lowering (1b.1) — existence is the
 *  linker's job, singularity the tenancy validators' (slice 1a.3), and
 *  an aggregate's tenancy *stance* is derived on demand from
 *  `crossTenant` + capabilities (derive-don't-stamp), never stored on
 *  the IR. */
export interface TenancyIR {
  claimField: string;
  registryName: string;
}

/** End-to-end test that targets a running deployable. */
export interface TestE2EIR {
  name: string;
  /** "api" — typed-fetch HTTP test (default).  "ui" — Playwright
   * test driven through the auto-generated page objects in the
   * target react deployable's `e2e/pages/`. */
  kind: "api" | "ui";
  deployableName: string;
  statements: TestStmtIR[];
  /** Traceability back-link — see `TestIR.verifiesTestCase`. */
  verifiesTestCase?: string;
}

// ---------------------------------------------------------------------------
// Page metamodel
//
// Mirrors the grammar's `Ui` / `Page` / `Component` / `Scaffold` /
// `MenuBlock` productions — every IR node here is a one-to-one lowering
// of those ASTs.  Scaffolds are NOT expanded at this layer — they
// stay as literal `ScaffoldIR` directives until the scaffold expander
// runs.
//
// Designed so a future LiveView / Blazor backend can consume the same
// IR — mutations (`:=`), navigations, and component invocations are
// platform-neutral here; their lowering into framework-specific code
// is the per-target generator's concern.
// ---------------------------------------------------------------------------

/** A `ui` SystemMember: pages, components, and an optional sidebar
 *  menu block.  Scaffold synthesis happens at the AST level via
 *  the `scaffold` stdlib macro; by the time we lower to IR, every
 *  page is a first-class PageIR with no special-cased provenance. */
export interface UiIR {
  name: string;
  /** D-PHOENIX-SURFACE: the framework this UI renders against, declared
   *  on the `ui { framework: … }` block itself rather than derived from
   *  the hosting deployable's platform.  `undefined` when the source
   *  omits it (the legacy path: the deployable's `uiFramework` still
   *  derives from its platform).  Values are `Framework` grammar
   *  strings (`react` | `phoenixLiveView`). */
  framework?: string;
  pages: PageIR[];
  components: ComponentIR[];
  /** Shared client-side state containers — `store Cart { … }`
   *  (named-actions-and-stores.md §3, Stage 5).  Referenced by dotted name
   *  from page/component bodies; each consumer's dependency is DERIVED from
   *  its resolved `store-field` refs + `store-action` calls.  Empty when the
   *  ui declares none. */
  stores: StoreIR[];
  /** Optional ui-level menu block.  When undefined the sidebar is
   *  derived from each page's `menuMeta` (see spec §11). */
  menu?: MenuBlockIR;
  /** UI api parameters.  Each entry maps a local handle name (used in
   *  page bodies as `<handle>.<aggregate>.<op>`) to an api the system
   *  declares.  Composition is supplied by the deployable that
   *  deploys this UI. */
  apiParams: UiApiParamIR[];
  /** Channel subscriptions (`channel Orders: Sales.Lifecycle`) — each
   *  binds a local handle to a context's broadcast channel (channels.md
   *  Part I, ui surface).  Omitted when the ui declares none. */
  channelParams?: UiChannelParamIR[];
  /** Live-event handlers (`on Orders.OrderShipped(e) { toast(…) }`).
   *  Omitted when the ui declares none. */
  notifications?: UiNotificationIR[];
  /** Extern frontend functions (`function f(…): T extern from "…"`) —
   *  the logic escape hatch (extern-function-hook-escape-hatch.md §3).
   *  Omitted when the ui declares none. */
  functions?: UiFunctionIR[];
}

/** `function <name>(params): T extern from "<path>"` — a typed pure
 *  function implemented by a hand-written module.  The React generator
 *  emits a typed signature + a conformance shim (`tsc` is the
 *  fail-fast); page bodies call it through the shim. */
export interface UiFunctionIR {
  name: string;
  params: ParamIR[];
  returnType: TypeIR;
  externPath: string;
}

/** `channel <name>: <Ctx>.<Channel>` — a UI's subscription to a
 *  broadcast channel.  The wire format (SSE/WebSocket) is derived from
 *  the frontend's platform, never stated here. */
export interface UiChannelParamIR {
  name: string;
  contextName: string;
  channelName: string;
}

/** A `refetch(<Aggregate>)` action inside an `on` handler body — the
 *  realtime analogue of a mutation's `onSuccess` cache invalidation.
 *  Fully resolved: `queryTag` is the exact `["<tag>"]` query key the
 *  frontend api modules register (`snake(plural(aggregate))`), so a
 *  realtime invalidation and a mutation-success invalidation hit the
 *  same cache entries.  Backends never re-derive the tag. */
export interface RefetchTargetIR {
  /** The aggregate whose queries are invalidated (resolved to a real
   *  aggregate in the enclosing system by the validator). */
  aggregate: string;
  /** The query-key tag — `snake(plural(aggregate))`.  Frontends emit
   *  `qc.invalidateQueries({ queryKey: ["<queryTag>"] })`, prefix-matching
   *  the aggregate's list / detail / find queries. */
  queryTag: string;
}

/** `on <param>.<Event>(e) { toast(…)  refetch(Agg) }` — render a carried
 *  event as it arrives on the realtime wire.  A handler body admits two
 *  actions: `toast(<expr>)` (a message notification) and
 *  `refetch(<Aggregate>[, …])` (invalidate that aggregate's query cache);
 *  the validator (`loom.ui-handler-unsupported`) rejects anything else.
 *  Each lowers with `bind` in scope as the event payload. */
export interface UiNotificationIR {
  /** The channel-param handle the handler subscribes through. */
  paramName: string;
  /** The carried event's type tag on the wire (`event.type`). */
  eventType: string;
  /** Handler binding name (`e` in `on Orders.OrderShipped(e)`). */
  bind: string;
  /** One toast message expression per `toast(<expr>)` handler statement. */
  toasts: ExprIR[];
  /** One entry per aggregate named across the handler's `refetch(…)`
   *  statements.  Omitted when the handler declares no refetch. */
  refetches?: RefetchTargetIR[];
}

/** API declaration — first-class contract derived from a module's
 *  domain.  Auto-derives the full surface (aggregate CRUD +
 *  repository finds + workflows + views).  Future: customization
 *  (hide, rename, expose subset, version). */
export interface ApiIR {
  name: string;
  /** Source module the api derives its surface from. */
  sourceModule: string;
  /** URL slug style for lifecycle actions surfaced by this api.
   *  `"literal"` (default) emits the action name verbatim; `"resource"`
   *  pluralises it.  Drives `OperationIR.routeSlug` derivation in
   *  enrichment (D-URLSTYLE / lifecycle-operations.md Phase 2). */
  urlStyle: "literal" | "resource";
  /** Per-error HTTP status overrides declared via `httpStatus <Error> -> <Code>`
   *  in the api block (exception-less.md A1).  Keyed by error-payload name; an
   *  error absent here falls back to the stdlib default
   *  (`src/util/error-defaults.ts`).  Empty when the api declares none. */
  errorStatuses: Record<string, number>;
  /** Explicit transport bindings declared via `route <METHOD> <PATH> ->
   *  <Context>.<Handler>` in the api block (unfoldable-api-derivation.md,
   *  Layer 4).  Ride alongside the api; unread by backends in this slice.
   *  Empty when the api declares none. */
  routes: RouteIR[];
}

/** A single explicit `route <METHOD> <PATH> -> <Context>.<Handler>` transport
 *  binding (unfoldable-api-derivation.md, Layer 4).  `target.handler` is a plain
 *  name resolved by the IR validator (`loom.route-handler-unresolved`) against
 *  the commandHandler / queryHandler / workflow-handle members of
 *  `target.context`. */
export interface RouteIR {
  /** HTTP method — `GET` | `POST` | `PUT` | `PATCH` | `DELETE`. */
  method: string;
  /** URL path template, delimiters stripped (`/orders/{id}`). */
  path: string;
  /** The `Context.Handler` target. */
  target: { context: string; handler: string };
}

/** UI api parameter — local handle + which api it expects. */
export interface UiApiParamIR {
  /** Local name used in page bodies (e.g. `Sales` in `Sales.Customer.all`). */
  name: string;
  /** Name of the system-scope `Api` this parameter expects. */
  apiName: string;
}

/** Per-page layout selector.  Three discriminator variants:
 *  - `{ kind: "preset", name: "default" }` — wrapped by the
 *    deployable's AppShell chrome (the v1 default behaviour).
 *  - `{ kind: "preset", name: "none" }` — mounted at the top of the
 *    router with no chrome at all (v1 escape hatch).
 *  - `{ kind: "named", ref: string }` — wrapped by a named `layout`
 *    SystemMember declared in the same system (Phase 8).  The
 *    React generator emits one `<X>Layout` component per declared
 *    `LayoutIR` and routes pages through the matching layout-route. */
export type PageLayoutIR =
  | { kind: "preset"; name: "default" | "none" }
  | { kind: "named"; ref: string };

/** A named `layout <Name> { … }` SystemMember (Phase 8).  Each slot's
 *  body is a single page-body-shaped `ExprIR` evaluated against the
 *  same walker-stdlib + user-component scope as a page body.  The
 *  `main` slot is implicit — it's the React Router `<Outlet />`
 *  position; every layout has exactly one `main` (validator enforces). */
export interface LayoutIR {
  name: string;
  header?: ExprIR;
  sidebar?: ExprIR;
  footer?: ExprIR;
}

/** A page declaration: route + parameters + reactive state + body. */
export interface PageIR {
  name: string;
  params: ParamIR[];
  /** Path-with-`:params` from `route: "..."`.  Always set for pages
   *  written in source; scaffold-synthesised pages set it directly in
   *  the `with scaffold(...)` macro. */
  route?: string;
  /** Optional title expression.  May interpolate state / data refs. */
  title?: ExprIR;
  /** Auth gate, same syntax as on operations. */
  requires?: ExprIR;
  /** Reactive local fields.  Multiple `state { }` blocks merge here
   *  (matches the `permissions` block multiplicity rule). */
  state: StateFieldIR[];
  /** Read-only computed values in the render scope — `derived total: T =
   *  expr`.  Reactive over `state` (recompute on change); sequential (a
   *  derived may reference params, state, and *earlier* derived).  Each
   *  frontend hoists these before the body (React `useMemo`, Vue
   *  `computed`, Svelte `$derived`, HEEx inline-recompute). */
  derived: DerivedIR[];
  /** Named, typed event handlers — `action next() { … }` (Proposal A
   *  Stage 1).  Each frontend hoists one named handler function per action
   *  before the body; a bare `onSubmit: <name>` reference binds it instead
   *  of an inline arrow. */
  actions: ActionIR[];
  /** Single body expression.  Conditional rendering uses `match` in
   *  the expression engine, not a guarded-declaration form. */
  body?: ExprIR;
  /** Per-page menu metadata.  Read by the menu emitter when
   *  no explicit ui-level menu block is declared. */
  menuMeta?: MenuMetaIR;
  /** Explicit emit path override for walker-rendered
   *  pages.  When set, the page-emitter writes the rendered TSX to
   *  this path instead of the default `src/pages/<page-snake>.tsx`.
   *  Populated during lowering so a scaffold-emitted page lands at
   *  its conventional path (`src/pages/<plural>/list.tsx` for an
   *  aggregate's list page, etc.) — preserves URL/file shape. */
  emitPath?: string;
  /** Containing-area path (outermost → innermost), when the page is
   *  declared inside one or more `area { … }` blocks.  Drives `emitPath`
   *  (`src/pages/<area-path>/<page>.tsx`); empty/absent for a top-level
   *  page.  Each segment is the snake-cased area name. */
  area?: string[];
  /** Optional layout selector.  When undefined, the page receives
   *  the deployable's default app-shell chrome.  See `PageLayoutIR`
   *  for the preset value set; undefined is intentionally distinct
   *  from `{ kind: "preset", name: "default" }` to preserve the
   *  v2-named-layout-inheritance posture (a ui-level layout supplies
   *  the default when the page doesn't declare one). */
  layout?: PageLayoutIR;
  /** Optional static page metadata projected into the generated
   *  `index.html` shell — `<meta name="description">`,
   *  `<meta property="og:image">`, and `<link rel="canonical">`.
   *  All three are plain string literals (no state / param
   *  interpolation), so we carry them verbatim rather than as
   *  `ExprIR`.  Only the route-`/` page (or the first page when
   *  no `/` exists) contributes metadata to the shell. */
  metadata?: PageMetadataIR;
  /** Provenance chain back to the `.ddd` source — see
   * src/ir/types/origin.ts.  Populated at lowering; absent on purely
   * derived nodes. */
  origin?: OriginRef;
}

/** Static page metadata — SEO + social-graph tags written into
 *  the generated `index.html`.  All fields optional; absent fields
 *  produce no markup. */
export interface PageMetadataIR {
  description?: string;
  ogImage?: string;
  canonical?: string;
}

/** Provenance for a page's body shape.  Scaffold-emitted pages carry
 *  a non-`custom` origin so downstream generators (pages-emitter,
 *  menu-emitter, page-objects-emit) can pick the right emit path,
 *  nav-link metadata, and Playwright page-object class without
 *  re-introspecting the body.  User-written explicit pages get
 *  `{ kind: "custom" }` — they emit at `src/pages/<page-snake>.tsx`
 *  and contribute no auto-nav entry. */
/** A user-defined component: typed function from params (and optional
 *  local state) to a body expression.  Components compose other
 *  components but never produce pages or routes. */
export interface ComponentIR {
  name: string;
  params: ParamIR[];
  state: StateFieldIR[];
  /** Read-only computed values in the render scope — the component twin of
   *  `PageIR.derived` (same `derived total: T = expr` surface, same
   *  reactive/sequential semantics).  Absent (empty) on an `extern`
   *  component. */
  derived: DerivedIR[];
  /** Named, typed event handlers — the component twin of `PageIR.actions`
   *  (Proposal A Stage 1).  Absent (empty) on an `extern` component. */
  actions: ActionIR[];
  /** Walked region tree.  Absent for an `extern` component, whose
   *  rendering is owned by a hand-written file. */
  body?: ExprIR;
  /** True when the component is `extern` — the generator emits a
   *  typed `<Name>.props.ts` interface and imports the user's module
   *  at call sites instead of generating a body. */
  extern?: boolean;
  /** Module specifier for the hand-written component, relative to the
   *  generated project's `src/` root (the `from "<path>"` clause).
   *  Always present when `extern` is true. */
  externPath?: string;
  /** Provenance chain back to the `.ddd` source — see
   * src/ir/types/origin.ts.  Populated at lowering; absent on purely
   * derived nodes.  Mirrors `PageIR.origin`; feeds the frontend
   * generators' `SourceMapRecorder.file(...)` calls for per-component
   * output regions (M8, source-map-debug-kickoff.md). */
  origin?: OriginRef;
}

/** One reactive local field, inside a `page` or `component`. */
export interface StateFieldIR {
  name: string;
  type: TypeIR;
  /** Optional initial value.  Undefined fields default to `null`
   *  for optional types and the type's zero value otherwise (per
   *  spec §6). */
  init?: ExprIR;
}

// `ScaffoldIR` / `ScaffoldSelector` were removed when `scaffold`
// migrated from a hardcoded language directive to the `scaffold`
// stdlib macro.  Page synthesis now goes through the macro
// expander → AST splice → standard page lowering path; no IR-
// level scaffold representation is required.

/** Per-page sidebar metadata.  Bare entries — validator
 *  enforces the allowed key names (`section` / `label` / `order` /
 *  `hidden`).  Same shape as `ThemeIR`'s entries: bare key + typed
 *  value, with the validator policing the surface. */
export interface MenuMetaIR {
  entries: { name: string; value: ExprIR }[];
}

/** A `menu { section "S" { link Page, link "L" -> "url" } }` block. */
export interface MenuBlockIR {
  sections: MenuSectionIR[];
}

export interface MenuSectionIR {
  label: string;
  links: MenuLinkIR[];
}

export type MenuLinkIR =
  | {
      kind: "page";
      pageName: string;
      /** The linked page's route, captured from the resolved cross-reference.
       *  Role-named scaffold pages share a `pageName` (`List`) across
       *  aggregates, so the menu emitter keys on this unique route to find the
       *  exact target page (e.g. `link Orders.List` → `/orders`).  Undefined
       *  only when the reference didn't resolve. */
      route?: string;
      /** Override props (`label`, `order`).  Validator checks the
       *  allowed key names. */
      props: { name: string; value: ExprIR }[];
    }
  | {
      kind: "external";
      label: string;
      url: string;
    };

// ---------------------------------------------------------------------------

export interface SubdomainIR {
  name: string;
  contexts: BoundedContextIR[];
  /** Permission catalogue declared via per-subdomain `permissions { ... }`
   *  blocks.  Empty when the subdomain declares none.  Each entry's
   *  `runtimeString` is the value backends compare against
   *  `currentUser.permissions[]` claims; the source-side identifier
   *  (`name`) is what `permissions.<name>` references resolve to in
   *  expression bodies. */
  permissions: PermissionDeclIR[];
  /** Name of the deployable that owns migrations for this subdomain's
   *  primary persistent storage.  Populated by `enrichLoomModel` — the
   *  first backend deployable (in declaration order) that hosts any
   *  context from this subdomain and whose platform `needsDb`.
   *  Undefined when no deployable matches (frontend-only subdomains,
   *  etc.) — backends MUST emit migrations only when
   *  `subdomain.migrationsOwner === deployable.name`. */
  migrationsOwner?: string;
}

/** One permission declared in a subdomain's `permissions { }` block. */
export interface PermissionDeclIR {
  /** Source-side identifier used as `permissions.<name>` in
   *  expression bodies. */
  name: string;
  /** Runtime string emitted when a `permissions.<name>` reference
   *  lowers to a literal — `<lowercased-subdomain>.<name>`.  Stable
   *  across regens so claim payloads can be expressed in plain
   *  strings on the wire. */
  runtimeString: string;
}

/** D-STORAGE-SPLIT: a per-(context, kind) binding from a domain
 *  context to a physical `storage`.  Carries per-kind config
 *  validated against the resolved storage's `type`. */
export interface DataSourceIR {
  name: string;
  /** Name of the BoundedContext the binding applies to. */
  contextName: string;
  /** Which datalogue kind this binding satisfies for the context. */
  kind: DataSourceKind;
  /** Name of the physical `storage` declaration this binding routes to. */
  storageName: string;
  schema?: string;
  tablePrefix?: string;
  keyPrefix?: string;
  /** Cache TTL in seconds.  Validator requires storage type to be
   *  cache-capable (e.g. redis) when this is set. */
  ttl?: number;
  /** Snapshot policy: take a snapshot every N events. */
  every?: number;
  /** Snapshot policy: retain at most N snapshots per stream. */
  retain?: number;
  isolationLevel?: "readUncommitted" | "readCommitted" | "repeatableRead" | "serializable";
  readonly?: boolean;
  /** Saving shape of the materialised read model this binding routes
   *  (D-DOCUMENT-AXIS, `shape:` knob).  Per-projection override of the
   *  aggregate header's `shape(…)` (see {@link SavingShape} /
   *  {@link effectiveSavingShape}).  Omitted → the header decides. */
  shape?: SavingShape;
  /** Generic vendor-parameter map for the binding (RFC §3.2). */
  config?: readonly ConfigEntryIR[];
  /** Manual performance indexes declared via `index: [...]`
   *  (uniqueness-and-indexes.md §3.2, D-INDEX-INFRA).  Each entry names its
   *  target entity EXPLICITLY (an aggregate or one of its contained parts in
   *  the binding's context) plus the column(s) — one for a single-column
   *  index, several for a composite.  Always non-unique — uniqueness is the
   *  domain `unique (...)` invariant.  Omitted when none declared. */
  manualIndexes?: readonly ManualIndexIR[];
}

/** One `index: [...]` entry — an explicitly-targeted performance index on a
 *  storage binding (uniqueness-and-indexes.md §3.2).  `entity` is an aggregate
 *  or contained-part name in the binding's context; `columns` are its
 *  field names.  The migrations builder places the index on that entity's
 *  table, named `<table>_<cols>_idx`, non-unique. */
export interface ManualIndexIR {
  entity: string;
  columns: readonly string[];
}

export type DataSourceKind =
  | "state"
  | "eventLog"
  | "snapshot"
  | "cache"
  | "replica"
  | "objectStore"
  | "queue"
  | "api"
  | "mailer";

/** Access mode used to reach a source in a given context (RFC §3.5).
 *  Owned here (the IR vocabulary); the sourceType registry declares
 *  which interfaces each `(sourceType, kind)` exposes. */
export type LoomInterface = "sql" | "rest" | "graphql" | "webSocket" | "amqp" | "sdk";

/** A derived, implicit logical *need*: what a bounded context requires
 *  of its data layer, independent of the technology that satisfies it
 *  (RFC §3.3).  Needs are not authored — they are derived during
 *  enrichment from how the context's aggregates persist, and threaded
 *  onto `EnrichedSystemIR.needs`.  A `resource` binding satisfies a need
 *  when its `sourceType` supports the need's `kind` and offers all the
 *  need's `capabilities` (validated in IR; RFC §5). */
export interface NeedIR {
  /** The bounded context that has the need. */
  contextName: string;
  /** The required (surface) kind — the `(context, kind)` routing key. */
  kind: DataSourceKind;
  /** Capabilities the context requires within that kind. */
  capabilities: readonly string[];
}

// `static` is the page-metamodel's UI-only deployable kind: builds a
// Vite bundle and serves it via a small static-asset host (nginx in
// the v0 emitter).  Shares the `react` platform surface.
//
// `phoenixLiveView` is the fullstack Elixir / Phoenix LiveView
// platform: a single deployable serves a Phoenix API AND mounts
// a `ui:` whose pages render as LiveView modules against the
// `coreComponents` HEEx pack.  Unlike `react`/`static` it owns its own
// database (`needsDb: true`) and never declares `targets:` —
// validator enforces both.
// `java` is the Spring Boot / Spring Data JPA backend (backend-only,
// like `dotnet`; mounts an embedded React SPA when the deployable
// declares `ui:`).
//
// `python` is the FastAPI + SQLAlchemy 2 backend (backend-only, like
// `node`/`dotnet`).  (The `fastapi` platform alias was retired — `python`
// is the only spelling, mirroring the retired `hono`/`phoenix` aliases.)
//
// `svelte` is the second frontend-only platform: a Svelte 5 /
// SvelteKit static SPA rendered against a svelte-format design pack
// (`shadcnSvelte`/`flowbite`).  Same deployable contract as `react`:
// `targets:` a backend, inherits its contexts, owns no database.
//
// `vue` is the third frontend-only platform: a Vue 3 Vite SPA
// (vue-router, SFC pages) rendered against a vue-format design pack
// (`vuetify`/`shadcnVue`).  Same deployable contract as `react`.
export type Platform =
  | "dotnet"
  | "node"
  | "react"
  | "svelte"
  | "vue"
  | "angular"
  | "feliz"
  | "flutter"
  | "static"
  | "elixir"
  | "python"
  | "java";

// The `shape(…)` platform-axes lookup (`PLATFORM_SAVING_SHAPES`) lives in
// `src/util/platform-axes.ts` so the language validators may consume it
// without a backward `language → ir` value edge.  It type-depends on
// `Platform` / `SavingShape` here.

export interface DeployableIR {
  name: string;
  /** The platform **family** (`"node"`, `"dotnet"`, `"react"`, …) —
   *  the closed union every downstream consumer branches on.  A
   *  `family@version` pin in the source is normalised here to its
   *  family so `platform === "node"` etc. stay valid. */
  platform: Platform;
  /** The fully-qualified backend ref (`"node@v4"`) after lowering,
   *  mirroring `design?`.  Bareword `platform: node` resolves through
   *  `BUILTIN_PLATFORM_LATEST`; a pin (`platform: "node@v4"`) flows
   *  through as written.  For frontend platforms (`react`/`static`)
   *  this equals `platform` (they version via the design/stack axis,
   *  not here).  The system orchestrator's dispatch keys on `platform`
   *  while every family has exactly one registered version. */
  platformRef: string;
  /** Names of bounded contexts hosted by this deployable.  For react
   * frontends, inherited from the targeted backend deployable. */
  contextNames: string[];
  /** Names of dataSource declarations the deployable wires up.
   *  Empty for frontend-only deployables.  Validator enforces that
   *  every listed dataSource's `for:` is one of `contextNames`. */
  dataSourceNames: string[];
  /** Names of channelSource declarations the deployable wires up — the
   *  messaging twin of `dataSourceNames` (channels.md §"Surface — transport
   *  binding", M-T4.4 slice 1).  Listing a binding routes the channel's
   *  events over its broker for this deployable (producer and/or consumer
   *  side is derived from the hosted contexts).  Empty ⇒ the channel's
   *  events reach this deployable only via in-process dispatch. */
  channelSourceNames: string[];
  /** HTTP port the deployable's web server listens on. */
  port: number;
  /** Backend deployable this frontend talks to.  Set only when
   * platform === "react"; the frontend's API base URL is derived from
   * the target's port. */
  targetName?: string;
  /** Design-system template pack the React frontend generator renders
   *  pages against.  Built-ins: "mantine", "chakra", "mui", "shadcn",
   *  "coreComponents".  A string starting with "./" or "/" is a custom
   *  pack path resolved relative to the .ddd file (a directory
   *  containing pack.json).  Only meaningful when platform === "react"
   *  (or "static"/"dotnet" with a UI mount, or "phoenix");
   *  ignored otherwise.
   *
   *  After lowering this field is always fully qualified
   *  (`family@version`, e.g. `"mantine@v7"`) for built-in packs.  The
   *  bareword DSL form `design: mantine` resolves through
   *  `BUILTIN_PACK_LATEST` during lowering, so downstream consumers
   *  (generator dispatch in `src/generator/react/index.ts`, the
   *  build-matrix CI test, snapshot fixtures) see an unambiguous
   *  string and don't need to re-resolve the toolchain default.
   *  Custom paths flow through verbatim.
   *
   *  Named `design` rather than `ui` because the test DSL already
   *  uses `ui.workflows.X(...)` as a member-access namespace; making
   *  `ui` a keyword in the deployable block would shadow the test-DSL
   *  accessor and break parsing of existing examples. */
  design?: string;
  /** Realization axes (D-REALIZATION-AXES).  Each decomposes the
   *  platform bundle into one orthogonal concern.  All optional in the
   *  type but **always concrete on backend deployables post-lowering**
   *  (normalized to the platform's default, mirroring how `design` is
   *  resolved via `BUILTIN_PACK_LATEST`); left `undefined` on frontend
   *  (`react`/`static`) deployables, which carry no domain realization.
   *
   *  `directoryLayout` maps onto the D-ADAPTER-HOME adapter kind `layout`;
   *  `persistence` onto the `persistence` adapter.  Both carry real
   *  per-backend choice.  (The application/style axis was removed — each
   *  backend has a single fixed emission style, resolved internally by
   *  `resolveStyle`; it is not a user knob.) */
  persistence?: string;
  directoryLayout?: string;
  /** Per-deployable auth opt-in.  Populated when the source declares
   *  `auth: required` or `auth: ui` on the deployable.  Backends with
   *  `auth.required === true` emit JWT-decode middleware + a verifier
   *  hook the user implements; a frontend with `auth.ui === true`
   *  mounts the login redirect + route guard under the system
   *  `auth { ... }` block.  Deployables without this stay open
   *  (existing behaviour). */
  auth?: { required: boolean; ui: boolean };
  /** Name of the `ui { ... }` SystemMember this deployable serves.
   *  Set when the source declares
   *  either `ui: <Name>` (sugar) or `ui <Name> { framework: ... }`
   *  (full block).  Validator ensures the referenced ui
   *  exists, the deployable's platform supports a UI mount, and the
   *  framework value is one of the v0-allowed alternatives.  Empty
   *  string is never produced — undefined ⇒ no UI binding. */
  uiName?: string;
  /** Frontend rendering technology — `react` is the only v0 value
   *  (default when `ui:` is set without an explicit `framework:`).
   *  Future LiveView / Blazor backends extend this enum without
   *  breaking the deployable IR. */
  uiFramework?: string;
  /** D-PHOENIX-SURFACE: the `ui` declarations this deployable `hosts:`.
   *  The host↔ui relation that supersedes `uiName` (the legacy single
   *  `ui:` binding).  A list from day one so a deployable can host
   *  several UIs (the deferred one-ui-many-frameworks case).  Empty
   *  when the source uses the legacy `ui:` binding instead.  When
   *  present and the legacy binding is absent, `uiName`/`uiFramework`
   *  fall back to the first entry (the framework comes from the `ui`
   *  declaration itself, not the platform). */
  hostedUiNames: string[];
  /** Apis this backend deployable serves.  Each
   *  entry references an `Api` declared at system scope.  Empty
   *  for frontend deployables and for backends that haven't yet
   *  migrated to the explicit composition syntax. */
  serves: string[];
  /** UI api parameter bindings for frontend
   *  deployables.  Each entry binds a UI parameter (declared as
   *  `api <Name>: <Api>` in the ui block) to the backend
   *  deployable that supplies it (which must `serves:` the
   *  param's contract).  Empty for backend deployables and for
   *  frontends whose UI declares no api parameters. */
  uiBindings: UiParamBindingIR[];
  /** Optional favicon path — relative to the source `.ddd` file.
   *  Carried verbatim through lowering; the React generator
   *  resolves the path, copies the referenced file into
   *  `public/favicon.<ext>`, and emits a corresponding
   *  `<link rel="icon">` in the generated `index.html`. */
  favicon?: string;
}

/** A single UI-parameter binding on a frontend deployable.
 *  Maps the UI parameter's local name to the backend deployable
 *  that fills it. */
export interface UiParamBindingIR {
  /** Local UI parameter name (matches `api <name>: <Api>` in the ui block). */
  paramName: string;
  /** Name of the backend deployable that supplies the param's contract. */
  sourceDeployableName: string;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type StmtIR =
  | { kind: "precondition"; expr: ExprIR; source: string; message?: MessageIR; origin?: OriginRef }
  | { kind: "requires"; expr: ExprIR; source: string; origin?: OriginRef }
  | { kind: "let"; name: string; expr: ExprIR; type: TypeIR; origin?: OriginRef }
  | {
      kind: "assign";
      target: PathIR;
      value: ExprIR;
      targetType: TypeIR;
      prov?: ProvSite;
      origin?: OriginRef;
    }
  | {
      kind: "add";
      target: PathIR;
      value: ExprIR;
      elementType: TypeIR;
      /** True when the target is a collection (append); false for a
       *  scalar compound `+=` (arithmetic).  Domain bodies only ever emit
       *  collection `add`; page handlers overload it for counters, so the
       *  walker reads this to choose `[...xs, v]` vs `x + v`. */
      collection: boolean;
      prov?: ProvSite;
      origin?: OriginRef;
    }
  | {
      kind: "remove";
      target: PathIR;
      value: ExprIR;
      elementType: TypeIR;
      /** True when the target is a collection (remove element); false for
       *  a scalar compound `-=` (arithmetic). */
      collection: boolean;
      prov?: ProvSite;
      origin?: OriginRef;
    }
  | {
      kind: "emit";
      eventName: string;
      fields: { name: string; value: ExprIR }[];
      origin?: OriginRef;
    }
  | {
      kind: "call";
      target: "function" | "private-operation" | "action" | "store-action";
      name: string;
      args: ExprIR[];
      /** Populated when `target === "store-action"` (Stage 5) — the resolved
       *  store the `<Store>.<action>(…)` call dispatches to.  `name` is the
       *  action; backends bind the store action without re-resolving. */
      store?: string;
      /** Populated when `target === "private-operation"` — the resolved privacy
       *  of the target sibling operation (see the ExprIR `call` node's
       *  `targetPrivate`).  Absent (⇒ public) for `function` and the rest. */
      targetPrivate?: boolean;
      origin?: OriginRef;
    }
  /**
   * Bare expression-statement.  Used when a chained call like
   * `a.b.c(args)` appears as an operation- or test-body statement.
   * Renderers emit `<expr>;` (TS / e2e) or `<expr>;` (C#).
   */
  | { kind: "expression"; expr: ExprIR; origin?: OriginRef }
  /**
   * Effect-form variant `match` (async-actions-and-effects.md Stage 2) — a
   * `match SUBJECT { Variant b => <stmts> }` used for its side effects, where
   * each arm runs a statement block rather than yielding a value (the statement
   * twin of the `match` ExprIR).  Emitted for `match await op() { … }` in a
   * frontend action body: the `subject` is the awaited remote call (a
   * `call`/`method-call` ExprIR with `awaited: true`) whose `or`-union result is
   * discriminated; the frontend walker renders the async envelope (await the
   * mutation, reify the thrown error into the error variant) + a discriminant
   * switch.  Gated to frontend action/component bodies — backends never receive
   * it (a backend render-stmt hits its default arm).
   */
  | {
      kind: "variant-match";
      subject: ExprIR;
      /** Resolved `or`-union TypeIR of the subject — the variant set. */
      subjectType?: TypeIR;
      arms: {
        varType: TypeIR;
        binding?: string;
        body: StmtIR[];
        /** True when this variant is an `error` payload (see the match ExprIR's
         *  `variantArms[].isError`). */
        isError?: boolean;
      }[];
      elseBody?: StmtIR[];
      origin?: OriginRef;
    }
  /**
   * `return <expr>` — an operation's designed-in outcome
   * (exception-less.md).  `value` produces the operation's declared
   * `or`-union return; the route translator maps an `error`-variant result
   * to a ProblemDetails status and a success variant to HTTP 200.
   *
   * In a union-returning operation, lowering tags the return with the matching
   * variant: `variantTag` is the wire discriminator, `variantShape` says how
   * the value carries on the wire — `"record"` (fields flattened beside
   * `type`), `"scalar"` (a single `value` field), or `"none"` (the bare unit).
   * Absent when the operation has no union return (a plain value return).
   */
  | {
      kind: "return";
      value: ExprIR;
      variantTag?: string;
      variantShape?: "record" | "scalar" | "none";
      origin?: OriginRef;
    };

/**
 * A path used as the LHS of an assignment / collection mutation.  All
 * paths are rooted in `this` (the enclosing aggregate).  The first
 * segment is the property/containment name on the root; subsequent
 * segments walk into nested structure.  Paths never reference parameters
 * or let-bindings (those are not assignable in Loom).
 */
export interface PathIR {
  segments: string[];
}

/**
 * Per-write-site provenance metadata, attached to an `assign`/`add`/`remove`
 * statement whose target resolves to a `provenanced` stored field.  Each
 * site is its own immutable rule snapshot: the RHS expression structure
 * (`exprText` + the lowered `value` ExprIR) anchored at a source span.
 * The runtime trace records which write produced the field's current value
 * and points back at `snapshotId`.
 */
export interface ProvSite {
  /** Stable hash of source path + target + span (commit-independent). */
  snapshotId: string;
  /** Resolved aggregate type + field name this write targets. */
  target: { type: string; field: string };
  /** Source text of the RHS expression (structure, no runtime values). */
  exprText: string;
  source: { path: string; span: { start: number; end: number } };
}

// ---------------------------------------------------------------------------
// Expressions — fully resolved, every name has a kind tag.
// ---------------------------------------------------------------------------

export type LiteralKind = "string" | "int" | "long" | "decimal" | "money" | "bool" | "null" | "now";

/**
 * Per-primitive style escape hatch — pack-neutral CSS entries.
 * Lowered from `style: { background: "...", padding: "..." }` named args
 * on walker-primitive calls.  Entries use an ordered list (not a
 * Record<string, ExprIR>) so source order survives the IR pipeline and
 * downstream emitters can produce deterministic output.  Keys are CSS
 * property names (kebab- or camel-cased as in source); values are any
 * `ExprIR` so refs/interpolation compose naturally.
 */
export type StyleIR = { entries: Array<{ key: string; value: ExprIR }> };

export type RefKind =
  | "param"
  | "let"
  | "lambda"
  | "this-prop" // entity field (private _name with public getter)
  | "this-vo-prop" // value-object public readonly field
  | "this-derived"
  | "helper-fn"
  | "workflow-fn" // a bare reference to a workflow's own `function` helper (rendered as the scoped name)
  | "enum-value"
  | "current-user" // magic identifier — system's `user` block shape
  | "resource" // ambient resource handle — `files`, `jobs`, … (Phase 4)
  | "store-field" // a `<Store>.<field>` read from a page/component/store body (Stage 5)
  | "match-binding" // the narrowed variant binding of a variant-`match` arm (variant-match.md)
  | "unknown";

export type CallKind =
  | "function" // calls a `function` declared in scope
  | "workflow-fn" // calls a workflow's own `function` helper — emitted as a per-workflow-scoped module helper
  | "value-object-ctor" // calls a value-object constructor
  | "private-operation" // calls a private operation
  | "resource-op" // a verb call on an ambient resource handle (Phase 4)
  | "repo-read" // a read-only repository query in a `reading` domain-service body (domain-services.md rev. 4)
  | "domain-service" // a member call on a `domainService` (domain-services.md)
  | "action" // a bare call to a SIBLING page/component `action` (Proposal A Stage 1)
  | "store-action" // a `<Store>.<action>(…)` call from a page/component/store body (Stage 5)
  | "free"; // unresolved free call

export type BinOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "<"
  | "<="
  | ">"
  | ">="
  | "=="
  | "!="
  | "&&"
  | "||";

/**
 * The discriminated policy decision carried by an `authz-filter` `ExprIR`
 * node (M-T9.9).  Each backend's filter translator switches over `kind` with
 * TypeScript exhaustiveness, so adding a variant is a `tsc` error at every
 * render site — the compile-time replacement for the pre-M-T9.9 chain of
 * `isDenyFilter` / `isDeepScopeFilter` runtime probes on a `method-call`
 * marker (where a forgotten arm was a SILENT authorization bypass, not a
 * build break).
 *
 *  - `deny` — the always-false carve-out (`deny [write] on <Agg>`,
 *    authorization Phase 4, deny-wins).  Principal-FREE: it routes to each
 *    backend's STATIC filter path (no ambient-principal parameter), which is
 *    what keeps a denied aggregate's read/write seam free of the unused-param
 *    trap.  Every backend renders it to its native always-false fragment
 *    (Drizzle `and(isNull, isNotNull)` / EF `false` / JPQL `1 = 0` /
 *    `cb.disjunction()` / SQLAlchemy contradiction / Ecto `fragment("false")`).
 *  - `scope` — the descendant-or-self materialized-path subtree scope
 *    (`deep`/`global` read levels, multi-tenancy Phase 2).  PRINCIPAL-referencing
 *    (carries `currentUser.<anchor>` + `currentUser.tenantId` as resolved
 *    member sub-expressions), so it routes to the ambient-principal filter
 *    path and `exprUsesCurrentUser` classifies it by walking those children.
 *    Renders to the compound scope predicate with the NULL-dataKey fallback
 *    to the tenant floor (`DEEP_SCOPE_SEMANTICS`).  `anchorClaim` is
 *    `currentUser.orgPath` for `deep` (caller's node + descendants) or
 *    `currentUser.rootOrg` for `global` (caller's ROOT subtree).
 */
export type AuthzFilterKind =
  | { kind: "deny" }
  | {
      kind: "scope";
      /** `currentUser.<anchor>` as a resolved `member` sub-expression — the
       *  descendant-prefix anchor (`orgPath` for `deep`, `rootOrg` for
       *  `global`).  Kept as ExprIR so a backend that renders the claim through
       *  its own expression path (Java's null-safe SpEL accessor) reuses it
       *  verbatim, and `exprUsesCurrentUser` sees the principal reference. */
      anchorClaim: ExprIR;
      /** `currentUser.tenantId` as a resolved `member` sub-expression — the
       *  floor the NULL-dataKey fallback compares against. */
      tenantClaim: ExprIR;
    };

export type ExprIR =
  | { kind: "literal"; lit: LiteralKind; value: string; origin?: OriginRef }
  | { kind: "this"; origin?: OriginRef }
  | { kind: "id"; origin?: OriginRef }
  | {
      kind: "ref";
      name: string;
      refKind: RefKind;
      enumName?: string;
      type?: TypeIR;
      /** Populated when `refKind === "resource"` — the resource's
       *  declared name and infra kind, so a `.verb(...)` call on it can
       *  lower to a `resource-op` without re-resolving (Phase 4). */
      resourceName?: string;
      resourceKind?: DataSourceKind;
      /** Populated when `refKind === "store-field"` — the declaring store's
       *  name, so a `<Store>.<field>` read renders against the right store
       *  module without re-resolving the receiver (Stage 5).  `name` is the
       *  field; `type` its declared type. */
      storeName?: string;
      /** Populated when `refKind === "workflow-fn"` — the enclosing workflow's
       *  name, so a bare reference renders the scoped helper name `<wf><fn>`
       *  (workflows share a file, so helpers are namespaced by workflow). */
      wfScope?: string;
      origin?: OriginRef;
    }
  | {
      kind: "member";
      receiver: ExprIR;
      member: string;
      receiverType: TypeIR;
      memberType: TypeIR;
      origin?: OriginRef;
    }
  | {
      kind: "method-call";
      receiver: ExprIR;
      member: string;
      args: ExprIR[];
      receiverType: TypeIR;
      isCollectionOp: boolean;
      /** Set when `member` is a recognised test-assertion matcher
       *  (`toBe`/`toHaveText`/`toBeVisible`/…) — a built-in "intrinsic"
       *  the type system knows and each backend lowers to its native test
       *  library (Playwright/vitest/xUnit/ExUnit).  Resolved here so
       *  backends switch on the flag rather than re-recognising names. */
      isIntrinsicMatcher?: boolean;
      /** Optional parallel array: `argNames[i]` is the
       *  source-side `name:` prefix for `args[i]`, or `undefined` for
       *  positional arguments.  Present iff at least one arg was
       *  written with a name; absent for fully-positional calls (the
       *  vast majority — keeps IR compact for v22-shaped code). */
      argNames?: (string | undefined)[];
      /** `await`-marked (async-actions-and-effects.md Stage 2) — set when this
       *  method-call was written as a `match await <call>()` subject.  The
       *  frontend walker emits the async envelope (await the mutation, reify
       *  the thrown error into the union) around a variant-match on the
       *  result; every other consumer ignores it. */
      awaited?: boolean;
      origin?: OriginRef;
    }
  | {
      kind: "call";
      callKind: CallKind;
      name: string;
      args: ExprIR[];
      /** Same shape as `method-call.argNames` — see above. */
      argNames?: (string | undefined)[];
      /** `await`-marked (async-actions-and-effects.md Stage 2) — see the
       *  `method-call` node's `awaited`.  Set when the call was the subject of a
       *  `match await <call>()`; drives the frontend async-await envelope. */
      awaited?: boolean;
      /** Populated when `callKind === "workflow-fn"` — the enclosing workflow's
       *  name.  A workflow `function` is emitted as a per-workflow-scoped module
       *  helper (a workflow body is not a class), so backends render the call as
       *  the scoped, per-backend-cased name `<wf><fn>(args)`. */
      wfScope?: string;
      /** Populated when `callKind === "resource-op"` (Phase 4) — the
       *  resolved resource binding, verb, the capability it requires,
       *  and the access interface (default from
       *  `EnrichedSystemIR.resourceInterfaces`, with per-verb override).
       *  The bound `ResourceAdapter.emitOperation` renders the call. */
      resourceOp?: {
        resourceName: string;
        resourceKind: DataSourceKind;
        verb: string;
        capability: string;
        interface?: LoomInterface;
      };
      /** Populated when `callKind === "domain-service"` (domain-services.md)
       *  — the resolved `domainService` name and the operation invoked.
       *  Structured (not overloaded onto flat `name`) so backends render
       *  the call without re-resolving the receiver. */
      serviceRef?: { service: string; op: string };
      /** Populated when `callKind === "repo-read"` (domain-services.md rev. 4,
       *  the `reading` tier) — a read-only repository query in a domain-service
       *  operation body (`Accounts.byHolder(h)` / `Repo.find/findAll/run`).
       *  Fully resolved at lowering time: `repo` is the repository name,
       *  `aggregate` its target aggregate, `method` the find / retrieval method
       *  to render against the generated repository, and `readKind` the recognised
       *  shape (`named` declared find / `getById`, vs the criterion `find`/`findAll`
       *  vs retrieval `run`).  Backends render a real call into the generated
       *  repository without re-recognising the AST.  Per-backend EMISSION is a
       *  later slice (this slice is the IR foundation only). */
      repoRead?: {
        repo: string;
        aggregate: string;
        method: string;
        readKind: "named" | "find" | "findAll" | "run";
        /** The retrieval a criterion / retrieval read runs against — mirrors the
         *  workflow `repo-run` path.  For `find`/`findAll` it is the synthesized
         *  `findAllBy<Criterion>` (materialised by `synthesizeFindAllRetrievals`
         *  from the criterion); for `run` it is the referenced retrieval name.
         *  Absent for `named` reads (a declared `find`/`getById`).  Backends
         *  render their retrieval-method name (`run<Name>`) from it so the
         *  emitted call hits a real method that APPLIES the criterion, rather
         *  than dropping it and calling the whole-table `findAll`/`all`. */
        retrievalName?: string;
        /** The criterion a `find`/`findAll` read filters by — drives the enrich
         *  pass's synthesis of the `retrievalName` retrieval (same criterion the
         *  workflow `synthCriterion` names).  Absent for `run`/`named`. */
        synthCriterion?: { name: string };
      };
      /** Populated when `callKind === "store-action"` (Stage 5) — the resolved
       *  store + action a `<Store>.<action>(…)` call dispatches to.  Structured
       *  (not overloaded onto flat `name`) so backends bind the store action
       *  without re-resolving the receiver.  `name` mirrors `storeAction.action`. */
      storeAction?: { store: string; action: string };
      /** Per-primitive `style:` escape hatch.  Populated by lowering
       *  when the source supplied a `style: { … }` named arg on a
       *  walker-primitive call (`Container { style: { background: "red" }, ... }`).
       *  The named arg is hoisted out of `args`/`argNames` into this
       *  field.  React emits `style={{...}}`; Phoenix emits `style="..."`.
       *  Use the ordered `entries` shape (not a `Record`) so entry order
       *  survives the IR pipeline. */
      style?: StyleIR;
      /** Populated when `callKind === "private-operation"` — the resolved
       *  privacy of the target sibling operation.  An operation self-call
       *  lowers to `private-operation` regardless of the operation's actual
       *  `private` modifier, so backends that name public vs private
       *  operations differently (Python: `def reserve` vs `def _reserve`)
       *  must know which one the def-site emitted.  Absent (⇒ public) for
       *  `function` calls (functions are always private) and every other
       *  `callKind`. */
      targetPrivate?: boolean;
      origin?: OriginRef;
    }
  | {
      /** A bare reference to a named page/component `action` in
       *  handler-arg position (`onSubmit: next`, `rowAction: add`) — the
       *  named-action analogue of an inline handler lambda (Proposal A
       *  Stage 1).  Fully resolved at lowering time: `actionName` is the
       *  declared action; `paramType` is its single declared payload param
       *  type (undefined ⇒ nullary action).  Backends and the validator
       *  read these directly — they never re-resolve the name.  The walker
       *  binds the hoisted handler (whose name derives from `actionName`)
       *  instead of emitting an inline arrow. */
      kind: "action-ref";
      actionName: string;
      paramType?: TypeIR;
      /** Set when the handler reference is a bare STORE action (`onClick:
       *  Cart.clear`) rather than a sibling page/component action — the store
       *  analogue of a page `action-ref`.  Backends bind it through the store
       *  seam (record the use, reference the shell-bound store-action local)
       *  instead of the page-action handler.  Absent for a page action. */
      storeName?: string;
      origin?: OriginRef;
    }
  | {
      kind: "lambda";
      param: string;
      /** Single-expression form: `x => expr`.  Mutually exclusive with
       *  `block`.  Existing v22 lambdas always populate this. */
      body?: ExprIR;
      /** Block-body form: `x => { stmt; stmt; … }`.
       *  Reuses the existing `StmtIR` rule so `let`, `:=`, calls,
       *  emits, etc. are admissible.  React emitter lowers
       *  state mutations against `state {}` fields to `setX(...)`. */
      block?: StmtIR[];
      origin?: OriginRef;
    }
  | {
      kind: "new";
      partName: string;
      fields: { name: string; value: ExprIR }[];
      /** True when the constructed part is NESTED — contained by a sibling part,
       *  not the aggregate root (`Order → Shipment → Label`, a `new Label`).
       *  Its parent (the enclosing part) has no id at construction time, so
       *  backends OMIT the construction-time `parentId`: the FK is stamped from
       *  tree position on save and set from the DB row on hydrate.  Absent /
       *  false for a root-level part (`new Shipment`), which keeps passing the
       *  ambient `this` id — byte-identical. */
      nested?: boolean;
      origin?: OriginRef;
    }
  | {
      kind: "object";
      fields: { name: string; value: ExprIR }[];
      origin?: OriginRef;
    }
  | {
      /** Bracketed list literal — `[expr, expr, ...]`.  Produced by
       *  `ListLit` AST nodes; consumers that admit a list shape
       *  (e.g. `Grid { cols: [3, 2, 1] }`) inspect `elements` directly.
       *  No element-type unification happens at lowering — heterogeneous
       *  element types are admissible at the IR level; per-use-site
       *  validators decide whether to flag them. */
      kind: "list";
      elements: ExprIR[];
      origin?: OriginRef;
    }
  /**
   * Authorization / tenancy filter sentinel (M-T9.9).  A synthesized,
   * never-parsed predicate that carries a DISCRIMINATED policy decision
   * (`filter.kind`) instead of riding the IR as an ordinary `method-call`
   * marker (the pre-M-T9.9 `__loomDeny__` / `__loomDeepScope__` encoding).
   *
   * The decision is made ONCE in enrichment (deep/global/deny — see
   * `src/ir/enrich/enrichments.ts`) and every backend's query-filter
   * translator only RENDERS the pre-built node to its native fragment
   * (Drizzle contradiction, EF `false`, JPQL `1 = 0`, Ecto `fragment("false")`,
   * …).  Making it a first-class `ExprIR.kind` — rather than a `method-call`
   * every backend already handles — is the safety payoff: a backend that
   * omits a filter arm can no longer fall through to the generic expression
   * dispatcher and emit a silent authorization bypass.  Instead the shared
   * dispatcher THROWS on it (like `action-ref`), the queryable-subset gate
   * and child-walker force an explicit arm, and each backend switches on
   * `filter.kind` with TypeScript exhaustiveness so a future `AuthzFilterKind`
   * becomes a `tsc` error at every render site.
   *
   * Never reaches a domain-logic expression position — it lives ONLY in an
   * aggregate's `contextFilters` / `writeScopeFilter`, special-cased by the
   * filter translators BEFORE the generic dispatch.  Build/inspect it through
   * `src/ir/util/tenant-stance.ts` (`buildDenyFilter` / `buildDeepScopeFilter`
   * / `buildGlobalScopeFilter`, `isDenyFilter` / `isDeepScopeFilter`).
   */
  | {
      kind: "authz-filter";
      /** The discriminated policy decision this sentinel encodes. */
      filter: AuthzFilterKind;
      /** Name of the aggregate the filter guards (formerly the marker's
       *  `receiverType.name`).  Backends key the row's table/alias off their
       *  render context, not this — it is carried for provenance / debugging. */
      aggregate: string;
      origin?: OriginRef;
    }
  | { kind: "paren"; inner: ExprIR; origin?: OriginRef }
  | { kind: "unary"; op: "-" | "!"; operand: ExprIR; origin?: OriginRef }
  | {
      kind: "binary";
      op: BinOp;
      left: ExprIR;
      right: ExprIR;
      /** Type of the left operand, populated during lowering when
       *  available.  Backends use this to dispatch operator rendering —
       *  e.g. Phoenix emits `Decimal.add(l, r)` for money operands,
       *  TS emits `l.plus(r)` against a decimal.js Decimal — without
       *  re-running expression-type inference.  Synthetic binary nodes
       *  (built by walker-primitive-expander, etc.) may leave this
       *  undefined; those paths only need operand-blind operator
       *  rendering. */
      leftType?: TypeIR;
      /** Type of the RIGHT operand — same population policy as `leftType`.
       *  Needed alongside `leftType` to distinguish an integer division that
       *  widened to `decimal` (`int / int` — both operands integral, cast both)
       *  from an already-fractional mixed division (`int / decimal` — the
       *  decimal operand must NOT be re-wrapped). */
      rightType?: TypeIR;
      /** Type of the binary expression as a whole — comparison/logical
       *  ops are `bool`; arithmetic ops follow the type-system's
       *  closed-money and numeric-widening rules.  Same population
       *  policy as `leftType`. */
      resultType?: TypeIR;
      origin?: OriginRef;
    }
  | { kind: "ternary"; cond: ExprIR; then: ExprIR; otherwise: ExprIR; origin?: OriginRef }
  /**
   * Explicit primitive conversion — `<target>(<value>)`.  Source-
   * level form: `string(age)`, `money(decimalField)`,
   * `decimal(moneyValue)`.  Distinct from `MoneyLit`'s `money("…")`
   * literal form (which lowers to `lit("money", …)`); this is for
   * converting a TYPED VALUE between primitives.
   *
   * `from` carries the source operand's inferred primitive type so
   * backends can dispatch the right emit form per (from, target)
   * pair (TS `String(x)` vs `x.toString()`, .NET `(decimal)x` vs
   * `x` no-op, Phoenix `to_string(x)` vs `Decimal.to_string(x)`).
   * Populated by lowering — may be `undefined` if the source's type
   * couldn't be inferred (broken upstream; validator will already be
   * reporting it).
   */
  | {
      kind: "convert";
      target: PrimitiveName;
      from: PrimitiveName | undefined;
      value: ExprIR;
      origin?: OriginRef;
    }
  /**
   * Duration constructor (A5 temporal, docs/old/plans/stdlib.md) —
   * `days(n)` / `hours(n)` / `minutes(n)`.  Parsed as an ordinary free
   * call; lowered to this node ONLY when the name did not resolve to any
   * user declaration (a user `function days(...)` shadows the builtin and
   * lowers to a plain `call`).  `amount` is int-typed (validated by
   * `loom.duration-arity` / `loom.duration-arg-type`); the node's type is
   * `{ kind: "primitive", name: "duration" }`.  Every unit is ABSOLUTE
   * (fixed millisecond width), which is what lets every backend render the
   * absolute-milliseconds path uniformly; calendar-relative offsets
   * (`months`, `years`) are deliberately not part of `duration`.
   */
  | {
      kind: "duration";
      unit: DurationUnit;
      amount: ExprIR;
      origin?: OriginRef;
    }
  /**
   * Predicate-arms expression — first arm whose
   * `cond` evaluates to `true` returns its `value`; if no arm
   * matches, `otherwise` (when present) is the fallthrough.  Lives
   * in the expression engine so it can appear anywhere an expression
   * is allowed (page bodies, `derived` properties, view binds,
   * filter lambdas, function bodies).  Validator may warn
   * on non-exhaustive matches that lack `otherwise`.
   */
  | {
      kind: "match";
      /**
       * Boolean-form arms (`match { cond => value }`).  Present for the
       * predicate-arms form; empty for the variant form.
       */
      arms: { cond: ExprIR; value: ExprIR }[];
      otherwise?: ExprIR;
      /**
       * Variant-match scrutinee (variant-match.md) — the `or`-union value
       * being discriminated.  `undefined` for the boolean form.  Lowered
       * to a `ref` ExprIR (the v1 constraint restricts it to a simple
       * ref / let-bound name, so it is side-effect-free and may be read
       * once by every arm).  `subjectType` is its resolved union TypeIR,
       * carried so backends never re-resolve the variant set.
       */
      subject?: ExprIR;
      subjectType?: TypeIR;
      /**
       * Runtime carrier shape of the variant subject.  `"absence"` when the
       * subject is the result of a repository **union find** — those are
       * validator-constrained to the absence shape (`Agg or <error>` /
       * `Agg option`, payloads.md §Union finds) and their runtime value is
       * the bare aggregate-or-absent (`Project | null` / `Project?` /
       * `record | nil`), never the tagged wire carrier.  Backends must
       * render the match as a presence check (success arm on present,
       * error/`none` arm on absent), not a discriminator probe.  Stamped at
       * lowering (the only layer that knows the subject's find origin);
       * `undefined` means the subject is a genuinely tagged union value
       * (operation returns, payload values).
       */
      subjectShape?: "absence";
      /**
       * Variant-form arms.  Each names a union variant by its resolved
       * `varType` TypeIR (the wire tag is `variantTag(varType)` — derived,
       * not stored), optionally binds the narrowed variant value to
       * `binding`, and returns `value`.  Inside `value`, a reference to
       * `binding` lowers to a `ref` with `refKind: "match-binding"` typed
       * at `varType` (the if-let / lambda-param narrowing analog), so
       * member reads on it resolve with full receiver/member types.
       * Empty for the boolean form.
       */
      variantArms: {
        varType: TypeIR;
        binding?: string;
        value: ExprIR;
        /** True when this variant is an `error` payload.  Most backends tag
         *  every variant uniformly by `type` and ignore this, but the Elixir
         *  vanilla backend represents a union result as an asymmetric tagged
         *  tuple — `{:ok, value}` for the success variant vs `{:error, tag,
         *  fields}` for an error — so its `case` clause shape depends on it.
         *  Derived at lowering from the enclosing context's payload kinds
         *  (the generators have no context to re-derive it). */
        isError?: boolean;
      }[];
      origin?: OriginRef;
    };

// Convenience constructors used by the lowering layer.
export const lit = (kind: LiteralKind, value: string): ExprIR => ({
  kind: "literal",
  lit: kind,
  value,
});

// ---------------------------------------------------------------------------
// Workspace traversal helpers — dedupe the systems-vs-contexts dual
// iteration that every consumer (validator, system orchestrator,
// wire-spec emitter) had to spell out.  A `LoomModel` carries
// bounded contexts in two places: under each system's modules, and
// at the top level (legacy single-deployable mode).  These helpers
// flatten both into a single iterator.
// ---------------------------------------------------------------------------

/** Every bounded context in the model — system-bundled + top-level. */
export function allContexts(loom: LoomModel): BoundedContextIR[] {
  const out: BoundedContextIR[] = [];
  for (const sys of loom.systems) {
    for (const m of sys.subdomains) out.push(...m.contexts);
  }
  out.push(...loom.contexts);
  return out;
}

/** Every aggregate in the model, regardless of which context owns it. */
export function allAggregates(loom: LoomModel): AggregateIR[] {
  return allContexts(loom).flatMap((c) => c.aggregates);
}

// ---------------------------------------------------------------------------
// `currentUser` reference detection.
//
// Every per-platform emitter needs to know "does this operation /
// workflow / view body actually reference the `currentUser` magic
// identifier?" so it can:
//   - thread a `User` parameter into the generated method signature,
//   - inject the request-scoped user accessor into the Mediator
//     handler / Hono route,
//   - decide whether to import the auth types at all.
// One IR-level helper avoids duplicating the walker on each backend.
// ---------------------------------------------------------------------------

/** True when the expression tree contains at least one `current-user`
 *  ref (either bare `currentUser` or a member-access rooted in it). */
export function exprUsesCurrentUser(e: ExprIR | undefined): boolean {
  let found = false;
  walkExprDeep(e, (node) => {
    if (node.kind === "ref" && node.refKind === "current-user") found = true;
  });
  return found;
}

/** True when a `currentUser`-valued stamp RHS is the bare principal or its
 *  `id` member — the "who" identity that a backend may collapse onto the
 *  ambient actor id (Hono `ctx.actorId`, Java `@CreatedBy`/AuditorAware).  A
 *  member access on any OTHER claim (`currentUser.role`, `currentUser.tenantId`)
 *  returns false: those must persist the DECLARED attribute so a read filter
 *  comparing the same claim (`this.createdByRole == currentUser.role`) matches
 *  the stamped row. */
export function currentUserRefIsActorId(e: ExprIR): boolean {
  if (e.kind === "ref" && e.refKind === "current-user") return true;
  if (
    e.kind === "member" &&
    e.member === "id" &&
    e.receiver.kind === "ref" &&
    e.receiver.refKind === "current-user"
  )
    return true;
  return false;
}

/** True when the operation's body — preconditions, assignments,
 *  emits, calls — references `currentUser` anywhere. */
export function operationUsesCurrentUser(op: OperationIR): boolean {
  return op.statements.some(stmtUsesCurrentUser);
}

/** True when the operation has at least one `requires` guard.  A guarded
 *  op denies with HTTP 403 at runtime (ForbiddenError/Exception/
 *  `:forbidden`), so every backend declares a 403 ProblemDetails response
 *  for it in the generated OpenAPI. */
export function operationIsGuarded(op: OperationIR): boolean {
  return op.statements.some((s) => s.kind === "requires");
}

/** True when the workflow has at least one `requires` guard — same 403
 *  contract as a guarded operation. */
export function workflowIsGuarded(wf: WorkflowIR): boolean {
  return wf.statements.some((s) => s.kind === "requires");
}

/** True when the workflow exposes an HTTP/UI command surface — its facade
 *  (the primary unnamed `create`, else the first create) is
 *  command-triggered.  A workflow whose only `create` is event-triggered
 *  (`create(e: Event)`) — a reactor / saga started by an event, never an
 *  inbound call — has no command surface: its bodies run via the
 *  in-process dispatcher's handlers, so emitting a Request/Command/route
 *  with an event-typed param would be bogus (and wouldn't compile).
 *  Shared by every backend's command-surface emitters (channels.md). */
export function workflowEmitsCommandRoute(wf: WorkflowIR): boolean {
  const creates = wf.creates ?? [];
  const facade = creates.find((c) => c.name === null && c.triggerKind === "command") ?? creates[0];
  return !facade || facade.triggerKind === "command";
}

/** True when any of the workflow's statements (or a sub-expression
 *  inside one) references `currentUser`.  When true, a backend's
 *  workflow handler must materialise a `currentUser` binding (from the
 *  request-scoped auth actor) before the rendered guard/expr — which
 *  emits the bare token `currentUser` — can resolve.  Shared by the
 *  Hono and .NET workflow emitters. */
export function workflowUsesCurrentUser(wf: WorkflowIR): boolean {
  return wf.statements.some(workflowStmtUsesCurrentUser);
}

function workflowStmtUsesCurrentUser(s: WorkflowStmtIR): boolean {
  let found = false;
  walkWorkflowStmtExprsDeep(s, (node) => {
    if (node.kind === "ref" && node.refKind === "current-user") found = true;
  });
  return found;
}

/** True when the find's `where` filter references `currentUser`.
 *  Such finds gain a `currentUser: User` parameter on the generated
 *  repository method, threaded through CQRS handler / Hono route call
 *  sites. */
export function findUsesCurrentUser(find: FindIR): boolean {
  return exprUsesCurrentUser(find.filter);
}

/** True when the find's `requires` authorization gate references
 *  `currentUser`.  The route handler must then read the request principal
 *  into scope before evaluating the gate (the read-side analogue of a view's
 *  gate needing `currentUser`). */
export function findGateUsesCurrentUser(find: FindIR): boolean {
  return exprUsesCurrentUser(find.requires);
}

/** True when the view's where filter or any bind expression
 *  references `currentUser`. */
export function viewUsesCurrentUser(view: ViewIR): boolean {
  if (exprUsesCurrentUser(view.filter)) return true;
  for (const b of view.output?.binds ?? []) {
    if (exprUsesCurrentUser(b.expr)) return true;
  }
  return false;
}

/** True when a query-time projection's `where` filter or `select` expressions
 *  reference `currentUser` — the projection analogue of `viewUsesCurrentUser`.
 *  Drives threading the request principal into the synthesised repo read. */
export function queryProjectionUsesCurrentUser(proj: ProjectionIR): boolean {
  if (exprUsesCurrentUser(proj.query?.filter)) return true;
  for (const s of proj.query?.selects ?? []) {
    if (exprUsesCurrentUser(s.expr)) return true;
  }
  return false;
}

/** True when the aggregate carries a *principal-referencing* capability
 *  `filter` — one whose predicate reads `currentUser` (e.g. a tenancy filter
 *  `filter this.tenantId == currentUser.tenantId`).  Such a filter is AND-ed
 *  into EVERY root read, so — unlike a per-find `currentUser` use — it forces
 *  the `currentUser: User` parameter onto *all* of the aggregate's repository
 *  read methods (findById / findAll / each find), threaded from the route's
 *  `c.get("currentUser")`.  (DEBT-01; the Hono/Drizzle analogue of EF Core's
 *  closure-captured `HasQueryFilter`.) */
export function aggregateUsesPrincipalContextFilter(agg: { contextFilters?: ExprIR[] }): boolean {
  return (agg.contextFilters ?? []).some(exprUsesCurrentUser);
}

/** True when any of the aggregate's lifecycle stamps (`contextStamps`, from
 *  `with audit`/`auditable` or `stamp onCreate`/`onUpdate`) assigns a value
 *  that reads `currentUser` (e.g. `createdBy := currentUser`).  Such a stamp
 *  needs the request principal threaded onto the create /
 *  update call so the stamp can read the current actor — the
 *  stamp-side analogue of `aggregateUsesPrincipalContextFilter`. */
export function aggregateStampUsesPrincipal(agg: { contextStamps?: ContextStampIR[] }): boolean {
  return (agg.contextStamps ?? []).some((r) =>
    r.assignments.some((a) => exprUsesCurrentUser(a.value)),
  );
}

function stmtUsesCurrentUser(s: StmtIR): boolean {
  let found = false;
  walkStmtExprsDeep(s, (node) => {
    if (node.kind === "ref" && node.refKind === "current-user") found = true;
  });
  return found;
}

// ---------------------------------------------------------------------------
// Money usage detection
//
// Backends gate runtime-dep inclusion (decimal.js / rust_decimal / etc.)
// and per-file import lines on whether the IR actually carries any
// money-typed values.  Walk every type and every literal so an
// aggregate that uses money via, say, a derived expression or an
// operation parameter is detected even if no field is typed as money.
// ---------------------------------------------------------------------------

/** True when the type tree contains a `primitive money` anywhere. */
export function typeUsesMoney(t: TypeIR | undefined): boolean {
  if (!t) return false;
  if (t.kind === "primitive") return t.name === "money";
  if (t.kind === "array") return typeUsesMoney(t.element);
  if (t.kind === "optional") return typeUsesMoney(t.inner);
  return false;
}

/** True when the expression tree contains a money literal or a binary
 *  node whose stashed type info is money.  Used to catch money
 *  appearing in derived/invariant expressions without an explicit
 *  field. */
export function exprUsesMoney(e: ExprIR | undefined): boolean {
  if (!e) return false;
  if (e.kind === "literal" && e.lit === "money") return true;
  if (e.kind === "binary") {
    if (typeUsesMoney(e.leftType) || typeUsesMoney(e.resultType)) return true;
    return exprUsesMoney(e.left) || exprUsesMoney(e.right);
  }
  if (e.kind === "member") return exprUsesMoney(e.receiver);
  if (e.kind === "method-call") return exprUsesMoney(e.receiver) || e.args.some(exprUsesMoney);
  if (e.kind === "ternary")
    return exprUsesMoney(e.cond) || exprUsesMoney(e.then) || exprUsesMoney(e.otherwise);
  if (e.kind === "unary") return exprUsesMoney(e.operand);
  if (e.kind === "paren") return exprUsesMoney(e.inner);
  if (e.kind === "call") return e.args.some(exprUsesMoney);
  if (e.kind === "lambda") return exprUsesMoney(e.body);
  if (e.kind === "new" || e.kind === "object") return e.fields.some((f) => exprUsesMoney(f.value));
  if (e.kind === "match")
    return (
      e.arms.some((a) => exprUsesMoney(a.cond) || exprUsesMoney(a.value)) ||
      exprUsesMoney(e.otherwise)
    );
  return false;
}

function stmtUsesMoney(s: StmtIR): boolean {
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      return exprUsesMoney(s.expr);
    case "assign":
    case "add":
    case "remove":
    case "return":
      return exprUsesMoney(s.value);
    case "emit":
      return s.fields.some((f) => exprUsesMoney(f.value));
    case "call":
      return s.args.some(exprUsesMoney);
    case "variant-match":
      return (
        exprUsesMoney(s.subject) ||
        s.arms.some((a) => a.body.some(stmtUsesMoney)) ||
        (s.elseBody ?? []).some(stmtUsesMoney)
      );
  }
}

/** True when a function's body (expression or block form) touches money. */
export function functionBodyUsesMoney(body: FunctionBodyIR): boolean {
  return "expr" in body ? exprUsesMoney(body.expr) : body.stmts.some(stmtUsesMoney);
}

function partUsesMoney(p: EntityPartIR): boolean {
  if (p.fields.some((f) => typeUsesMoney(f.type))) return true;
  if (p.derived.some((d) => typeUsesMoney(d.type) || exprUsesMoney(d.expr))) return true;
  if (p.invariants.some((iv) => exprUsesMoney(iv.expr))) return true;
  if (p.functions.some((fn) => typeUsesMoney(fn.returnType) || functionBodyUsesMoney(fn.body)))
    return true;
  return false;
}

/** True when the aggregate touches money anywhere — fields, derived,
 *  invariants, operations, functions, or nested parts. */
export function aggregateUsesMoney(a: AggregateIR): boolean {
  if (a.fields.some((f) => typeUsesMoney(f.type))) return true;
  if (a.derived.some((d) => typeUsesMoney(d.type) || exprUsesMoney(d.expr))) return true;
  if (a.invariants.some((iv) => exprUsesMoney(iv.expr))) return true;
  if (
    a.operations.some(
      (op) => op.params.some((p) => typeUsesMoney(p.type)) || op.statements.some(stmtUsesMoney),
    )
  )
    return true;
  if (a.functions.some((fn) => typeUsesMoney(fn.returnType) || functionBodyUsesMoney(fn.body)))
    return true;
  if (a.parts.some(partUsesMoney)) return true;
  return false;
}

/** The value-object name a field type resolves to, unwrapping
 *  array/optional envelopes — undefined for non-VO types. */
function typeVoName(t: TypeIR): string | undefined {
  if (t.kind === "valueobject") return t.name;
  if (t.kind === "array") return typeVoName(t.element);
  if (t.kind === "optional") return typeVoName(t.inner);
  return undefined;
}

/** {@link aggregateUsesMoney}, additionally resolving VO-TYPED FIELDS
 *  through the context's value-object registry: `typeUsesMoney` sees only
 *  the name ref on a `listing: Listing` field, so money nested inside the
 *  VO (`Listing { price: money }`) is invisible to the shallow check —
 *  which left every emitter keying its `Decimal`/`moneySchema` import on
 *  it with an unresolved reference (latent compile break on the
 *  money-inside-VO shape).  Recurses through VO-in-VO nesting; cycle-safe. */
export function aggregateUsesMoneyDeep(
  a: AggregateIR,
  valueObjects: readonly ValueObjectIR[],
): boolean {
  if (aggregateUsesMoney(a)) return true;
  const byName = new Map(valueObjects.map((v) => [v.name, v]));
  const seen = new Set<string>();
  const voUsesMoneyDeep = (name: string): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    const vo = byName.get(name);
    if (!vo) return false;
    if (valueObjectUsesMoney(vo)) return true;
    return vo.fields.some((f) => {
      const n = typeVoName(f.type);
      return n ? voUsesMoneyDeep(n) : false;
    });
  };
  const fieldTypes = [...a.fields, ...a.parts.flatMap((p) => p.fields)].map((f) => f.type);
  return fieldTypes.some((t) => {
    const n = typeVoName(t);
    return n ? voUsesMoneyDeep(n) : false;
  });
}

/** True when the value object's wire shape carries any money field. */
export function valueObjectUsesMoney(vo: ValueObjectIR): boolean {
  if (vo.fields.some((f) => typeUsesMoney(f.type))) return true;
  if (vo.derived.some((d) => typeUsesMoney(d.type) || exprUsesMoney(d.expr))) return true;
  if (vo.invariants.some((iv) => exprUsesMoney(iv.expr))) return true;
  if (vo.functions.some((fn) => typeUsesMoney(fn.returnType) || functionBodyUsesMoney(fn.body)))
    return true;
  return false;
}

/** True when the bounded context contains any money usage across
 *  aggregates / value objects.  Backends consume this when deciding
 *  whether to inject a runtime decimal-library dep at the package /
 *  project level (e.g. `decimal.js` for TS, `rust_decimal` for the
 *  future Rust backend). */
export function contextUsesMoney(ctx: BoundedContextIR): boolean {
  if (ctx.aggregates.some(aggregateUsesMoney)) return true;
  if (ctx.valueObjects.some(valueObjectUsesMoney)) return true;
  return false;
}
/** True when the ui declares a money-typed `state {}` field on any page
 *  or component.  Such a field renders as `<Decimal>` + `new
 *  Decimal("0")` in the page shell, so the generated project needs the
 *  `decimal.js` runtime dep even when no aggregate / wire shape carries
 *  money (`contextUsesMoney` covers that case).  Frontend generators OR
 *  this into their package.json money-dep flag. */
export function uiUsesMoney(ui: UiIR): boolean {
  const stateHasMoney = (state: readonly StateFieldIR[]) =>
    state.some((f) => typeUsesMoney(f.type));
  if (ui.pages.some((p) => stateHasMoney(p.state))) return true;
  if (ui.components.some((c) => stateHasMoney(c.state))) return true;
  return false;
}
