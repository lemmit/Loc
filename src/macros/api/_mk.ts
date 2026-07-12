// Typed AST-node builders for the macro-api.
//
// Langium's generated AST types (`src/language/generated/ast.ts`)
// declare every field as required — they model the *post-link* state
// of an AST that has already passed through the document builder.
// Macro factories, however, construct nodes pre-link: the literal we
// build intentionally omits `$container` / `$containerProperty` /
// `$containerIndex` (filled in afterwards by `setContainer`) and
// other reflection-y bits the runtime sets.
//
// Rather than scatter `as-unknown-as <AstType>` casts across every
// public factory in `factories.ts` and `ui-factories.ts`, we funnel
// all construction through one generic builder, `mkAst<T>`.  That
// builder holds the ONE escape-hatch cast in the entire macro-api.
//
// Each `mk<X>(...)` is a thin wrapper over `mkAst` that pins the
// concrete AST type for one node kind.  Public factories then say:
//
//   const node = mkProperty({ $type: "Property", name, type, ... });
//   setContainer(...);
//   return tag(node, currentOrigin());
//
// — no inline casts.  Origin tagging and container wiring stay in
// the public factories; `mk<X>` is purely a structural-typing aid.
//
// Importers: `factories.ts` and `ui-factories.ts` ONLY.  Macro
// authors do not see this module.

import type {
  Area,
  AssignOrCallStmt,
  BinaryChain,
  BodyProp,
  BoolLit,
  CallArg,
  CallSuffix,
  CommandHandler,
  Create,
  Destroy,
  FilterDecl,
  HandlerRef,
  IdType,
  ImplementsDecl,
  IntLit,
  Lambda,
  LetStmt,
  LValue,
  MatchArm,
  MatchExpr,
  MemberSuffix,
  MenuMetaEntry,
  NamedType,
  NameRef,
  NowExpr,
  NullLit,
  Operation,
  Page,
  PageMenuMeta,
  Parameter,
  PostfixChain,
  PrimitiveType,
  Property,
  ReturnStmt,
  Route,
  RouteProp,
  SelfType,
  StampDecl,
  StateBlock,
  StateField,
  StringLit,
  TernaryExpr,
  ThisRef,
  TypeRef,
  UnaryExpr,
} from "../../language/generated/ast.js";

/** Shape of a literal that callers may supply to a `mk<X>` builder.
 * Langium's generated AST types treat container metadata as required;
 * factories don't set it themselves (the `setContainer` call in the
 * public factory does), so we drop it from the input contract. */
type AstLiteral<T> = Omit<T, "$container" | "$containerProperty" | "$containerIndex">;

/** The one cast in the entire macro-api.
 *
 * Every named `mk<X>` builder funnels through this generic.  The
 * The `as-unknown-as-T` here is the **only** structural escape hatch
 * needed to bridge the pre-link literal shape and Langium's post-link
 * AST type.  Public factories never cast. */
function mkAst<T extends { $type: string }>(node: AstLiteral<T>): T {
  return node as unknown as T;
}

// ---------------------------------------------------------------------------
// factories.ts — aggregate / expression / statement / capability builders
// ---------------------------------------------------------------------------

export function mkPrimitiveType(shape: AstLiteral<PrimitiveType>): PrimitiveType {
  return mkAst<PrimitiveType>(shape);
}

export function mkTypeRef(shape: AstLiteral<TypeRef>): TypeRef {
  return mkAst<TypeRef>(shape);
}

export function mkIdType(shape: AstLiteral<IdType>): IdType {
  return mkAst<IdType>(shape);
}

export function mkNamedType(shape: AstLiteral<NamedType>): NamedType {
  return mkAst<NamedType>(shape);
}

export function mkSelfType(shape: AstLiteral<SelfType>): SelfType {
  return mkAst<SelfType>(shape);
}

export function mkProperty(shape: AstLiteral<Property>): Property {
  return mkAst<Property>(shape);
}

export function mkParameter(shape: AstLiteral<Parameter>): Parameter {
  return mkAst<Parameter>(shape);
}

export function mkOperation(shape: AstLiteral<Operation>): Operation {
  return mkAst<Operation>(shape);
}

export function mkCreate(shape: AstLiteral<Create>): Create {
  return mkAst<Create>(shape);
}

export function mkDestroy(shape: AstLiteral<Destroy>): Destroy {
  return mkAst<Destroy>(shape);
}

export function mkNameRef(shape: AstLiteral<NameRef>): NameRef {
  return mkAst<NameRef>(shape);
}

export function mkCallArg(shape: AstLiteral<CallArg>): CallArg {
  return mkAst<CallArg>(shape);
}

export function mkMemberSuffix(shape: AstLiteral<MemberSuffix>): MemberSuffix {
  return mkAst<MemberSuffix>(shape);
}

export function mkCallSuffix(shape: AstLiteral<CallSuffix>): CallSuffix {
  return mkAst<CallSuffix>(shape);
}

export function mkPostfixChain(shape: AstLiteral<PostfixChain>): PostfixChain {
  return mkAst<PostfixChain>(shape);
}

export function mkLValue(shape: AstLiteral<LValue>): LValue {
  return mkAst<LValue>(shape);
}

export function mkAssignOrCallStmt(shape: AstLiteral<AssignOrCallStmt>): AssignOrCallStmt {
  return mkAst<AssignOrCallStmt>(shape);
}

export function mkLetStmt(shape: AstLiteral<LetStmt>): LetStmt {
  return mkAst<LetStmt>(shape);
}

export function mkReturnStmt(shape: AstLiteral<ReturnStmt>): ReturnStmt {
  return mkAst<ReturnStmt>(shape);
}

// ---------------------------------------------------------------------------
// api-hosted transport bindings — `route <METHOD> <PATH> -> Context.Handler`
// and the application-layer `commandHandler` context member the route targets.
// ---------------------------------------------------------------------------

export function mkRoute(shape: AstLiteral<Route>): Route {
  return mkAst<Route>(shape);
}

export function mkHandlerRef(shape: AstLiteral<HandlerRef>): HandlerRef {
  return mkAst<HandlerRef>(shape);
}

export function mkCommandHandler(shape: AstLiteral<CommandHandler>): CommandHandler {
  return mkAst<CommandHandler>(shape);
}

export function mkUnaryExpr(shape: AstLiteral<UnaryExpr>): UnaryExpr {
  return mkAst<UnaryExpr>(shape);
}

export function mkBinaryChain(shape: AstLiteral<BinaryChain>): BinaryChain {
  return mkAst<BinaryChain>(shape);
}

export function mkTernaryExpr(shape: AstLiteral<TernaryExpr>): TernaryExpr {
  return mkAst<TernaryExpr>(shape);
}

export function mkMatchExpr(shape: AstLiteral<MatchExpr>): MatchExpr {
  return mkAst<MatchExpr>(shape);
}

export function mkMatchArm(shape: AstLiteral<MatchArm>): MatchArm {
  return mkAst<MatchArm>(shape);
}

export function mkThisRef(shape: AstLiteral<ThisRef>): ThisRef {
  return mkAst<ThisRef>(shape);
}

export function mkNullLit(shape: AstLiteral<NullLit>): NullLit {
  return mkAst<NullLit>(shape);
}

export function mkFilterDecl(shape: AstLiteral<FilterDecl>): FilterDecl {
  return mkAst<FilterDecl>(shape);
}

export function mkStampDecl(shape: AstLiteral<StampDecl>): StampDecl {
  return mkAst<StampDecl>(shape);
}

export function mkImplementsDecl(shape: AstLiteral<ImplementsDecl>): ImplementsDecl {
  return mkAst<ImplementsDecl>(shape);
}

// ---------------------------------------------------------------------------
// ui-factories.ts — page / page-prop / literal builders
// ---------------------------------------------------------------------------

export function mkStringLit(shape: AstLiteral<StringLit>): StringLit {
  return mkAst<StringLit>(shape);
}

export function mkBoolLit(shape: AstLiteral<BoolLit>): BoolLit {
  return mkAst<BoolLit>(shape);
}

export function mkNowExpr(shape: AstLiteral<NowExpr>): NowExpr {
  return mkAst<NowExpr>(shape);
}

export function mkIntLit(shape: AstLiteral<IntLit>): IntLit {
  return mkAst<IntLit>(shape);
}

export function mkLambda(shape: AstLiteral<Lambda>): Lambda {
  return mkAst<Lambda>(shape);
}

export function mkRouteProp(shape: AstLiteral<RouteProp>): RouteProp {
  return mkAst<RouteProp>(shape);
}

export function mkBodyProp(shape: AstLiteral<BodyProp>): BodyProp {
  return mkAst<BodyProp>(shape);
}

export function mkMenuMetaEntry(shape: AstLiteral<MenuMetaEntry>): MenuMetaEntry {
  return mkAst<MenuMetaEntry>(shape);
}

export function mkPageMenuMeta(shape: AstLiteral<PageMenuMeta>): PageMenuMeta {
  return mkAst<PageMenuMeta>(shape);
}

export function mkArea(shape: AstLiteral<Area>): Area {
  return mkAst<Area>(shape);
}

export function mkPage(shape: AstLiteral<Page>): Page {
  return mkAst<Page>(shape);
}

export function mkStateField(shape: AstLiteral<StateField>): StateField {
  return mkAst<StateField>(shape);
}

export function mkStateBlock(shape: AstLiteral<StateBlock>): StateBlock {
  return mkAst<StateBlock>(shape);
}
