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
  IdType,
  NamedDecl,
  NamedType,
  Operation,
  Parameter,
  PrimitiveType,
  Property,
  Statement,
  TypeRef,
} from "../language/generated/ast.js";
import type { OriginToken } from "./define.js";

// ---------------------------------------------------------------------------
// Origin tagging
// ---------------------------------------------------------------------------

/** Hidden property on every macro-emitted AST node — the expander
 * uses it when splicing, and the validator/diagnostics layer reads
 * it to redirect errors at the call site.  Not part of the public
 * Langium AST contract. */
export const ORIGIN_PROP = "$origin" as const;

/** Read the origin token off a node, if any.  Walks `$container`
 * chain so a property buried inside a synthesised operation body
 * still reports its origin. */
export function originOf(node: unknown): OriginToken | undefined {
  let cur: any = node;
  while (cur) {
    if (cur[ORIGIN_PROP] !== undefined) return cur[ORIGIN_PROP] as OriginToken;
    cur = cur.$container;
  }
  return undefined;
}

function tag<T>(node: T, origin: OriginToken | undefined): T {
  if (origin) (node as any)[ORIGIN_PROP] = origin;
  return node;
}

function setContainer(child: unknown, parent: object, property: string, index?: number): void {
  const c = child as Record<string, unknown>;
  c.$container = parent;
  c.$containerProperty = property;
  if (index !== undefined) c.$containerIndex = index;
}

// ---------------------------------------------------------------------------
// Factory context — bound by the expander before invoking `expand()`.
// ---------------------------------------------------------------------------

/** Factories read this thread-local context to find the active
 * macro's origin token.  Set by the expander immediately before
 * each `expand()` call; cleared after.  Single-threaded JS makes
 * this safe; if we ever move expansion into workers, replace with
 * AsyncLocalStorage or explicit context-passing. */
let _activeOrigin: OriginToken | undefined;

/** Internal API used by the expander.  Not for macro authors. */
export function _withOrigin<T>(origin: OriginToken, fn: () => T): T {
  const prev = _activeOrigin;
  _activeOrigin = origin;
  try {
    return fn();
  } finally {
    _activeOrigin = prev;
  }
}

function currentOrigin(): OriginToken | undefined {
  return _activeOrigin;
}

// ---------------------------------------------------------------------------
// Type-reference factories
// ---------------------------------------------------------------------------

/** A primitive type reference: `string`, `int`, `datetime`, etc.
 * Wraps the primitive in a `TypeRef` envelope as the parser does. */
export function primType(
  name: "bool" | "datetime" | "decimal" | "guid" | "int" | "long" | "string",
  opts: { array?: boolean; optional?: boolean } = {},
): TypeRef {
  const origin = currentOrigin();
  const prim: PrimitiveType = tag(
    { $type: "PrimitiveType", name } as unknown as PrimitiveType,
    origin,
  );
  const ref: TypeRef = tag(
    {
      $type: "TypeRef",
      base: prim,
      array: opts.array ?? false,
      optional: opts.optional ?? false,
    } as unknown as TypeRef,
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
    {
      $type: "IdType",
      target: makeRef<NamedDecl>(targetName),
    } as unknown as IdType,
    origin,
  );
  const ref: TypeRef = tag(
    {
      $type: "TypeRef",
      base: idType,
      array: opts.array ?? false,
      optional: opts.optional ?? false,
    } as unknown as TypeRef,
    origin,
  );
  setContainer(idType, ref, "base");
  return ref;
}

/** A bare named-type reference: `Money`, `OrderStatus`. */
export function namedType(
  targetName: string,
  opts: { array?: boolean; optional?: boolean } = {},
): TypeRef {
  const origin = currentOrigin();
  const nt: NamedType = tag(
    { $type: "NamedType", target: makeRef<NamedDecl>(targetName) } as unknown as NamedType,
    origin,
  );
  const ref: TypeRef = tag(
    {
      $type: "TypeRef",
      base: nt,
      array: opts.array ?? false,
      optional: opts.optional ?? false,
    } as unknown as TypeRef,
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
 * splices it in. */
export function field(
  name: string,
  type: TypeRef,
  opts: { display?: boolean; provenanced?: boolean } = {},
): Property {
  const origin = currentOrigin();
  const prop: Property = tag(
    {
      $type: "Property",
      name,
      type,
      display: opts.display ?? false,
      provenanced: opts.provenanced ?? false,
    } as unknown as Property,
    origin,
  );
  setContainer(type, prop, "type");
  return prop;
}

/** A parameter on an operation. */
export function param(name: string, type: TypeRef): Parameter {
  const origin = currentOrigin();
  const p: Parameter = tag(
    { $type: "Parameter", name, type } as unknown as Parameter,
    origin,
  );
  setContainer(type, p, "type");
  return p;
}

/** An operation declaration.  `body` is a (possibly empty) array
 * of statements.  Statement factories will be added when crudish
 * lands; for now, `operation(...)` with `body: []` is enough for
 * trait macros that only need to declare operations. */
export function operation(
  name: string,
  params: Parameter[],
  body: Statement[],
  opts: { private?: boolean; extern?: boolean; audited?: boolean } = {},
): Operation {
  const origin = currentOrigin();
  const op: Operation = tag(
    {
      $type: "Operation",
      name,
      params,
      body,
      private: opts.private ?? false,
      extern: opts.extern ?? false,
      audited: opts.audited ?? false,
    } as unknown as Operation,
    origin,
  );
  params.forEach((p, i) => setContainer(p, op, "params", i));
  body.forEach((s, i) => setContainer(s, op, "body", i));
  return op;
}

// ---------------------------------------------------------------------------
// Capability flags
// ---------------------------------------------------------------------------

/** A capability flag set on the host node.  Not a real AST member
 * — the expander collects these out-of-band and propagates them
 * through lowering as `AggregateIR.flags`.  Generators dedupe
 * cross-cutting infrastructure by flag (e.g. one EF Core
 * interceptor for all `isAuditable` aggregates).
 *
 * Returned from `expand()` as a member to keep the API uniform.
 * The expander filters marks out before splicing the real members. */
export interface MarkNode {
  readonly $type: "Mark";
  readonly name: string;
  readonly data?: Record<string, unknown>;
  readonly $origin?: OriginToken;
}

export function mark(name: string, data?: Record<string, unknown>): MarkNode & AggregateMember {
  const origin = currentOrigin();
  const m: MarkNode = {
    $type: "Mark",
    name,
    data,
    ...(origin ? { $origin: origin } : {}),
  };
  // Mark is not actually an AggregateMember in the AST, but at the
  // macro API surface we present it as one so authors can return
  // a flat list.  The expander discriminates on `$type === "Mark"`.
  return m as unknown as MarkNode & AggregateMember;
}

export function isMarkNode(node: unknown): node is MarkNode {
  return !!node && typeof node === "object" && (node as any).$type === "Mark";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a Langium-style unresolved cross-reference.  Langium's
 * Linker phase resolves these against scope; until then, `ref` is
 * undefined and `$refText` carries the textual name. */
function makeRef<T>(name: string): { $refText: string; ref?: T } {
  return { $refText: name };
}
