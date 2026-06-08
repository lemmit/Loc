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
   *  `docs/proposals/document-and-json-hierarchies.md` (Option 1,
   *  D-DOCUMENT-AXIS). */
  | "json";

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
] as const;

/** Information-flow sensitivity tags carried by a value's type.  See
 * `docs/proposals/sensitivity-and-compliance.md`.  Mirror of
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
  | { kind: "slot"; sensitivity?: SensitivityTags };

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
   * runtime is emitted on the Hono (`node`) backend only — hosting a
   * provenanced context on another backend is rejected at validate time
   * (`loom.provenanced-backend-unsupported`, `validateProvenancedStorage`)
   * rather than silently dropping the trail. */
  provenanced?: boolean;
  /** Information-flow sensitivity tags declared at the property site via
   * `sensitive(<tag>, ...)`.  Sorted + deduped; omitted when the field
   * declared no tags.  Phase 1 only captures the declaration; later
   * phases wire it through the wire-shape, DTO emitters, and sink
   * type-checking.  See `docs/proposals/sensitivity-and-compliance.md`. */
  sensitivity?: SensitivityTags;
  /** Resolved access role.  Populated by `enrichLoomModel`; lowering
   * leaves this undefined when the source declared no modifier so
   * enrichment can apply its precedence (declared > default).
   * After enrichment every `FieldIR` carries a value. */
  access?: FieldAccess;
  /** Where `access` came from.  Diagnostic-only: used by the validator
   * to phrase conflict messages and by the wire-spec diff to explain
   * the field's role.  Same nullability as `access`. */
  accessSource?: "declared" | "default";
  /** Lowered default-value expression from `field: T = <expr>`.  Present
   *  only on aggregate / entity-part / value-object fields that declared a
   *  default (events / views never lower one).  Fully-resolved like any
   *  other `ExprIR`; consumed when synthesising a create for an aggregate
   *  with no explicit one. */
  default?: ExprIR;
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

export interface InvariantIR {
  expr: ExprIR;
  guard?: ExprIR;
  source: string;
  /** When `"server-only"`, the invariant skips wire-boundary
   *  validators (frontend Zod, Hono routes, FluentValidation) even
   *  when its expression would translate cleanly.  Domain-layer
   *  enforcement via `AssertInvariants()` always runs.  Set by
   *  the `@server-only` annotation in the DSL. */
  scope?: "server-only";
}

export interface FunctionIR {
  name: string;
  params: ParamIR[];
  returnType: TypeIR;
  body: ExprIR;
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
   * Consumed by Phase-3 route emitters; no backend reads it yet. */
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
   * nothing.  See `docs/proposals/audit-and-logging.md`. */
  audited: boolean;
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
 * docs/proposals/workflow-and-applier.md. */
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
  /** Canonical JSON-on-the-wire field list.  Populated by
   * `enrichLoomModel` after lowering; lowering itself leaves it
   * undefined so an unenriched IR is a type error to consume.
   * See `src/ir/enrich/enrichments.ts`. */
  wireShape?: WireField[];
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
  /** Canonical JSON-on-the-wire field list.  Populated by
   * `enrichLoomModel`. */
  wireShape?: WireField[];
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
  /** Capability names this aggregate opts into via
   * `implements "<name>"`.  Backends translate by convention to a
   * marker interface / type alias / behaviour, and group runtime
   * infrastructure by capability name (.NET: one `OnModelCreating`
   * filter loop per capability, scoped by `Entries<I<Cap>>()`).
   * Sorted + deduped at lowering time.  Undefined when the
   * aggregate names no capabilities. */
  implementsCapabilities?: readonly string[];
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
 *      tables.  EF owned-types `.ToJson()`, Drizzle jsonb column, Ash
 *      embedded resources.
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
  | { kind: "expect-throws"; expr: ExprIR; source: string };

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
  /** Canonical wire-shape — no id, no containment, just declared
   * fields + derived. */
  wireShape?: WireField[];
}

export interface EventIR {
  name: string;
  fields: FieldIR[];
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
  /** Optional `where ...` filter expression in IR form. */
  filter?: ExprIR;
  /** Set when the `where` filter is *exactly* one named `criterion`
   *  reference — its name + lowered args, for backends that consume the
   *  reified `Criterion`.  `filter` still carries the inlined predicate, so
   *  composed/anonymous filters and non-reifying backends are unaffected. */
  criterionRef?: { name: string; args: ExprIR[] };
}

export interface RepositoryIR {
  name: string;
  aggregateName: string;
  finds: FindIR[];
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
  views: ViewIR[];
  /** Named predicate specifications declared in this context. */
  criteria: CriterionIR[];
  /** Channel declarations in this context (channels.md, Slice 1) — the
   *  publisher-side transport contracts over this context's events. */
  channels: ChannelIR[];
  /** Named query bundles declared in this context (retrieval.md). */
  retrievals: RetrievalIR[];
  /** First-boot seed datasets declared in this context (database-seeding.md).
   *  Platform-neutral; the system-level seed builder (phase ⑨) groups these
   *  per (module, dataset) and the backends emit native seeders. */
  seeds: SeedIR[];
  /** Per-error HTTP status overrides reaching this context, merged from the
   *  `httpStatus <Error> <Code>` clauses of every api over its subdomain
   *  (exception-less.md A1).  Populated by `enrichLoomModel`; the route
   *  translator reads `errorStatusOverrides?.[name] ?? defaultErrorStatus(name)`.
   *  Undefined in single-context (no-api) lowering — defaults apply. */
  errorStatusOverrides?: Record<string, number>;
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
export interface ViewIR {
  name: string;
  /** Source aggregate.  Must live in the same context as the
   *  view declaration. */
  aggregateName: string;
  /** Queryable predicate.  Required by the shorthand grammar;
   *  optional in the full form.  Subject to the same restrictions
   *  as repository find filters. */
  filter?: ExprIR;
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
   *  the workflow declares none.  Not yet consumed by backends — backend
   *  emission and the `by` correlation-field type-check are deferred to later
   *  slices, mirroring how Phase A1 landed `apply(...)` appliers ahead of any
   *  event-store emission. */
  subscriptions?: OnIR[];
  /** Workflow state fields declared as `Property` members — the correlation
   *  field plus saga state (workflow-and-applier.md A2-S2).  Lowered with the
   *  same `lowerField` as aggregate fields.  Omitted when the workflow
   *  declares none.  Not yet emitted by backends (a persisted workflow row is
   *  a later slice). */
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

export type WorkflowStmtIR =
  | { kind: "precondition"; expr: ExprIR; source: string }
  | { kind: "requires"; expr: ExprIR; source: string }
  | {
      kind: "emit";
      eventName: string;
      fields: { name: string; value: ExprIR }[];
    }
  | {
      kind: "factory-let";
      name: string;
      aggName: string;
      fields: { name: string; value: ExprIR }[];
    }
  | {
      kind: "repo-let";
      name: string;
      repoName: string;
      aggName: string;
      method: string;
      args: ExprIR[];
      returnType: TypeIR;
    }
  | {
      kind: "expr-let";
      name: string;
      type: TypeIR;
      expr: ExprIR;
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
      /** Element aggregate array type `{ kind: "array", element: entity }`. */
      returnType: TypeIR;
    }
  | {
      kind: "op-call";
      target: string;
      aggName: string;
      op: string;
      args: ExprIR[];
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
    }
  | {
      // A bare (unbound) resource-op call statement — `files.put(k, v)`
      // (Phase 4).  The `let`-bound form (`let x = files.get(k)`) rides
      // `expr-let` instead.  `call` is the lowered `resource-op` call IR.
      kind: "resource-call";
      call: ExprIR;
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
}

// ---------------------------------------------------------------------------
// Branded phase types — distinguish the IR shape at two pipeline points.
//
//   `RawLoomModel`      — the structural output of `lowerModel`.  Optional
//                         derivation fields (`wireShape`, `associations`,
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
// `EnrichedAggregateIR` / `EnrichedEntityPartIR` / `EnrichedValueObjectIR`
// are required-field overlays that mirror the structural types.  An
// `EnrichedLoomModel` walks down to these via the matching enriched
// context / module / system shells so a generator that takes an
// `EnrichedLoomModel` and reads `agg.wireShape` sees a `readonly
// WireField[]`, no `| undefined`.
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
  /** Always populated by `enrichLoomModel`. */
  wireShape: WireField[];
  /** Always populated by `enrichLoomModel` (empty when none derived). */
  associations: AssociationIR[];
  /** Always populated by `enrichLoomModel` (empty when the aggregate has
   * no client-suppliable create fields). */
  createInput: CreateInputFieldIR[];
  parts: EnrichedEntityPartIR[];
};

export type EnrichedEntityPartIR = EntityPartIR & {
  wireShape: WireField[];
};

export type EnrichedValueObjectIR = ValueObjectIR & {
  wireShape: WireField[];
};

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
  | "rabbitmq"
  | "restApi";

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
  /** Optional ui-level menu block.  When undefined the sidebar is
   *  derived from each page's `menuMeta` (see spec §11). */
  menu?: MenuBlockIR;
  /** UI api parameters.  Each entry maps a local handle name (used in
   *  page bodies as `<handle>.<aggregate>.<op>`) to an api the system
   *  declares.  Composition is supplied by the deployable that
   *  deploys this UI. */
  apiParams: UiApiParamIR[];
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
  /** Per-error HTTP status overrides declared via `httpStatus <Error> <Code>`
   *  in the api block (exception-less.md A1).  Keyed by error-payload name; an
   *  error absent here falls back to the stdlib default
   *  (`src/util/error-defaults.ts`).  Empty when the api declares none. */
  errorStatuses: Record<string, number>;
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
   *  written in source; pages synthesised by the scaffold expander
   *  populate this from the rewrite rule. */
  route?: string;
  /** Optional title expression.  May interpolate state / data refs. */
  title?: ExprIR;
  /** Auth gate, same syntax as on operations. */
  requires?: ExprIR;
  /** Reactive local fields.  Multiple `state { }` blocks merge here
   *  (matches the `permissions` block multiplicity rule). */
  state: StateFieldIR[];
  /** Single body expression.  Conditional rendering uses `match` in
   *  the expression engine, not a guarded-declaration form. */
  body?: ExprIR;
  /** Per-page menu metadata.  Read by the menu emitter when
   *  no explicit ui-level menu block is declared. */
  menuMeta?: MenuMetaIR;
  /** Provenance discriminator: `"explicit"` for pages
   *  written in source; `"scaffold"` for pages synthesised by the
   *  expander.  The page emitter uses this to fast-path the legacy
   *  per-aggregate / per-workflow / per-view builders for the bulk-
   *  scaffold case (byte-equivalence target). */
  source: "explicit" | "scaffold";
  /** Only set for scaffold-synthesised pages.  Carries the structural
   *  shape of the page so the page emitter can dispatch without
   *  re-parsing the body expression.  Same source context the legacy
   *  generator's per-aggregate / per-workflow / per-view loop
   *  received. */
  origin?: PageOriginIR;
  /** Explicit emit path override for walker-rendered
   *  pages.  When set, the page-emitter writes the rendered TSX to
   *  this path instead of the default `src/pages/<page-snake>.tsx`.
   *  Populated during lowering so a scaffold-emitted page lands at
   *  its conventional path (`src/pages/<plural>/list.tsx` for an
   *  `aggregate-list` origin, etc.) — preserves URL/file shape. */
  emitPath?: string;
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
export type PageOriginIR =
  | { kind: "aggregate-list"; aggregateName: string; contextName: string }
  | { kind: "aggregate-new"; aggregateName: string; contextName: string }
  | { kind: "aggregate-detail"; aggregateName: string; contextName: string }
  | { kind: "workflow-form"; workflowName: string; contextName: string }
  | { kind: "view-list"; viewName: string; contextName: string }
  | { kind: "workflows-index" }
  | { kind: "views-index" }
  | { kind: "home" }
  | { kind: "custom" };

/** A user-defined component: typed function from params (and optional
 *  local state) to a body expression.  Components compose other
 *  components but never produce pages or routes. */
export interface ComponentIR {
  name: string;
  params: ParamIR[];
  state: StateFieldIR[];
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
}

export type DataSourceKind =
  | "state"
  | "eventLog"
  | "snapshot"
  | "cache"
  | "replica"
  | "objectStore"
  | "queue"
  | "api";

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
// `phoenixLiveView` is the fullstack Elixir/Ash + Phoenix LiveView
// platform: a single deployable serves an Ash-derived API AND mounts
// a `ui:` whose pages render as LiveView modules against the
// `ashPhoenix` HEEx pack.  Unlike `react`/`static` it owns its own
// database (`needsDb: true`) and never declares `targets:` —
// validator enforces both.
export type Platform = "dotnet" | "node" | "react" | "static" | "phoenix";

// The `application:`/`shape(…)` platform-axes lookups
// (`applicationDslToAdapter`, `applicationAdapterToDsl`,
// `PLATFORM_SAVING_SHAPES`) live in `src/util/platform-axes.ts` so the
// language validators may consume them without a backward `language → ir`
// value edge.  They type-depend on `Platform` / `SavingShape` here.

export interface DeployableIR {
  name: string;
  /** The platform **family** (`"node"`, `"dotnet"`, `"react"`, …) —
   *  the closed union every downstream consumer branches on.  A
   *  `family@version` pin in the source is normalised here to its
   *  family so `platform === "node"` etc. stay valid. */
  platform: Platform;
  /** The fully-qualified backend ref (`"hono@v4"`) after lowering,
   *  mirroring `design?`.  Bareword `platform: hono` resolves through
   *  `BUILTIN_PLATFORM_LATEST`; a pin (`platform: "hono@v4"`) flows
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
  /** HTTP port the deployable's web server listens on. */
  port: number;
  /** Backend deployable this frontend talks to.  Set only when
   * platform === "react"; the frontend's API base URL is derived from
   * the target's port. */
  targetName?: string;
  /** Design-system template pack the React frontend generator renders
   *  pages against.  Built-ins: "mantine", "chakra", "mui", "shadcn",
   *  "ashPhoenix".  A string starting with "./" or "/" is a custom
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
   *  This PR is DSL-surface-only: the fields are carried through lowering
   *  and validated, but no generator consumes them yet.
   *
   *  `application`/`directoryLayout` map onto the existing
   *  D-ADAPTER-HOME adapter kinds `style`/`layout`; `persistence` onto
   *  the `persistence` adapter; `foundation`/`transport`/`runtime` are
   *  greenfield (no adapter infra yet, single default value each). */
  foundation?: string;
  application?: string;
  persistence?: string;
  directoryLayout?: string;
  transport?: string;
  runtime?: string;
  /** Per-deployable auth opt-in.  Populated when the source declares
   *  `auth: required` on the deployable.  Backends with
   *  `auth.required === true` emit JWT-decode middleware + a verifier
   *  hook the user implements; deployables without this stay open
   *  (existing behaviour). */
  auth?: { required: boolean };
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
  | { kind: "precondition"; expr: ExprIR; source: string }
  | { kind: "requires"; expr: ExprIR; source: string }
  | { kind: "let"; name: string; expr: ExprIR; type: TypeIR }
  | { kind: "assign"; target: PathIR; value: ExprIR; targetType: TypeIR; prov?: ProvSite }
  | { kind: "add"; target: PathIR; value: ExprIR; elementType: TypeIR; prov?: ProvSite }
  | { kind: "remove"; target: PathIR; value: ExprIR; elementType: TypeIR; prov?: ProvSite }
  | {
      kind: "emit";
      eventName: string;
      fields: { name: string; value: ExprIR }[];
    }
  | {
      kind: "call";
      target: "function" | "private-operation";
      name: string;
      args: ExprIR[];
    }
  /**
   * Bare expression-statement.  Used when a chained call like
   * `a.b.c(args)` appears as an operation- or test-body statement.
   * Renderers emit `<expr>;` (TS / e2e) or `<expr>;` (C#).
   */
  | { kind: "expression"; expr: ExprIR }
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
  | "enum-value"
  | "current-user" // magic identifier — system's `user` block shape
  | "resource" // ambient resource handle — `files`, `jobs`, … (Phase 4)
  | "unknown";

export type CallKind =
  | "function" // calls a `function` declared in scope
  | "value-object-ctor" // calls a value-object constructor
  | "private-operation" // calls a private operation
  | "resource-op" // a verb call on an ambient resource handle (Phase 4)
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

export type ExprIR =
  | { kind: "literal"; lit: LiteralKind; value: string }
  | { kind: "this" }
  | { kind: "id" }
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
    }
  | {
      kind: "member";
      receiver: ExprIR;
      member: string;
      receiverType: TypeIR;
      memberType: TypeIR;
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
    }
  | {
      kind: "call";
      callKind: CallKind;
      name: string;
      args: ExprIR[];
      /** Same shape as `method-call.argNames` — see above. */
      argNames?: (string | undefined)[];
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
      /** Per-primitive `style:` escape hatch.  Populated by lowering
       *  when the source supplied a `style: { … }` named arg on a
       *  walker-primitive call (`Container { style: { background: "red" }, ... }`).
       *  The named arg is hoisted out of `args`/`argNames` into this
       *  field.  React emits `style={{...}}`; Phoenix emits `style="..."`.
       *  Use the ordered `entries` shape (not a `Record`) so entry order
       *  survives the IR pipeline. */
      style?: StyleIR;
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
    }
  | {
      kind: "new";
      partName: string;
      fields: { name: string; value: ExprIR }[];
    }
  | {
      kind: "object";
      fields: { name: string; value: ExprIR }[];
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
    }
  | { kind: "paren"; inner: ExprIR }
  | { kind: "unary"; op: "-" | "!"; operand: ExprIR }
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
      /** Type of the binary expression as a whole — comparison/logical
       *  ops are `bool`; arithmetic ops follow the type-system's
       *  closed-money and numeric-widening rules.  Same population
       *  policy as `leftType`. */
      resultType?: TypeIR;
    }
  | { kind: "ternary"; cond: ExprIR; then: ExprIR; otherwise: ExprIR }
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
  | { kind: "convert"; target: PrimitiveName; from: PrimitiveName | undefined; value: ExprIR }
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
      arms: { cond: ExprIR; value: ExprIR }[];
      otherwise?: ExprIR;
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
  if (!e) return false;
  if (e.kind === "ref" && e.refKind === "current-user") return true;
  switch (e.kind) {
    case "method-call":
      if (exprUsesCurrentUser(e.receiver)) return true;
      return e.args.some(exprUsesCurrentUser);
    case "member":
      return exprUsesCurrentUser(e.receiver);
    case "binary":
      return exprUsesCurrentUser(e.left) || exprUsesCurrentUser(e.right);
    case "ternary":
      return (
        exprUsesCurrentUser(e.cond) ||
        exprUsesCurrentUser(e.then) ||
        exprUsesCurrentUser(e.otherwise)
      );
    case "unary":
      return exprUsesCurrentUser(e.operand);
    case "paren":
      return exprUsesCurrentUser(e.inner);
    case "call":
      return e.args.some(exprUsesCurrentUser);
    case "lambda":
      return exprUsesCurrentUser(e.body);
    case "new":
    case "object":
      return e.fields.some((f) => exprUsesCurrentUser(f.value));
  }
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
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "expr-let":
      return exprUsesCurrentUser(s.expr);
    case "emit":
    case "factory-let":
      return s.fields.some((f) => exprUsesCurrentUser(f.value));
    case "repo-let":
    case "op-call":
      return s.args.some(exprUsesCurrentUser);
    case "repo-run":
      return (
        s.retrievalArgs.some(exprUsesCurrentUser) ||
        (s.page?.offset ? exprUsesCurrentUser(s.page.offset) : false) ||
        (s.page?.limit ? exprUsesCurrentUser(s.page.limit) : false)
      );
    case "for-each":
      return exprUsesCurrentUser(s.iterable) || s.body.some(workflowStmtUsesCurrentUser);
    case "resource-call":
      return exprUsesCurrentUser(s.call);
  }
}

/** True when the find's `where` filter references `currentUser`.
 *  Such finds gain a `currentUser: User` parameter on the generated
 *  repository method, threaded through CQRS handler / Hono route call
 *  sites. */
export function findUsesCurrentUser(find: FindIR): boolean {
  return exprUsesCurrentUser(find.filter);
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

function stmtUsesCurrentUser(s: StmtIR): boolean {
  switch (s.kind) {
    case "precondition":
    case "requires":
      return exprUsesCurrentUser(s.expr);
    case "let":
      return exprUsesCurrentUser(s.expr);
    case "assign":
    case "add":
    case "remove":
    case "return":
      return exprUsesCurrentUser(s.value);
    case "emit":
      return s.fields.some((f) => exprUsesCurrentUser(f.value));
    case "call":
      return s.args.some(exprUsesCurrentUser);
    case "expression":
      return exprUsesCurrentUser(s.expr);
  }
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
  }
}

function partUsesMoney(p: EntityPartIR): boolean {
  if (p.fields.some((f) => typeUsesMoney(f.type))) return true;
  if (p.derived.some((d) => typeUsesMoney(d.type) || exprUsesMoney(d.expr))) return true;
  if (p.invariants.some((iv) => exprUsesMoney(iv.expr))) return true;
  if (p.functions.some((fn) => typeUsesMoney(fn.returnType) || exprUsesMoney(fn.body))) return true;
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
  if (a.functions.some((fn) => typeUsesMoney(fn.returnType) || exprUsesMoney(fn.body))) return true;
  if (a.parts.some(partUsesMoney)) return true;
  return false;
}

/** True when the value object's wire shape carries any money field. */
export function valueObjectUsesMoney(vo: ValueObjectIR): boolean {
  if (vo.fields.some((f) => typeUsesMoney(f.type))) return true;
  if (vo.derived.some((d) => typeUsesMoney(d.type) || exprUsesMoney(d.expr))) return true;
  if (vo.invariants.some((iv) => exprUsesMoney(iv.expr))) return true;
  if (vo.functions.some((fn) => typeUsesMoney(fn.returnType) || exprUsesMoney(fn.body)))
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
