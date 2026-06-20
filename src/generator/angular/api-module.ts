import { wireShapeFor } from "../../ir/enrich/enrichments.js";
import { createInputFields, forApiRead } from "../../ir/enrich/wire-projection.js";
import type { EnrichedAggregateIR, TypeIR } from "../../ir/types/loom-ir.js";
import { peelCollection, peelNullable, wireTypeInfo } from "../../ir/types/wire-types.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Per-aggregate Angular API module (`src/api/<agg>.ts`).
//
// TanStack Angular Query (the senior-Angular-idiomatic server-state layer): a
// `@Injectable` service wraps `HttpClient` for the raw requests, and each
// `use<Op><Agg>()` factory returns a TanStack `injectQuery` / `injectMutation`
// result the page-shell hoists as a class field (the field initializer is the
// injection context both require).  Reads share the query cache (dedup +
// caching), keyed by the collection / record tag; mutations invalidate exactly
// the keys the generator knows they touch.  The result shape (`data` /
// `isLoading` / `isError` / `mutate*`) is what the SHARED QueryView walker
// reads — only the signal-call syntax diverges (`()`), owned by the angular
// QueryView template + the `renderQueryDataAccess` seam.
//
// Response types are plain TS interfaces derived from the aggregate's
// `wireShape` (the same ordered field list every backend's DTO emitter
// consumes).  Primitive + id fields map precisely; value-object / enum /
// nested-entity fields fall back to `unknown` for now (the read path only
// needs the collection shape — precise nested typing is a later slice).
// ---------------------------------------------------------------------------

/** Map a wire `TypeIR` to a TS type string for a response interface field. */
function wireTsType(t: TypeIR): string {
  const info = wireTypeInfo(t, "response");
  if (info.isNullable) return `${wireTsType(peelNullable(t))} | null`;
  if (info.isCollection) return `${wireTsType(peelCollection(t))}[]`;
  switch (info.refKind) {
    case "primitive":
      switch (info.primitive) {
        case "int":
        case "long":
        case "decimal":
          return "number";
        // Money rides the wire as a decimal string; `formatMoney` accepts it.
        case "money":
          return "string";
        case "bool":
          return "boolean";
        case "string":
        case "datetime":
        case "guid":
          return "string";
        default:
          return "unknown";
      }
    case "id":
      return "string";
    // Enums / value objects / nested entities: the collection read path
    // doesn't dereference them yet — keep the field present but untyped.
    default:
      return "unknown";
  }
}

/** Emit the `src/api/<agg>.ts` module for one aggregate. */
export function buildAngularApiModule(agg: EnrichedAggregateIR): string {
  const single = agg.name;
  const serviceName = `${single}Service`;
  const responseName = `${single}Response`;
  const createName = `Create${single}Request`;
  const tag = snake(plural(single));
  const oneTag = snake(single);
  const allFn = `useAll${plural(single)}`;
  const allVar = `${lowerFirst(single)}All`;
  const byIdFn = `use${single}ById`;
  const createFn = `useCreate${single}`;

  const fields = forApiRead(wireShapeFor(agg));
  const createFields = createInputFields(agg);

  // Public domain operations → a `POST /<tag>/:id/<op>` mutation each
  // (request type = op params, mirrors the React op-mutation shape).  The
  // op-form / Modal renderers hoist `use<Op><Agg>(id)` and submit its params.
  const ops = agg.operations.filter((o) => o.visibility === "public");
  const opRequests = ops.flatMap((op) => [
    `export interface ${upperFirst(op.name)}${single}Request {`,
    ...op.params.map((p) => `  ${p.name}: ${wireTsType(p.type)};`),
    "}",
    "",
  ]);
  const opMethods = ops.flatMap((op) => [
    "",
    `  ${op.name}(id: string, input: ${upperFirst(op.name)}${single}Request) {`,
    `    return this.http.post<void>(\`\${API_BASE_URL}/${tag}/\${id}/${op.name}\`, input);`,
    "  }",
  ]);
  const opFactories = ops.flatMap((op) => {
    const reqType = `${upperFirst(op.name)}${single}Request`;
    return [
      `/** \`${op.name}\` operation mutation (TanStack \`injectMutation\`).  Call`,
      " *  `mutateAsync({ id, input })` — the variables carry the record id, so an",
      " *  async QueryView record (resolved after field initialisers run) still",
      " *  targets the right row.  On success it invalidates exactly the affected",
      " *  record + the collection, so the cached reads refetch. */",
      `export function use${upperFirst(op.name)}${single}() {`,
      `  const service = inject(${serviceName});`,
      "  const queryClient = inject(QueryClient);",
      "  return injectMutation(() => ({",
      `    mutationFn: (vars: { id: string; input: ${reqType} }) =>`,
      `      firstValueFrom(service.${op.name}(vars.id, vars.input)),`,
      "    onSuccess: (_data, vars) =>",
      `      queryClient`,
      `        .invalidateQueries({ queryKey: ["${oneTag}", vars.id] })`,
      `        .then(() => queryClient.invalidateQueries({ queryKey: ["${tag}"] })),`,
      "  }));",
      "}",
      "",
    ];
  });

  return lines(
    "// Auto-generated.  Do not edit by hand.",
    'import { HttpClient } from "@angular/common/http";',
    'import { Injectable, inject } from "@angular/core";',
    'import { QueryClient, injectMutation, injectQuery } from "@tanstack/angular-query-experimental";',
    'import { firstValueFrom } from "rxjs";',
    'import { API_BASE_URL } from "./config";',
    "",
    `export interface ${responseName} {`,
    ...fields.map((f) => `  ${f.name}: ${f.source === "id" ? "string" : wireTsType(f.type)};`),
    "}",
    "",
    // Client-suppliable create payload (server-controlled fields dropped).
    `export interface ${createName} {`,
    ...createFields.map((f) => `  ${f.name}: ${wireTsType(f.type)};`),
    "}",
    "",
    ...opRequests,
    `@Injectable({ providedIn: "root" })`,
    `export class ${serviceName} {`,
    "  private readonly http = inject(HttpClient);",
    "",
    `  findAll() {`,
    `    return this.http.get<${responseName}[]>(\`\${API_BASE_URL}/${tag}\`);`,
    "  }",
    "",
    `  findById(id: string) {`,
    `    return this.http.get<${responseName}>(\`\${API_BASE_URL}/${tag}/\${id}\`);`,
    "  }",
    "",
    `  create(input: ${createName}) {`,
    `    return this.http.post<{ id: string }>(\`\${API_BASE_URL}/${tag}\`, input);`,
    "  }",
    ...opMethods,
    "}",
    "",
    "/** `findAll` query (TanStack `injectQuery`) — hoisted as a component field;",
    " *  the injection context is the field initializer.  The shared query cache,",
    " *  keyed by the collection tag, dedupes concurrent reads and is invalidated",
    " *  by the matching mutations.  `data` (a `T[] | undefined` signal — defaulted",
    " *  to `[]` at the read site) / `isLoading` / `isError` are read via `()`. */",
    `export function ${allFn}() {`,
    `  const service = inject(${serviceName});`,
    `  return injectQuery(() => ({`,
    `    queryKey: ["${tag}"] as const,`,
    `    queryFn: () => firstValueFrom(service.findAll()),`,
    `  }));`,
    "}",
    "",
    "/** `findById` query — the single-record sibling.  `enabled: !!id` keeps the",
    " *  query idle (no request) when the route param is absent; the record is",
    " *  cached under `[tag, id]`, so an op-mutation can later invalidate exactly",
    " *  this row.  `data` is `T | undefined` until it resolves. */",
    `export function ${byIdFn}(id: string | undefined) {`,
    `  const service = inject(${serviceName});`,
    `  return injectQuery(() => ({`,
    `    queryKey: ["${oneTag}", id] as const,`,
    `    queryFn: () => firstValueFrom(service.findById(id as string)),`,
    `    enabled: !!id,`,
    `  }));`,
    "}",
    "",
    "/** Create mutation (TanStack `injectMutation`) — hoisted as a component",
    " *  field; `mutateAsync(input)` POSTs the form payload and resolves with the",
    " *  new id.  On success it invalidates the collection query so the list",
    " *  refetches.  `isPending` is a signal the form template reads via `()`. */",
    `export function ${createFn}() {`,
    `  const service = inject(${serviceName});`,
    "  const queryClient = inject(QueryClient);",
    "  return injectMutation(() => ({",
    `    mutationFn: (input: ${createName}) => firstValueFrom(service.create(input)),`,
    `    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["${tag}"] }),`,
    "  }));",
    "}",
    "",
    ...opFactories,
    // Reference the var names the page-shell will hoist so the naming stays
    // discoverable next to the factories.
    `// hoisted as: readonly ${allVar} = ${allFn}();`,
    `// hoisted as: readonly ${lowerFirst(single)}Create = ${createFn}();`,
    "",
  );
}
