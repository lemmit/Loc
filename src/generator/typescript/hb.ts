import Handlebars from "handlebars";
import type { ExprIR, FieldIR, StmtIR, TypeIR } from "../../ir/loom-ir.js";
import { camel, plural, snake } from "../../util/naming.js";
import { renderTsExpr, renderTsType } from "./render-expr.js";
import { renderTsStatements } from "./render-stmt.js";

// ---------------------------------------------------------------------------
// Shared Handlebars instance + helpers used by every TS template.
//
// All helpers that emit raw code (types, expressions, statements, naming
// transforms) wrap their result in a SafeString so generic syntax like
// `Promise<T[]>` survives Handlebars' default HTML escaping.
// ---------------------------------------------------------------------------

export const hb = Handlebars.create();

hb.registerHelper("eq", (a: unknown, b: unknown) => a === b);
hb.registerHelper("camel", (s: string) => camel(s));
hb.registerHelper("plural", (s: string) => plural(s));
hb.registerHelper("snake", (s: string) => snake(s));
hb.registerHelper("tsType", (t: TypeIR) => new hb.SafeString(renderTsType(t)));
hb.registerHelper("tsExpr", (e: ExprIR) => new hb.SafeString(renderTsExpr(e)));
hb.registerHelper("tsStmts", (stmts: StmtIR[]) => new hb.SafeString(renderTsStatements(stmts)));
hb.registerHelper("requiredFields", (fields: FieldIR[]) =>
  fields.filter((f) => !f.optional),
);
hb.registerHelper("zodFor", (t: TypeIR) => new hb.SafeString(zodFor(t)));
hb.registerHelper("typeJsonSchema", (t: TypeIR) => new hb.SafeString(zodFor(t)));
hb.registerHelper("escapeStr", (s: string) => new hb.SafeString(JSON.stringify(s)));
hb.registerHelper("concat", (...args: unknown[]) => args.slice(0, -1).join(""));

function zodFor(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "z.coerce.number().int()";
        case "decimal":
          return "z.coerce.number()";
        case "string":
        case "guid":
          return "z.string()";
        case "bool":
          return "z.coerce.boolean()";
        case "datetime":
          return "z.coerce.date()";
      }
    /* eslint-disable-next-line no-fallthrough */
    case "id":
      return "z.string()";
    case "enum":
      return `z.string()`;
    case "valueobject":
    case "entity":
      return "z.unknown()";
    case "array":
      return `z.array(${zodFor(t.element)})`;
    case "optional":
      return `${zodFor(t.inner)}.nullish()`;
  }
}
