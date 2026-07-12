// Public macro authoring surface.  Stdlib macros and project-local
// `.loom/macros/*.ts` modules import from here.

// Re-exports of AST types — convenience so authors don't import
// directly from `language/generated/ast.js`.  Treated as readonly
// at the API surface.
export type {
  Aggregate,
  AggregateMember,
  Area,
  BoundedContext,
  FieldAccess,
  Operation,
  Page,
  Parameter,
  Property,
  Subdomain,
  TypeRef,
  Ui,
  UiMember,
  View,
  Workflow,
} from "../../language/generated/ast.js";
// Typed AST-node builders.  Most macro authors don't need these —
// the named factories above produce already-tagged-and-wired
// nodes.  Re-exported here for the few macros (e.g. `crudish`'s
// type-cloning helper) that hand-build raw AST fragments and want
// the structural-typing aid without resorting to `as-unknown-as`
// casts.
export {
  mkIdType,
  mkNamedType,
  mkParameter,
  mkPrimitiveType,
  mkProperty,
  mkStateBlock,
  mkStateField,
  mkTypeRef,
} from "./_mk.js";
export type {
  ExpandContext,
  MacroDefinition,
  MacroTarget,
  MemberTypeOf,
  NamedDeclKind,
  OriginToken,
  ParamSpec,
  ParamType,
  ParamValues,
  TargetNodeOf,
} from "./define.js";
export { defineMacro } from "./define.js";
export type { ContextStampAssignment } from "./factories.js";
export {
  aggregatesIn,
  assignStmt,
  assignStmtPath,
  callStmt,
  commandHandler,
  contextFilter,
  contextStamp,
  create,
  destroy,
  field,
  handlerRef,
  idRef,
  implementsCapabilityRef,
  letStmt,
  memberAccess,
  namedType,
  nameRef,
  not,
  nullLit,
  operation,
  originOf,
  param,
  primType,
  returnStmt,
  route,
  selfRef,
  targetFields,
  thisRef,
  viewsIn,
  workflowsIn,
  writableCreateFields,
  writableUpdateFields,
} from "./factories.js";
// UI-side factories — separate file because the surfaces don't
// overlap and bundling everything into one file makes both harder
// to navigate.
export {
  area,
  binaryExpr,
  bodyProp,
  boolLit,
  callExpr,
  intLit,
  lambda,
  matchExpr,
  nameRefExpr,
  nowExpr,
  page,
  pageMenuMeta,
  routeProp,
  stringLit,
  ternaryExpr,
} from "./ui-factories.js";
