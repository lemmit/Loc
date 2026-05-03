import Handlebars from "handlebars";
import type {
  ExprIR,
  FieldIR,
  ParamIR,
  StmtIR,
  TypeIR,
} from "../../ir/loom-ir.js";
import { pascal, plural, snake } from "../../util/naming.js";
import { renderCsType } from "./render-expr.js";
import { renderCsStatements } from "./render-stmt.js";

// ---------------------------------------------------------------------------
// Shared Handlebars instance + helpers used by every .NET template.
//
// Helpers that emit raw C# (types, expressions, statements, parameter
// lists) all wrap their output in a SafeString so generic syntax like
// `Task<List<T>>` survives Handlebars' HTML escaping.
// ---------------------------------------------------------------------------

export const hb = Handlebars.create();

hb.registerHelper("eq", (a: unknown, b: unknown) => a === b);
hb.registerHelper("pascal", (s: string) => pascal(s));
hb.registerHelper("plural", (s: string) => plural(s));
hb.registerHelper("snake", (s: string) => snake(s));
hb.registerHelper("csType", (t: TypeIR) => new hb.SafeString(renderCsType(t)));
hb.registerHelper("csExpr", (e: ExprIR) => new hb.SafeString(renderCsExpr(e)));
hb.registerHelper("csStmts", (s: StmtIR[]) => new hb.SafeString(renderCsStatements(s)));
hb.registerHelper("csParams", (params: ParamIR[]) =>
  new hb.SafeString(params.map((p) => `${renderCsType(p.type)} ${p.name}`).join(", ")),
);
hb.registerHelper("escapeStr", (s: string) => new hb.SafeString(JSON.stringify(s)));
hb.registerHelper("requiredFields", (fields: FieldIR[]) =>
  fields.filter((f) => !f.optional),
);
hb.registerHelper("isPublic", (visibility: string) => visibility === "public");
hb.registerHelper("isOwnsMany", (c: { collection?: boolean }) => !!c.collection);
hb.registerHelper("ownedRef", (f: FieldIR) => f.type.kind === "valueobject");
hb.registerHelper("isIdField", (f: FieldIR) => f.type.kind === "id");
hb.registerHelper("isEnumField", (f: FieldIR) => f.type.kind === "enum");
hb.registerHelper("concat", (...args: unknown[]) => args.slice(0, -1).join(""));

// `renderCsExpr` is used inside the helper above — re-export so individual
// templates can call it via the registered helper without importing twice.
import { renderCsExpr } from "./render-expr.js";
export { renderCsExpr };
