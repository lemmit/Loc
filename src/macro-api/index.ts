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
  assignStmt,
  assignStmtPath,
  field,
  idRef,
  isMarkNode,
  mark,
  memberAccess,
  nameRef,
  namedType,
  operation,
  originOf,
  param,
  primType,
  targetFields,
  writableUserFields,
} from "./factories.js";
export type { MarkNode } from "./factories.js";

// Re-exports of AST types — convenience so authors don't import
// directly from `language/generated/ast.js`.  Treated as readonly
// at the API surface.
export type {
  Aggregate,
  AggregateMember,
  Module,
  Operation,
  Parameter,
  Property,
  TypeRef,
  Ui,
  UiMember,
} from "../language/generated/ast.js";
