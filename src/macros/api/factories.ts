// AST node factories for macro authors.
//
// Every factory:
//   - Constructs a well-formed AST node matching the Langium
//     production for that kind.
//   - Wires `$container`/`$containerProperty`/`$containerIndex` on
//     child nodes (the expander will set the outer node's container
//     when it splices the result into the host).
//   - Tags the produced node with an `$origin` token derived from
//     the active macro call site, so validator diagnostics on the
//     synthesised node can be rendered against the user's source.
//
// Authors never construct AST nodes by hand.  If a node shape isn't
// here, add a factory — the surface is intentionally narrow.

import type {
  Aggregate,
  AggregateMember,
  AssignOrCallStmt,
  CallArg,
  CommandHandler,
  ContextMember,
  Create,
  Destroy,
  EntityPartMember,
  Expression,
  FieldAccess,
  HandlerRef,
  HttpMethod,
  IdType,
  LetStmt,
  LValue,
  MemberSuffix,
  NamedDecl,
  NamedType,
  NameRef,
  ObjectFieldInit,
  ObjectLit,
  Operation,
  Parameter,
  PayloadDecl,
  PayloadKind,
  PostfixChain,
  PrimitiveType,
  Property,
  QueryHandler,
  ReturnStmt,
  Route,
  SelfType,
  Statement,
  TypeRef,
  UnaryExpr,
} from "../../language/generated/ast.js";
import {
  isContainment,
  isDerivedProp,
  isProperty,
  isStampDecl,
  isSubdomain,
} from "../../language/generated/ast.js";
import {
  mkAssignOrCallStmt,
  mkCallArg,
  mkCommandHandler,
  mkCreate,
  mkDestroy,
  mkFilterDecl,
  mkHandlerRef,
  mkIdType,
  mkImplementsDecl,
  mkLetStmt,
  mkLValue,
  mkMemberSuffix,
  mkNamedType,
  mkNameRef,
  mkNullLit,
  mkObjectFieldInit,
  mkObjectLit,
  mkOperation,
  mkParameter,
  mkPayloadDecl,
  mkPostfixChain,
  mkPrimitiveType,
  mkProperty,
  mkQueryHandler,
  mkReturnStmt,
  mkRoute,
  mkSelfType,
  mkStampDecl,
  mkThisRef,
  mkTypeRef,
  mkUnaryExpr,
} from "./_mk.js";
import type { OriginToken } from "./define.js";
import {
  _currentOrigin,
  _setContainer,
  _tag,
  _withOrigin as _withOriginInternal,
  ORIGIN_PROP as ORIGIN_PROP_INTERNAL,
  originOf as originOfInternal,
} from "./factories-internals.js";

// ---------------------------------------------------------------------------
// Origin tagging — implementation lives in `factories-internals.ts`
// so the active-origin slot is a single shared cell across both this
// file and `ui-factories.ts`.  These re-exports keep the old import
// paths working (`originOf`, `ORIGIN_PROP`, `_withOrigin` are all
// already-public surface).
// ---------------------------------------------------------------------------

export const ORIGIN_PROP = ORIGIN_PROP_INTERNAL;
export const originOf = originOfInternal;
export const _withOrigin = _withOriginInternal;

const currentOrigin = _currentOrigin;
const tag = _tag;
const setContainer = _setContainer;

// ---------------------------------------------------------------------------
// Type-reference factories
// ---------------------------------------------------------------------------

/** A primitive type reference: `string`, `int`, `datetime`, etc.
 * Wraps the primitive in a `TypeRef` envelope as the parser does. */
export function primType(
  name: "bool" | "datetime" | "decimal" | "guid" | "int" | "long" | "money" | "string",
  opts: { array?: boolean; optional?: boolean } = {},
): TypeRef {
  const origin = currentOrigin();
  const prim: PrimitiveType = tag(mkPrimitiveType({ $type: "PrimitiveType", name }), origin);
  const ref: TypeRef = tag(
    mkTypeRef({
      $type: "TypeRef",
      base: prim,
      ctors: [],
      alternatives: [],
      array: opts.array ?? false,
      optional: opts.optional ?? false,
    }),
    origin,
  );
  setContainer(prim, ref, "base");
  return ref;
}

/** An `Id<Target>` type reference.  `targetName` resolves through
 * Langium's standard cross-reference machinery once linked. */
export function idRef(
  targetName: string,
  opts: { array?: boolean; optional?: boolean } = {},
): TypeRef {
  const origin = currentOrigin();
  const idType: IdType = tag(
    mkIdType({
      $type: "IdType",
      target: makeRef<NamedDecl>(targetName),
    }),
    origin,
  );
  const ref: TypeRef = tag(
    mkTypeRef({
      $type: "TypeRef",
      base: idType,
      ctors: [],
      alternatives: [],
      array: opts.array ?? false,
      optional: opts.optional ?? false,
    }),
    origin,
  );
  setContainer(idType, ref, "base");
  return ref;
}

/** A `Self id` type reference — the anchored self-type
 * (typed-capabilities.md): inside a capability it denotes an id-ref to
 * whatever aggregate carries the capability.  The macro expander's
 * `resolveSelfTypes` rewrites the `SelfType` base to the host aggregate's
 * `IdType` at splice time (`src/macros/expander.ts`), so a capability field
 * `parent: Self id?` becomes `parent: <Host> id?` — a self-FK.  Only
 * meaningful in a capability body; a `Self` elsewhere is
 * `loom.self-outside-capability`. */
export function selfRef(opts: { array?: boolean; optional?: boolean } = {}): TypeRef {
  const origin = currentOrigin();
  const self: SelfType = tag(mkSelfType({ $type: "SelfType", selfRef: true }), origin);
  const ref: TypeRef = tag(
    mkTypeRef({
      $type: "TypeRef",
      base: self,
      ctors: [],
      alternatives: [],
      array: opts.array ?? false,
      optional: opts.optional ?? false,
    }),
    origin,
  );
  setContainer(self, ref, "base");
  return ref;
}

/** A bare named-type reference: `Money`, `OrderStatus`.  Pass `paged: true`
 * for the ML-postfix generic instantiation `<Name> paged` — the wire carrier
 * `scaffoldPaged`'s queryHandler declares as its return (`Order paged`), a
 * `TypeRef` with a single `paged` `GenericCtor`. */
export function namedType(
  targetName: string,
  opts: { array?: boolean; optional?: boolean; paged?: boolean } = {},
): TypeRef {
  const origin = currentOrigin();
  const nt: NamedType = tag(
    mkNamedType({ $type: "NamedType", target: makeRef<NamedDecl>(targetName) }),
    origin,
  );
  const ref: TypeRef = tag(
    mkTypeRef({
      $type: "TypeRef",
      base: nt,
      ctors: opts.paged ? ["paged"] : [],
      alternatives: [],
      array: opts.array ?? false,
      optional: opts.optional ?? false,
    }),
    origin,
  );
  setContainer(nt, ref, "base");
  return ref;
}

// ---------------------------------------------------------------------------
// Aggregate-member factories
// ---------------------------------------------------------------------------

/** A property declaration on an aggregate, entity part, value
 * object, etc.  Lives inside the aggregate body once the expander
 * splices it in.
 *
 * `opts.access` sets the field's role for input-shaping and view/API
 * exposure (see `FieldAccess` in `src/language/ddd.langium` and the
 * resolution rules in `src/ir/enrich/enrichments.ts`).  Trait macros that
 * contribute server-owned fields should set this — e.g. `auditable`
 * passes `access: "managed"` for `createdAt`/`updatedAt`; `softDeletable`
 * passes `access: "internal"` for `isDeleted`. */
export function field(
  name: string,
  type: TypeRef,
  opts: { provenanced?: boolean; access?: FieldAccess; default?: Expression } = {},
): Property {
  const origin = currentOrigin();
  const prop: Property = tag(
    mkProperty({
      $type: "Property",
      name,
      type,
      provenanced: opts.provenanced ?? false,
      ...(opts.access ? { access: opts.access } : {}),
      ...(opts.default ? { default: opts.default } : {}),
    }),
    origin,
  );
  setContainer(type, prop, "type");
  // `field: T = <expr>` — wire the default expression's container triple so
  // Langium scope computation and lowering (`lower-members.ts` reads
  // `p.default`) see a well-formed subtree.
  if (opts.default) setContainer(opts.default, prop, "default");
  return prop;
}

/** A parameter on an operation. */
export function param(name: string, type: TypeRef): Parameter {
  const origin = currentOrigin();
  const p: Parameter = tag(mkParameter({ $type: "Parameter", name, type }), origin);
  setContainer(type, p, "type");
  return p;
}

/** An operation declaration.  `body` is a (possibly empty) array
 * of statements.  Trait macros that only need to declare operations
 * pass `body: []`; statement-building factories live alongside
 * `operation(...)` for macros that synthesise bodies. */
export function operation(
  name: string,
  params: Parameter[],
  body: Statement[],
  opts: { private?: boolean; extern?: boolean; audited?: boolean } = {},
): Operation {
  const origin = currentOrigin();
  const op: Operation = tag(
    mkOperation({
      $type: "Operation",
      name,
      params,
      body,
      private: opts.private ?? false,
      extern: opts.extern ?? false,
      audited: opts.audited ?? false,
    }),
    origin,
  );
  params.forEach((p, i) => {
    setContainer(p, op, "params", i);
  });
  body.forEach((s, i) => {
    setContainer(s, op, "body", i);
  });
  return op;
}

/** A `create` lifecycle factory action.  Omit `name` for the
 * canonical (unnamed) create — the one that lowers to the bare
 * `POST /collection` route; pass a name for a secondary factory
 * (`create place(...)` → `POST /collection/place`).  Mirrors
 * `operation()` but builds a `Create` AST node. */
export function create(
  params: Parameter[],
  body: Statement[],
  opts: { name?: string; audited?: boolean } = {},
): Create {
  const origin = currentOrigin();
  const node: Create = tag(
    mkCreate({ $type: "Create", name: opts.name, params, body, audited: opts.audited ?? false }),
    origin,
  );
  params.forEach((p, i) => {
    setContainer(p, node, "params", i);
  });
  body.forEach((s, i) => {
    setContainer(s, node, "body", i);
  });
  return node;
}

/** A `destroy` lifecycle terminator action.  Omit `name` for the
 * canonical destroy (`DELETE /collection/{id}`); the empty-body
 * form is the conventional hard delete — the backend wires the
 * actual removal.  Mirrors `operation()` but builds a `Destroy`
 * AST node. */
export function destroy(
  body: Statement[] = [],
  opts: { name?: string; params?: Parameter[]; audited?: boolean } = {},
): Destroy {
  const origin = currentOrigin();
  const params = opts.params ?? [];
  const node: Destroy = tag(
    mkDestroy({ $type: "Destroy", name: opts.name, params, body, audited: opts.audited ?? false }),
    origin,
  );
  params.forEach((p, i) => {
    setContainer(p, node, "params", i);
  });
  body.forEach((s, i) => {
    setContainer(s, node, "body", i);
  });
  return node;
}

// ---------------------------------------------------------------------------
// Expression + statement factories
// ---------------------------------------------------------------------------
//
// Macro authors construct operation bodies as arrays of Statement
// AST nodes.  The factory set is intentionally narrow: only the
// shapes the stdlib macros (crudish first) actually need.  When a
// new macro needs a new statement/expression kind, add a focused
// factory here rather than letting authors construct nodes by hand
// — that's the only way origin metadata stays consistent across
// the synthesised subtree.

/** A bare `name` reference in an expression position.  Lowering
 * resolves it against the host's scope (params, fields, etc.)
 * just like a user-typed identifier. */
export function nameRef(name: string): NameRef {
  const origin = currentOrigin();
  return tag(mkNameRef({ $type: "NameRef", name }), origin);
}

/** A dotted member-access expression: `receiver.member`.  Used by
 * crudish to build `input.subject` from `input` + "subject".  `args`
 * is the empty array (no call) for property access; pass `call: true`
 * + args to construct a method invocation.
 *
 * Post grammar-flatten this emits a `PostfixChain` whose head is the
 * receiver and whose single suffix is a `MemberSuffix` carrying the
 * member name (and the optional call payload). */
export function memberAccess(
  receiver: Expression,
  member: string,
  opts: { call?: boolean; args?: Expression[] } = {},
): PostfixChain {
  const origin = currentOrigin();
  const args = opts.args ?? [];
  const callArgs: CallArg[] = args.map((a) => {
    const node = tag(mkCallArg({ $type: "CallArg", value: a }), origin);
    setContainer(a, node, "value");
    return node;
  });
  const suffix: MemberSuffix = tag(
    mkMemberSuffix({
      $type: "MemberSuffix",
      member,
      call: opts.call ?? false,
      args: callArgs,
    }),
    origin,
  );
  callArgs.forEach((c, i) => {
    setContainer(c, suffix, "args", i);
  });
  const chain: PostfixChain = tag(
    mkPostfixChain({
      $type: "PostfixChain",
      head: receiver,
      suffixes: [suffix],
      bypass: [],
      bypassAll: false,
    }),
    origin,
  );
  setContainer(receiver, chain, "head");
  setContainer(suffix, chain, "suffixes", 0);
  return chain;
}

/** An assignment statement: `target := value`.  `target` is a flat
 * dotted lvalue head (e.g. `subject` or `this.subject`); pass tail
 * segments via `parts` when the assignment is to a nested member.
 * `value` may be any Expression. */
export function assignStmt(targetName: string, value: Expression): AssignOrCallStmt {
  return assignStmtPath([targetName], value);
}

/** An assignment to a dotted path: `head.tail1.tail2 := value`. */
export function assignStmtPath(path: string[], value: Expression): AssignOrCallStmt {
  if (path.length === 0) throw new Error("assignStmtPath requires at least one segment");
  const origin = currentOrigin();
  const lv: LValue = tag(
    mkLValue({
      $type: "LValue",
      head: path[0]!,
      tail: path.slice(1),
      call: false,
      args: [],
    }),
    origin,
  );
  const stmt: AssignOrCallStmt = tag(
    mkAssignOrCallStmt({
      $type: "AssignOrCallStmt",
      target: lv,
      op: ":=",
      value,
    }),
    origin,
  );
  setContainer(lv, stmt, "target");
  setContainer(value, stmt, "value");
  return stmt;
}

/** A bare method-call statement: `head.tail1.tail2(args)`.  Unlike
 * `assignStmt`, this sets the LValue's `call` flag and carries argument
 * expressions — the statement is an invocation, not an assignment (grammar
 * `AssignOrCallStmt` with no mutation suffix).  Used to emit the op-call in a
 * generated `commandHandler` body (`o.cancel()`). */
export function callStmt(path: string[], args: Expression[] = []): AssignOrCallStmt {
  if (path.length === 0) throw new Error("callStmt requires at least one path segment");
  const origin = currentOrigin();
  const lv: LValue = tag(
    mkLValue({
      $type: "LValue",
      head: path[0]!,
      tail: path.slice(1),
      call: true,
      args,
    }),
    origin,
  );
  args.forEach((a, i) => {
    setContainer(a, lv, "args", i);
  });
  const stmt: AssignOrCallStmt = tag(
    mkAssignOrCallStmt({ $type: "AssignOrCallStmt", target: lv }),
    origin,
  );
  setContainer(lv, stmt, "target");
  return stmt;
}

/** A `let <name> = <expr>` binding statement.  `name` binds in the rest of
 * the enclosing body's scope (grammar `LetStmt`).  Used to load an aggregate
 * in a generated handler body (`let o = Orders.getById(orderId)`). */
export function letStmt(name: string, expr: Expression): LetStmt {
  const origin = currentOrigin();
  const stmt: LetStmt = tag(mkLetStmt({ $type: "LetStmt", name, expr }), origin);
  setContainer(expr, stmt, "expr");
  return stmt;
}

/** A `return <expr>` statement (grammar `ReturnStmt`) — an operation /
 * handler's designed-in outcome. */
export function returnStmt(value: Expression): ReturnStmt {
  const origin = currentOrigin();
  const stmt: ReturnStmt = tag(mkReturnStmt({ $type: "ReturnStmt", value }), origin);
  setContainer(value, stmt, "value");
  return stmt;
}

// ---------------------------------------------------------------------------
// Application- + transport-layer factories — the `commandHandler` context
// member and the `route <METHOD> <PATH> -> Context.Handler` api binding
// (unfoldable-api-derivation.md, Layers 3-4).  Emitted by the `scaffoldHandlers`
// (context-targeted) and `scaffoldApi` (api-targeted) stdlib macros.
// ---------------------------------------------------------------------------

/** An application-layer `commandHandler <name>(params) { body }` context member.
 * Mirrors `operation()` but builds a `CommandHandler` AST node (a top-level
 * context member, not an aggregate member).  `returnType` is omitted for the
 * common destroy-style / void handler. */
export function commandHandler(
  name: string,
  params: Parameter[],
  body: Statement[],
  opts: { returnType?: TypeRef } = {},
): CommandHandler & ContextMember {
  const origin = currentOrigin();
  const node: CommandHandler = tag(
    mkCommandHandler({
      $type: "CommandHandler",
      name,
      extern: false,
      params,
      body,
      ...(opts.returnType ? { returnType: opts.returnType } : {}),
    }),
    origin,
  );
  params.forEach((p, i) => {
    setContainer(p, node, "params", i);
  });
  body.forEach((s, i) => {
    setContainer(s, node, "body", i);
  });
  if (opts.returnType) setContainer(opts.returnType, node, "returnType");
  return node as CommandHandler & ContextMember;
}

/** An application-layer `queryHandler <name>(params): T { body }` context member.
 * The read-side twin of `commandHandler()` — grammar `QueryHandler` requires a
 * `returnType` (a query always produces a response), so it is not optional here.
 * Emitted by `scaffoldHandlers` for each aggregate `find` (and the canonical
 * get-by-id read). */
export function queryHandler(
  name: string,
  params: Parameter[],
  returnType: TypeRef,
  body: Statement[],
): QueryHandler & ContextMember {
  const origin = currentOrigin();
  const node: QueryHandler = tag(
    mkQueryHandler({ $type: "QueryHandler", name, extern: false, params, returnType, body }),
    origin,
  );
  params.forEach((p, i) => {
    setContainer(p, node, "params", i);
  });
  body.forEach((s, i) => {
    setContainer(s, node, "body", i);
  });
  setContainer(returnType, node, "returnType");
  return node as QueryHandler & ContextMember;
}

// ---------------------------------------------------------------------------
// Contract-record factories — `payload` / `response` / `command` / `query`
// PayloadDecl context members (M-T5.10, contract layer / payload-transport-
// layer.md P1).  Each is a flat record (`kind=<keyword> name '{' fields '}'`)
// the printer ejects verbatim, so `scaffoldHandlers` can splice a
// source-visible API contract alongside its handlers.  A `PayloadDecl`'s
// `$container` is `BoundedContext | Model`, so it splices as a context member
// exactly like `commandHandler` / `queryHandler`.
// ---------------------------------------------------------------------------

/** Build a flat-record `PayloadDecl` of the given `kind` from a field list.
 * The record form (no `variants`) — the P1 flat-field shape; the printer's
 * `printPayloadDecl` renders it as `<kind> <Name> { <fields> }`. */
function payloadDecl(
  kind: PayloadKind,
  name: string,
  fields: Property[],
): PayloadDecl & ContextMember {
  const origin = currentOrigin();
  const node: PayloadDecl = tag(
    mkPayloadDecl({ $type: "PayloadDecl", kind, name, fields, variants: [] }),
    origin,
  );
  fields.forEach((f, i) => {
    setContainer(f, node, "fields", i);
  });
  return node as PayloadDecl & ContextMember;
}

/** A `payload <Name> { … }` record — the umbrella carrier kind. */
export function payload(name: string, fields: Property[]): PayloadDecl & ContextMember {
  return payloadDecl("payload", name, fields);
}

/** A `response <Name> { … }` record — an API read-projection contract
 * (the `<Agg>Response` shape `scaffoldResponse` derives via `apiReadFields`). */
export function response(name: string, fields: Property[]): PayloadDecl & ContextMember {
  return payloadDecl("response", name, fields);
}

/** A `command <Name> { … }` record — a write-request contract (the
 * create/operation input shape a `commandHandler` will later reference). */
export function command(name: string, fields: Property[]): PayloadDecl & ContextMember {
  return payloadDecl("command", name, fields);
}

/** A `query <Name> { … }` record — a read-request contract (the find /
 * get-by-id parameter shape a `queryHandler` will later reference). */
export function query(name: string, fields: Property[]): PayloadDecl & ContextMember {
  return payloadDecl("query", name, fields);
}

/** Rebuild a source field / param / return `TypeRef` as a fresh, macro-tagged
 * type.  The same factory-based reconstruction `scaffoldHandlers.cloneType`
 * uses: a hand-rolled `mk*` ref never re-links and silently lowers to `string`,
 * so a type of `Money` / `OrderStatus` / `X id` / `Order[]` must be rebuilt
 * through the `primType` / `idRef` / `namedType` factories to keep its resolved
 * type after splicing. */
export function cloneTypeRef(t: TypeRef): TypeRef {
  const opts = { array: !!t.array, optional: !!t.optional };
  const b = t.base;
  if (b.$type === "PrimitiveType") {
    return primType(b.name as Parameters<typeof primType>[0], opts);
  }
  if (b.$type === "IdType") {
    return idRef(b.target.$refText, opts);
  }
  return namedType((b as { target: { $refText: string } }).target.$refText, opts);
}

/** The AST twin of the IR wire-projection `forApiRead(wireShape)`
 * (`src/ir/enrich/wire-projection.ts` + `wireFieldsForAggregate` in
 * `enrichments.ts`): the ordered field list an aggregate's `<Agg>Response`
 * read-projection carries.  Returns, IN wire order:
 *
 *   1. the aggregate's `Property` members whose `access` is NOT `internal`
 *      and NOT `secret` (editable / immutable / managed / token stay) — the
 *      `forApiRead` matrix.  Unlike `writableCreateFields`, the origin-tag and
 *      stamp-target exclusions are NOT applied: apiRead keeps the macro-added
 *      managed/token fields (`createdAt`, `version`), exactly as wire shape
 *      does.  `tenantOwned`'s `dataKey` is `internal`, so the access filter
 *      already drops it — no special carve-out.
 *   2. one synthesized field per `Containment`, typed `<Part>Response` (the
 *      sibling record `scaffoldResponse` emits for the same part), array/optional
 *      matching the containment (`optional` only when single, never a collection).
 *   3. one synthesized field per non-`inspect` `DerivedProp` (name + cloned type).
 *
 * NO `id` field is emitted (grammar-reserved as a `Property` name; the wire
 * shape's synthetic `id` row has no source-record analogue).  Each returned
 * field is a fresh `field(...)` node (not the aggregate's own `Property`, which
 * `setContainer` would reparent) carrying name + type only — a response record
 * is name+type, exactly what the wire shape is. */
export function apiReadFields(agg: Aggregate): readonly Property[] {
  // Default-on `versioned` (M-T3.4) is spliced onto the aggregate LATER in the
  // walk (`expandModel` visits this context's `scaffoldHandlers` before it
  // reaches the child aggregate), so `version` is not yet a member here.  The
  // IR wire read projection (`forApiRead`) always exposes it, so the read
  // contract must too — re-derive it from the same default-on rule (every
  // non-event-sourced aggregate) and splice it into the wire-shape slot (after
  // declared properties, before containments).  Skip it when a `version` member
  // already exists (an explicit context-level `with versioned` applied ahead of
  // `scaffoldHandlers`), so it is never doubled.
  const members = agg.members ?? [];
  const isEventSourced = (agg as { persistedAs?: string }).persistedAs === "eventLog";
  const hasVersion = members.some((m) => isProperty(m) && m.name === "version");
  const trailing = !isEventSourced && !hasVersion ? [field("version", primType("int"))] : [];
  return apiReadFieldsOf(members, trailing);
}

/** The shared read-projection field walk for an aggregate OR an entity part
 * (`apiReadFields` wraps it for aggregates; `scaffoldResponse` calls it directly
 * on a part's members).  A part has no synthetic `id` in its response body
 * either, so — like the aggregate case — no `id` field is emitted. */
export function apiReadFieldsOf(
  members: readonly (AggregateMember | EntityPartMember)[],
  // Extra property fields spliced right after the declared properties (step a)
  // and before containments — the wire-shape slot the macro-added `version`
  // token occupies (`wireFieldsForAggregate` appends it last among `fields`).
  trailingProps: readonly Property[] = [],
): Property[] {
  const out: Property[] = [];
  // (a) declared properties minus internal / secret.
  for (const m of members) {
    if (!isProperty(m)) continue;
    const access = (m as { access?: FieldAccess }).access;
    if (access === "internal" || access === "secret") continue;
    out.push(field(m.name, cloneTypeRef(m.type)));
  }
  out.push(...trailingProps);
  // (b) containments → `<Part>Response` (the sibling record), array/optional
  //     mirroring the wire shape's `containmentTypeFor` + optionality rule.
  for (const m of members) {
    if (!isContainment(m)) continue;
    out.push(
      field(
        m.name,
        namedType(`${m.partType.$refText}Response`, {
          array: m.collection,
          optional: !!m.optional && !m.collection,
        }),
      ),
    );
  }
  // (c) derived getters minus `inspect` (the debug-string hook kept off the wire).
  for (const m of members) {
    if (!isDerivedProp(m)) continue;
    if (m.name === "inspect") continue;
    out.push(field(m.name, cloneTypeRef(m.type)));
  }
  return out;
}

/** An object literal expression: `{ field: <expr>, … }` (grammar `ObjectLit` /
 * `ObjectFieldInit`).  The single positional argument a factory call takes —
 * `<Agg>.create({ code: code, status: status })` — which lowers to a
 * `factory-let` (see `matchFactoryCall` in `lower-workflow.ts`).  Each entry's
 * `value` is any Expression (a bare `nameRef(field)` in the scaffold create
 * handler, threading the handler param of the same name into the field). */
export function objectLit(fields: { name: string; value: Expression }[]): ObjectLit {
  const origin = currentOrigin();
  const inits: ObjectFieldInit[] = fields.map((f) => {
    const node: ObjectFieldInit = tag(
      mkObjectFieldInit({ $type: "ObjectFieldInit", name: f.name, value: f.value }),
      origin,
    );
    setContainer(f.value, node, "value");
    return node;
  });
  const lit: ObjectLit = tag(mkObjectLit({ $type: "ObjectLit", fields: inits }), origin);
  inits.forEach((init, i) => {
    setContainer(init, lit, "fields", i);
  });
  return lit;
}

/** A `Context.Handler` handler reference — the target of a `route`.  The
 * `context` segment is a Langium cross-ref (resolved against global
 * `BoundedContext` scope); the `handler` segment is a plain name the IR
 * validator resolves across the context's command/query handlers + workflow
 * handles. */
export function handlerRef(contextName: string, handlerName: string): HandlerRef {
  const origin = currentOrigin();
  return tag(
    mkHandlerRef({
      $type: "HandlerRef",
      context: makeRef<import("../../language/generated/ast.js").BoundedContext>(contextName),
      handler: handlerName,
    }),
    origin,
  );
}

/** A `route <METHOD> <PATH> -> Context.Handler` api-body binding.  `path` is
 * the raw route path WITHOUT quotes (the `STRING` terminal strips its
 * delimiters); the printer re-quotes on emission. */
export function route(method: HttpMethod, path: string, target: HandlerRef): Route {
  const origin = currentOrigin();
  const node: Route = tag(mkRoute({ $type: "Route", method, path, target }), origin);
  setContainer(target, node, "target");
  return node;
}

// ---------------------------------------------------------------------------
// Host introspection helpers
// ---------------------------------------------------------------------------
//
// Macros that need to inspect the host's existing members (crudish
// reads `target.fields` to know what to assign) go through these
// helpers rather than reaching into the raw AST.  Keeps the API
// surface focused and lets us evolve the host representation
// without breaking macro authors.

/** Plain Property declarations on the aggregate (excludes
 * containments, derived props, operations, entity parts, tests).
 * Lists user-declared fields plus any fields contributed by other
 * macros that ran before this one — call order is the `with`
 * clause's left-to-right order. */
export function targetFields(target: Aggregate): readonly Property[] {
  return (target.members ?? []).filter(isProperty);
}

/** Subset of `targetFields` suitable for use as `update`-operation
 * parameters.  Two filters compose:
 *
 *   1. **Origin tag** — exclude fields contributed by other macros.
 *      Catches macro-added bookkeeping (createdAt, isDeleted, etc.)
 *      regardless of whether those macros set an access modifier.
 *   2. **Access modifier** — exclude fields whose `access` puts them
 *      outside the editable update payload: `immutable` (create-only),
 *      `managed` (server-owned), `token` (echoed precondition like
 *      `id`/`version`), `internal` (never client-input).  `secret`
 *      STAYS — write-only fields belong IN update inputs (password
 *      changes etc.).
 *   3. **Stamp target** — exclude fields a visible `stamp onCreate` /
 *      `stamp onUpdate` assigns (aggregate-body or context-level): the
 *      server owns their value at persist time, so admitting them as
 *      update params would let the client overwrite a server-stamped
 *      column (often the very one a row-security `filter` reads).  The
 *      AST twin of enrichment's `promoteStampTargets` → `managed`
 *      promotion — that IR pass runs long after this macro has already
 *      baked the params into the `update` op, so the exclusion must
 *      happen here too.  Capability-spliced stamps need no handling:
 *      the splice runs after `with`-macros, so neither the capability's
 *      field nor its stamp exists when crudish reads the host.
 *
 * The filters cover non-overlapping concerns: a user-declared
 * `slug: string immutable` is excluded by (2) alone; a macro-added
 * `createdAt: datetime` is excluded by (1) regardless of whether the
 * macro thought to set `access: "managed"`.
 *
 * Operation-specific name on purpose: a future `writableCreateFields`
 * will keep `immutable` (assignable on create) and exclude the
 * server-owned ones differently.  See the access-modifier matrix in
 * `src/ir/types/loom-ir.ts` (`FieldAccess`) for the canonical semantics. */
export function writableUpdateFields(target: Aggregate): readonly Property[] {
  const stamped = stampTargetNames(target);
  return targetFields(target).filter((f) => {
    if ((f as { [ORIGIN_PROP]?: OriginToken })[ORIGIN_PROP] !== undefined) return false;
    if (stamped.has(f.name)) return false;
    const access = (f as { access?: FieldAccess }).access;
    if (
      access === "immutable" ||
      access === "managed" ||
      access === "token" ||
      access === "internal"
    ) {
      return false;
    }
    return true;
  });
}

/** Field names targeted by `stamp onCreate` / `stamp onUpdate`
 * declarations visible at expansion time: the aggregate's own
 * `StampDecl` members plus the enclosing context's (context-level
 * stamps propagate to every aggregate — `collectStamps` in
 * `src/ir/lower/lower-capabilities.ts` merges the same two scopes).
 * A stamp target from EITHER event is server-owned on BOTH create and
 * update, mirroring `promoteStampTargets` (any stamp target →
 * `managed`), so both writable-field helpers consult this set. */
function stampTargetNames(target: Aggregate): ReadonlySet<string> {
  const decls = [
    ...(target.members ?? []).filter(isStampDecl),
    ...(target.$container?.members ?? []).filter(isStampDecl),
  ];
  return new Set(decls.flatMap((s) => s.assignments.map((a) => a.target.head)));
}

/** Subset of `targetFields` suitable for use as `create`-operation
 * parameters.  Same origin-tag filter as `writableUpdateFields` but
 * the access filter is symmetric:
 *
 *   1. **Origin tag** — exclude fields contributed by other macros
 *      (audit timestamps, soft-delete state, etc.).
 *   2. **Access modifier** — exclude `managed`, `token`, and
 *      `internal` (the same three that are excluded on update).
 *      `immutable` is KEPT — it's the whole point: settable on
 *      create, frozen after.  `secret` is KEPT — client supplies
 *      password hashes / API keys at creation time.
 *   3. **Stamp target** — same exclusion as `writableUpdateFields`:
 *      a stamped field's value is server-derived at persist time, so
 *      it is never a create param (`promoteStampTargets` drops it from
 *      the create-input contract; the factory initialises it and the
 *      stamp overwrites at save).
 *
 * Companion to `writableUpdateFields`.  When `crudish` grows a
 * `create` operation in a future phase, this is the helper it
 * iterates to derive the request-body shape. */
export function writableCreateFields(target: Aggregate): readonly Property[] {
  const stamped = stampTargetNames(target);
  return targetFields(target).filter((f) => {
    if ((f as { [ORIGIN_PROP]?: OriginToken })[ORIGIN_PROP] !== undefined) return false;
    if (stamped.has(f.name)) return false;
    const access = (f as { access?: FieldAccess }).access;
    if (access === "managed" || access === "token" || access === "internal") {
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Cross-decl accessors — typed views over Subdomain / BoundedContext
// members, computed on the fly.  Used by ui-targeted macros like
// `scaffold` to walk `mod.aggregates`, `ctx.workflows`, etc.  The
// raw AST has heterogeneous `members` arrays; these helpers do the
// per-type filtering once so macro authors don't reach into
// `$type` discriminators.
// ---------------------------------------------------------------------------

/** Aggregates declared inside a Subdomain (across all its
 * BoundedContexts) or directly inside a BoundedContext. */
export function aggregatesIn(
  parent:
    | import("../../language/generated/ast.js").Subdomain
    | import("../../language/generated/ast.js").BoundedContext,
): readonly Aggregate[] {
  if (isSubdomain(parent)) {
    return (parent.contexts ?? []).flatMap(
      (c) => (c.members ?? []).filter((cm) => cm.$type === "Aggregate") as Aggregate[],
    );
  }
  return (parent.members ?? []).filter((m) => m.$type === "Aggregate") as Aggregate[];
}

/** Workflows declared inside a Subdomain / BoundedContext. */
export function workflowsIn(
  parent:
    | import("../../language/generated/ast.js").Subdomain
    | import("../../language/generated/ast.js").BoundedContext,
): readonly import("../../language/generated/ast.js").Workflow[] {
  type W = import("../../language/generated/ast.js").Workflow;
  if (isSubdomain(parent)) {
    return (parent.contexts ?? []).flatMap(
      (c) => (c.members ?? []).filter((cm) => cm.$type === "Workflow") as W[],
    );
  }
  return (parent.members ?? []).filter((m) => m.$type === "Workflow") as W[];
}

/** Views declared inside a Subdomain / BoundedContext. */
export function viewsIn(
  parent:
    | import("../../language/generated/ast.js").Subdomain
    | import("../../language/generated/ast.js").BoundedContext,
): readonly import("../../language/generated/ast.js").View[] {
  type V = import("../../language/generated/ast.js").View;
  if (isSubdomain(parent)) {
    return (parent.contexts ?? []).flatMap(
      (c) => (c.members ?? []).filter((cm) => cm.$type === "View") as V[],
    );
  }
  return (parent.members ?? []).filter((m) => m.$type === "View") as V[];
}

// ---------------------------------------------------------------------------
// Small expression-tree helpers used by capability predicates.
// ---------------------------------------------------------------------------
//
// Capability factories (`contextFilter`, `contextStamp`) embed
// Loom AST expressions.  Authors build those via the existing
// factories (`memberAccess`, `nameRef`, `callExpr` from
// ui-factories) plus the helpers here.  All produce real Langium
// AST nodes (`UnaryExpr`, `NameRef`, etc.) that the IR layer
// lowers through `lowerExpr` after the linker runs.

/** Boolean negation: `!operand`.  Builds a `UnaryExpr` matching
 * the grammar's `(op='!' | op='-') operand=Expression` shape. */
export function not(operand: Expression): UnaryExpr {
  const origin = currentOrigin();
  const u: UnaryExpr = tag(mkUnaryExpr({ $type: "UnaryExpr", op: "!", operand }), origin);
  setContainer(operand, u, "operand");
  return u;
}

/** Bare `this` reference.  Returns a real `ThisRef` AST node (not a
 * `NameRef("this")`) so it lowers to `{ kind: "this" }` via the
 * `isThisRef(expr)` branch in `lower-expr.ts:377`. */
export function thisRef(): import("../../language/generated/ast.js").ThisRef {
  const origin = currentOrigin();
  return tag(mkThisRef({ $type: "ThisRef" }), origin);
}

/** `null` literal.  Loom's grammar models this as a `NullLit` with
 * `value: 'null'` (`src/language/ddd.langium:897`); the lowerer
 * recognises it and emits `{ kind: "literal", lit: "null", value: "null" }`. */
export function nullLit(): import("../../language/generated/ast.js").NullLit {
  const origin = currentOrigin();
  return tag(
    mkNullLit({
      $type: "NullLit",
      value: "null",
    }),
    origin,
  );
}

// String / boolean literals live in `ui-factories.ts` (they were
// added there first, for page menu metadata).  Re-export from
// `index.ts` keeps the public surface single-file.  Aggregate-side
// authors that need them just import from the macro-api index.

// ---------------------------------------------------------------------------
// Capability factories — produce real `FilterDecl` / `StampDecl` /
// `ImplementsDecl` AST nodes that the expander splices into the
// host's `members` array, exactly like Property / Operation.  No
// side table, no special bag mechanism — capabilities are first-
// class source members.  These factories are sugar over the same
// AST a user could hand-write inside an aggregate or context block.
// ---------------------------------------------------------------------------

type FilterDeclAst = import("../../language/generated/ast.js").FilterDecl;
type StampDeclAst = import("../../language/generated/ast.js").StampDecl;
type ImplementsDeclAst = import("../../language/generated/ast.js").ImplementsDecl;

/** Construct a `filter <expr>` aggregate / context member.
 * Equivalent to writing `filter <expr>` directly in source. */
export function contextFilter(predicate: Expression): FilterDeclAst & AggregateMember {
  const origin = currentOrigin();
  const node: FilterDeclAst = tag(
    mkFilterDecl({
      $type: "FilterDecl",
      expr: predicate,
    }),
    origin,
  );
  setContainer(predicate, node, "expr");
  return node as FilterDeclAst & AggregateMember;
}

/** One field/value pair inside a `stamp onCreate { ... }` /
 * `stamp onUpdate { ... }` body. */
export interface ContextStampAssignment {
  readonly field: string;
  readonly value: Expression;
}

/** Construct one or two `stamp <event> { ... }` aggregate / context
 * members from the spec.  Each event with at least one assignment
 * yields a StampDecl AST node; the expander splices each separately. */
export function contextStamp(spec: {
  onCreate?: ContextStampAssignment[];
  onUpdate?: ContextStampAssignment[];
}): Array<StampDeclAst & AggregateMember> {
  const out: Array<StampDeclAst & AggregateMember> = [];
  if (spec.onCreate?.length) {
    out.push(buildStamp("onCreate", spec.onCreate));
  }
  if (spec.onUpdate?.length) {
    out.push(buildStamp("onUpdate", spec.onUpdate));
  }
  return out;
}

function buildStamp(
  event: "onCreate" | "onUpdate",
  assignments: ContextStampAssignment[],
): StampDeclAst & AggregateMember {
  const origin = currentOrigin();
  const stmts = assignments.map((a) => assignStmt(a.field, a.value));
  const node: StampDeclAst = tag(
    mkStampDecl({
      $type: "StampDecl",
      event,
      assignments: stmts,
    }),
    origin,
  );
  stmts.forEach((s, i) => {
    setContainer(s, node, "assignments", i);
  });
  return node as StampDeclAst & AggregateMember;
}

/** Construct a TYPED `implements <Cap>` member (typed-capabilities.md) — a
 * capability application the expander resolves against the capability inventory
 * and splices in.  Unlike `implementsCapability` (the legacy string-group form),
 * this carries the bare capability name in `cap`, so it triggers the mixin
 * application rather than registering a string group.  Emitted on a context host
 * it applies the capability to every aggregate in the context. */
export function implementsCapabilityRef(cap: string): ImplementsDeclAst & AggregateMember {
  const origin = currentOrigin();
  const node: ImplementsDeclAst = tag(mkImplementsDecl({ $type: "ImplementsDecl", cap }), origin);
  return node as ImplementsDeclAst & AggregateMember;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a Langium-style unresolved cross-reference.  Langium's
 * Linker phase resolves these against scope; until then, `ref` is
 * undefined and `$refText` carries the textual name. */
function makeRef<T>(name: string): { $refText: string; ref: T | undefined } {
  return { $refText: name, ref: undefined };
}
