// Public macro authoring surface.  Stdlib macros and project-local
// `.loom/macros/*.ts` modules import from here.

export { defineMacro } from "./define.js";
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

export {
  aggregatesIn,
  assignStmt,
  assignStmtPath,
  contextFilter,
  contextStamp,
  field,
  idRef,
  isContextFilter,
  isContextStamp,
  memberAccess,
  nameRef,
  namedType,
  not,
  nullLit,
  operation,
  originOf,
  param,
  primType,
  targetFields,
  thisRef,
  viewsIn,
  workflowsIn,
  writableUserFields,
} from "./factories.js";
export type {
  ContextFilterNode,
  ContextStampAssignment,
  ContextStampNode,
} from "./factories.js";

// UI-side factories — separate file because the surfaces don't
// overlap and bundling everything into one file makes both harder
// to navigate.
export {
  boolLit,
  bodyProp,
  callExpr,
  nameRefExpr,
  page,
  pageMenuMeta,
  routeProp,
  stringLit,
} from "./ui-factories.js";

// Re-exports of AST types — convenience so authors don't import
// directly from `language/generated/ast.js`.  Treated as readonly
// at the API surface.
export type {
  Aggregate,
  AggregateMember,
  BoundedContext,
  Module,
  Operation,
  Page,
  Parameter,
  Property,
  TypeRef,
  Ui,
  UiMember,
  View,
  Workflow,
} from "../language/generated/ast.js";
