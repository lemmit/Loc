import Handlebars from "handlebars";
import type {
  AggregateIR,
  BoundedContextIR,
  ContainmentIR,
  DerivedIR,
  EntityPartIR,
  EnumIR,
  EventIR,
  ExprIR,
  FieldIR,
  FunctionIR,
  InvariantIR,
  OperationIR,
  ParamIR,
  RepositoryIR,
  StmtIR,
  TypeIR,
  ValueObjectIR,
} from "../../ir/loom-ir.js";
import { camel, plural, snake } from "../../util/naming.js";
import { renderTsExpr, renderTsType } from "./render-expr.js";
import { renderTsStatements } from "./render-stmt.js";

// ---------------------------------------------------------------------------
// Handlebars setup — shared across all TS templates
// ---------------------------------------------------------------------------

const hb = Handlebars.create();

hb.registerHelper("eq", (a: unknown, b: unknown) => a === b);
hb.registerHelper("camel", (s: string) => camel(s));
hb.registerHelper("plural", (s: string) => plural(s));
hb.registerHelper("snake", (s: string) => snake(s));
hb.registerHelper("tsType", (t: TypeIR) => renderTsType(t));
hb.registerHelper("tsExpr", (e: ExprIR) => new hb.SafeString(renderTsExpr(e)));
hb.registerHelper("tsStmts", (stmts: StmtIR[]) => new hb.SafeString(renderTsStatements(stmts)));
hb.registerHelper("optional", (f: FieldIR) => f.optional);
hb.registerHelper("requiredFields", (fields: FieldIR[]) =>
  fields.filter((f) => !f.optional),
);
hb.registerHelper("typeJsonSchema", (t: TypeIR) => new hb.SafeString(zodFor(t)));
hb.registerHelper(
  "join",
  (items: unknown[], sep: string, fn?: Handlebars.HelperOptions) => {
    if (!fn || typeof fn === "string") return items.join(sep);
    return items.map((i) => fn.fn(i)).join(sep);
  },
);
hb.registerHelper("escapeStr", (s: string) => new hb.SafeString(JSON.stringify(s)));

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

// ---------------------------------------------------------------------------
// Templates (string-literal sources)
// ---------------------------------------------------------------------------

const IDS_TPL = hb.compile(
  `// Auto-generated.
import { randomUUID } from "node:crypto";

{{#each entries}}
export type {{this.name}}Id = string & { readonly __brand: "{{this.name}}Id" };
export const {{this.name}}Id = (value: string): {{this.name}}Id => value as {{this.name}}Id;
export const new{{this.name}}Id = (): {{this.name}}Id => randomUUID() as {{this.name}}Id;

{{/each}}
`,
);

const ENUM_VO_TPL = hb.compile(
  `// Auto-generated.

{{#each enums}}
export const {{name}} = {
{{#each values}}  {{this}}: "{{this}}"{{#unless @last}},{{/unless}}
{{/each}}
} as const;
export type {{name}} = {{#each values}}"{{this}}"{{#unless @last}} | {{/unless}}{{/each}};

{{/each}}
{{#each valueObjects}}
export class {{name}} {
  constructor(
{{#each fields}}    public readonly {{name}}: {{tsType type}}{{#unless @last}},{{/unless}}
{{/each}}  ) {
{{#each invariants}}    {{#if guard}}if (({{tsExpr guard}}) && !({{tsExpr expr}})){{else}}if (!({{tsExpr expr}})){{/if}} throw new Error({{escapeStr (concat "Invariant violated: " source)}});
{{/each}}  }

{{#each derived}}  get {{name}}(): {{tsType type}} { return {{tsExpr expr}}; }
{{/each}}
{{#each functions}}  private {{camel name}}({{#each params}}{{name}}: {{tsType type}}{{#unless @last}}, {{/unless}}{{/each}}): {{tsType returnType}} { return {{tsExpr body}}; }
{{/each}}
}

{{/each}}
`,
);

const EVENTS_TPL = hb.compile(
  `// Auto-generated.
import type * as Ids from "./ids.js";

{{#each events}}
export interface {{name}} {
  readonly type: "{{name}}";
{{#each fields}}  readonly {{name}}: {{tsType type}};
{{/each}}
}

{{/each}}
{{#if events.length}}
export type DomainEvent = {{#each events}}{{name}}{{#unless @last}} | {{/unless}}{{/each}};
{{else}}
export type DomainEvent = never;
{{/if}}
`,
);

const ENTITY_TPL = hb.compile(
  `{{#with entity}}
export class {{name}} {
  private _id: Ids.{{name}}Id;
{{#unless isRoot}}  private _parentId: Ids.{{rootName}}Id;
{{/unless}}{{#if isRoot}}  private _events: Events.DomainEvent[] = [];
{{/if}}{{#each fields}}  private _{{name}}: {{tsType type}};
{{/each}}{{#each contains}}  private _{{name}}: {{partName}}{{#if collection}}[]{{/if}};
{{/each}}
  private constructor(state: { id: Ids.{{name}}Id{{#unless isRoot}}; parentId: Ids.{{rootName}}Id{{/unless}}{{#each fields}}; {{name}}: {{tsType type}}{{/each}}{{#each contains}}; {{name}}: {{partName}}{{#if collection}}[]{{/if}}{{/each}} }) {
    this._id = state.id;
{{#unless isRoot}}    this._parentId = state.parentId;
{{/unless}}{{#each fields}}    this._{{name}} = state.{{name}};
{{/each}}{{#each contains}}    this._{{name}} = state.{{name}};
{{/each}}    this._assertInvariants();
  }

  get id(): Ids.{{name}}Id { return this._id; }
{{#unless isRoot}}  get parentId(): Ids.{{rootName}}Id { return this._parentId; }
{{/unless}}{{#each fields}}  get {{name}}(): {{tsType type}} { return this._{{name}}; }
{{/each}}{{#each contains}}  get {{name}}(): readonly {{partName}}{{#if collection}}[]{{/if}} { return this._{{name}}; }
{{/each}}{{#each derived}}  get {{name}}(): {{tsType type}} { return {{tsExpr expr}}; }
{{/each}}
{{#each functions}}  private {{camel name}}({{#each params}}{{name}}: {{tsType type}}{{#unless @last}}, {{/unless}}{{/each}}): {{tsType returnType}} { return {{tsExpr body}}; }
{{/each}}
{{#each operations}}  {{#if (eq visibility "public")}}public{{else}}private{{/if}} {{camel name}}({{#each params}}{{name}}: {{tsType type}}{{#unless @last}}, {{/unless}}{{/each}}): void {
{{tsStmts statements}}
    this._assertInvariants();
  }

{{/each}}
{{#if isRoot}}  pullEvents(): Events.DomainEvent[] {
    const out = this._events;
    this._events = [];
    return out;
  }

{{/if}}  private _assertInvariants(): void {
{{#each invariants}}    {{#if guard}}if (({{tsExpr guard}}) && !({{tsExpr expr}})){{else}}if (!({{tsExpr expr}})){{/if}} throw new DomainError({{escapeStr (concat "Invariant violated: " source)}});
{{/each}}  }

  static _create(state: { id: Ids.{{name}}Id{{#unless isRoot}}; parentId: Ids.{{rootName}}Id{{/unless}}{{#each fields}}; {{name}}: {{tsType type}}{{/each}}{{#each contains}}; {{name}}: {{partName}}{{#if collection}}[]{{/if}}{{/each}} }): {{name}} {
    return new {{name}}(state);
  }
{{#if isRoot}}
  static create(input: { {{#each (requiredFields fields)}}{{name}}: {{tsType type}}{{#unless @last}}; {{/unless}}{{/each}} }): {{name}} {
    return new {{name}}({
      id: Ids.new{{name}}Id(),
{{#each fields}}      {{name}}: {{#if optional}}null{{else}}input.{{name}}{{/if}},
{{/each}}{{#each contains}}      {{name}}: {{#if collection}}[]{{else}}null as never{{/if}},
{{/each}}    });
  }
{{/if}}
}
{{/with}}`,
);

const AGGREGATE_TPL = hb.compile(
  `// Auto-generated.
import * as Ids from "./ids.js";
{{#if valueObjectAliases.length}}import { {{#each valueObjectAliases}}{{this}}{{#unless @last}}, {{/unless}}{{/each}} } from "./value-objects.js";
{{/if}}{{#if enumAliases.length}}import { {{#each enumAliases}}{{this}}{{#unless @last}}, {{/unless}}{{/each}} } from "./value-objects.js";
{{/if}}import type * as Events from "./events.js";
import { DomainError } from "./errors.js";

{{{partsRendered}}}
{{{rootRendered}}}
`,
);

const REPOSITORY_TPL = hb.compile(
  `// Auto-generated.
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as schema from "../schema.js";
import { {{aggregate.name}} } from "../../domain/{{camel aggregate.name}}.js";
import * as Ids from "../../domain/ids.js";
import { AggregateNotFoundError } from "../../domain/errors.js";

export class {{aggregate.name}}Repository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async findById(id: Ids.{{aggregate.name}}Id): Promise<{{aggregate.name}} | null> {
    const rows = await this.db.select().from(schema.{{plural (camel aggregate.name)}}).where(eq(schema.{{plural (camel aggregate.name)}}.id, id));
    if (rows.length === 0) return null;
    const row = rows[0]! as never;
    return {{aggregate.name}}._create(row);
  }

  async getById(id: Ids.{{aggregate.name}}Id): Promise<{{aggregate.name}}> {
    const found = await this.findById(id);
    if (!found) throw new AggregateNotFoundError(\`{{aggregate.name}} \${id} not found\`);
    return found;
  }

  async save(aggregate: {{aggregate.name}}): Promise<void> {
    const state = aggregate as unknown as Record<string, unknown>;
    await this.db.insert(schema.{{plural (camel aggregate.name)}}).values(state as never).onConflictDoUpdate({ target: schema.{{plural (camel aggregate.name)}}.id, set: state as never });
    const events = aggregate.pullEvents();
    void events;
  }
{{#each finds}}
  async {{name}}({{#each params}}{{name}}: {{tsType type}}{{#unless @last}}, {{/unless}}{{/each}}): Promise<{{tsType returnType}}> {
    throw new Error("Not implemented: {{name}}");
  }
{{/each}}
}
`,
);

const ROUTES_TPL = hb.compile(
  `// Auto-generated.
import { Hono } from "hono";
import { z } from "zod";
import { {{aggregate.name}} } from "../domain/{{camel aggregate.name}}.js";
import { {{aggregate.name}}Repository } from "../db/repositories/{{camel aggregate.name}}-repository.js";
import * as Ids from "../domain/ids.js";
import { DomainError, AggregateNotFoundError } from "../domain/errors.js";

export function {{camel aggregate.name}}Routes(repo: {{aggregate.name}}Repository): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const schema = z.object({
{{#each (requiredFields aggregate.fields)}}      {{name}}: {{typeJsonSchema type}},
{{/each}}    });
    const body = schema.parse(await c.req.json());
    const created = {{aggregate.name}}.create(body as never);
    await repo.save(created);
    return c.json({ id: created.id }, 201);
  });

  app.get("/:id", async (c) => {
    const found = await repo.findById(Ids.{{aggregate.name}}Id(c.req.param("id")));
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.json({ id: found.id });
  });

{{#each publicOperations}}
  app.post("/:id/{{snake name}}", async (c) => {
    const schema = z.object({
{{#each params}}      {{name}}: {{typeJsonSchema type}},
{{/each}}    });
    const body = {{#if params.length}}schema.parse(await c.req.json()){{else}}{}{{/if}};
    const aggregate = await repo.getById(Ids.{{../aggregate.name}}Id(c.req.param("id")));
    aggregate.{{camel name}}({{#each params}}body.{{name}} as never{{#unless @last}}, {{/unless}}{{/each}});
    await repo.save(aggregate);
    return c.json({ ok: true });
  });

{{/each}}
{{#each finds}}
  app.get("/{{snake name}}", async (c) => {
    const schema = z.object({
{{#each params}}      {{name}}: {{typeJsonSchema type}},
{{/each}}    });
    const params = schema.parse(c.req.query());
    const result = await repo.{{name}}({{#each params}}params.{{name}} as never{{#unless @last}}, {{/unless}}{{/each}});
    return c.json(result);
  });

{{/each}}
  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json({ error: err.message }, 400);
    if (err instanceof AggregateNotFoundError) return c.json({ error: err.message }, 404);
    console.error(err);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
`,
);

const HTTP_INDEX_TPL = hb.compile(
  `// Auto-generated.
import { Hono } from "hono";
{{#each aggregates}}
import { {{camel name}}Routes } from "./{{camel name}}.routes.js";
import { {{name}}Repository } from "../db/repositories/{{camel name}}-repository.js";
{{/each}}
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";

export function createApp(db: NodePgDatabase<typeof schema>): Hono {
  const app = new Hono();
{{#each aggregates}}  app.route("/{{snake (plural name)}}", {{camel name}}Routes(new {{name}}Repository(db)));
{{/each}}  return app;
}
`,
);

const SCHEMA_TPL = hb.compile(
  `// Auto-generated.
import { pgTable, text, integer, bigint, numeric, boolean, timestamp, pgEnum, uuid } from "drizzle-orm/pg-core";

{{#each enums}}
export const {{camel name}}Enum = pgEnum("{{snake name}}", [{{#each values}}"{{this}}"{{#unless @last}}, {{/unless}}{{/each}}]);
{{/each}}

{{{tables}}}
`,
);

// ---------------------------------------------------------------------------
// Public renderers (consume Loom IR + structural view models)
// ---------------------------------------------------------------------------

hb.registerHelper("concat", (...args: unknown[]) => {
  // last arg is the Handlebars options object
  return args.slice(0, -1).join("");
});

export function renderIds(ctx: BoundedContextIR): string {
  const entries: { name: string }[] = [];
  for (const a of ctx.aggregates) {
    entries.push({ name: a.name });
    for (const p of a.parts) entries.push({ name: p.name });
  }
  return IDS_TPL({ entries });
}

export function renderEnumsAndValueObjects(ctx: BoundedContextIR): string {
  return ENUM_VO_TPL({ enums: ctx.enums, valueObjects: ctx.valueObjects });
}

export function renderEvents(ctx: BoundedContextIR): string {
  return EVENTS_TPL({ events: ctx.events });
}

export function renderAggregate(agg: AggregateIR, ctx: BoundedContextIR): string {
  const valueObjectAliases = ctx.valueObjects.map((v) => v.name);
  const enumAliases = ctx.enums.map((e) => e.name);
  const partsRendered = agg.parts
    .map((p) =>
      ENTITY_TPL({
        entity: {
          ...p,
          isRoot: false,
          rootName: agg.name,
          operations: [],
          contains: p.contains,
        },
      }),
    )
    .join("\n");
  const rootRendered = ENTITY_TPL({
    entity: {
      name: agg.name,
      isRoot: true,
      fields: agg.fields,
      contains: agg.contains,
      derived: agg.derived,
      invariants: agg.invariants,
      functions: agg.functions,
      operations: agg.operations,
    },
  });
  return AGGREGATE_TPL({
    valueObjectAliases,
    enumAliases,
    partsRendered,
    rootRendered,
  });
}

export function renderRepository(agg: AggregateIR, repo: RepositoryIR | undefined): string {
  return REPOSITORY_TPL({ aggregate: agg, finds: repo?.finds ?? [] });
}

export function renderRoutes(agg: AggregateIR, repo: RepositoryIR | undefined): string {
  const publicOps = agg.operations.filter((o) => o.visibility === "public");
  return ROUTES_TPL({
    aggregate: agg,
    publicOperations: publicOps,
    finds: repo?.finds ?? [],
  });
}

export function renderHttpIndex(ctx: BoundedContextIR): string {
  return HTTP_INDEX_TPL({ aggregates: ctx.aggregates });
}

export function renderSchema(ctx: BoundedContextIR): string {
  // Tables are produced procedurally to avoid awkward HBS column logic.
  const tables: string[] = [];
  for (const agg of ctx.aggregates) {
    tables.push(emitTable(agg.name, agg.fields, agg.idValueType, undefined));
    for (const part of agg.parts) {
      tables.push(emitTable(part.name, part.fields, agg.idValueType, agg.name));
    }
  }
  return SCHEMA_TPL({ enums: ctx.enums, tables: tables.join("\n\n") });
}

function emitTable(
  name: string,
  fields: FieldIR[],
  _idValueType: string,
  parentName: string | undefined,
): string {
  const tableName = snake(plural(name));
  const lines: string[] = [];
  lines.push(`export const ${camel(plural(name))} = pgTable("${tableName}", {`);
  lines.push(`  id: text("id").primaryKey(),`);
  if (parentName) {
    lines.push(`  parentId: text("${snake(parentName)}_id").notNull(),`);
  }
  for (const f of fields) {
    lines.push(...drizzleColumnLines(f).map((s) => `  ${s}`));
  }
  lines.push(`});`);
  return lines.join("\n");
}

function drizzleColumnLines(f: FieldIR): string[] {
  const colName = snake(f.name);
  const t = f.type;
  const optional = f.optional || t.kind === "optional";
  const innerType = t.kind === "optional" ? t.inner : t;
  const not = optional ? "" : ".notNull()";
  switch (innerType.kind) {
    case "primitive":
      switch (innerType.name) {
        case "int":
          return [`${f.name}: integer("${colName}")${not},`];
        case "long":
          return [`${f.name}: bigint("${colName}", { mode: "number" })${not},`];
        case "decimal":
          return [`${f.name}: numeric("${colName}")${not},`];
        case "string":
          return [`${f.name}: text("${colName}")${not},`];
        case "bool":
          return [`${f.name}: boolean("${colName}")${not},`];
        case "datetime":
          return [`${f.name}: timestamp("${colName}", { withTimezone: true })${not},`];
        case "guid":
          return [`${f.name}: uuid("${colName}")${not},`];
      }
    /* eslint-disable-next-line no-fallthrough */
    case "id":
      return [`${f.name}: text("${colName}")${not},`];
    case "enum":
      return [`${f.name}: ${camel(innerType.name)}Enum("${colName}")${not},`];
    case "valueobject":
      return [`${f.name}: text("${colName}")${not}, // value-object fields inlined elsewhere`];
    case "entity":
      return [`${f.name}: text("${colName}")${not},`];
    case "array":
      return [`${f.name}: text("${colName}")${not}, // array fields not yet supported`];
    case "optional":
      return drizzleColumnLines({ name: f.name, type: innerType.inner, optional: true });
  }
}

// Suppress unused warnings for IR types referenced solely for typing.
void (null as unknown as ContainmentIR | DerivedIR | EntityPartIR | EnumIR | EventIR | FunctionIR |
  InvariantIR | OperationIR | ParamIR | StmtIR | ValueObjectIR);
