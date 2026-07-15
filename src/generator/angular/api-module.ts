import { createInputFields, forApiRead, wireFieldsFor } from "../../ir/enrich/wire-projection.js";
import {
  PAGED_DEFAULT_PAGE,
  PAGED_DEFAULT_PAGE_SIZE,
  pagedReturn,
} from "../../ir/stdlib/generics.js";
import { unionReturn, variantTag } from "../../ir/stdlib/unions.js";
import type {
  BoundedContextIR,
  EnrichedAggregateIR,
  FindIR,
  RepositoryIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
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

/** Parameterised finds (everything but the auto `all`) the aggregate's
 *  repository declares — each lowers to a `GET /<tag>/<find>?<params>` route +
 *  an `injectQuery` factory keyed on the rendered params. */
function paramFinds(repo: RepositoryIR | undefined): FindIR[] {
  return (repo?.finds ?? []).filter((f) => f.name !== "all");
}

/** The `<Op><Agg>Response` discriminated-union alias for a union-returning
 *  operation (async-actions-and-effects.md Stage 2) — the TS analogue of the
 *  React api-module's zod discriminated union.  Each variant is tagged on the
 *  wire `type` discriminator (the cross-backend P4 convention): a success
 *  entity/value-object intersects its response interface with the tag literal;
 *  an error payload becomes an object of its own fields plus the tag (never seen
 *  at 200 — it exists so the reified-error cast + arm binding typecheck). */
function unionResponseTypeName(opName: string, agg: EnrichedAggregateIR): string {
  return `${upperFirst(opName)}${agg.name}Response`;
}

function emitAngularUnionResponseType(
  opName: string,
  agg: EnrichedAggregateIR,
  variants: TypeIR[],
  bc: BoundedContextIR | undefined,
): string[] {
  const name = unionResponseTypeName(opName, agg);
  const member = (v: TypeIR): string => {
    const lit = `type: ${JSON.stringify(variantTag(v))}`;
    if (v.kind === "entity") {
      const payload = bc?.payloads.find((p) => p.name === v.name);
      if (payload?.kind === "error") {
        // Error variant — an object type of the payload's own fields plus the tag.
        const fields = payload.fields.map(
          (f) => `${f.name}${f.optional ? "?" : ""}: ${wireTsType(f.type)}`,
        );
        return `{ ${[lit, ...fields].join("; ")} }`;
      }
      // Success entity (typically the aggregate) — intersect its response type.
      return `(${v.name}Response & { ${lit} })`;
    }
    if (v.kind === "valueobject") return `(${v.name}Response & { ${lit} })`;
    if (v.kind === "none") return `{ ${lit} }`;
    // Scalar / id variant — the tagged `{ type, value }` carrier.
    return `{ ${lit}; value: ${wireTsType(v)} }`;
  };
  const memberLines = variants.map((v) => `  | ${member(v)}`);
  if (memberLines.length > 0) memberLines[memberLines.length - 1] += ";";
  return [`export type ${name} =`, ...memberLines, ""];
}

/** Emit the `src/api/<agg>.ts` module for one aggregate. */
export function buildAngularApiModule(
  agg: EnrichedAggregateIR,
  repo?: RepositoryIR,
  bc?: BoundedContextIR,
): string {
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
  const deleteFn = `useDelete${single}`;
  // The canonical destroy (declared `destroy { }` or via `crudish`) drives the
  // `DELETE /<tag>/{id}` route + `useDelete<Agg>` factory the `DestroyForm`
  // renderer hoists.  Plain aggregates' modules stay delete-free.
  const hasDelete = !!agg.canonicalDestroy;

  // Paged-by-default findAll (M-T2.6): a paged `all` returns the `<Agg>Paged`
  // envelope and accepts a page/pageSize/sort/dir query getter.  A user-declared
  // non-paged `find all(): T[]` keeps the legacy no-arg array shape.
  const allFind = repo?.finds.find((f) => f.name === "all");
  const allPaged = allFind ? pagedReturn(allFind.returnType) : null;
  const pagedName = `${single}Paged`;

  const fields = forApiRead(wireFieldsFor(agg));
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
  const opMethods = ops.flatMap((op) => {
    // A union-returning op (`operation foo(): X or Err`) serves the FULL tagged
    // union at 200 — the service method types the response as the discriminated
    // union so `mutateAsync` resolves the tagged variant; a plain op stays `void`.
    const respType =
      op.returnType && unionReturn(op.returnType) ? unionResponseTypeName(op.name, agg) : "void";
    return [
      "",
      `  ${op.name}(id: string, input: ${upperFirst(op.name)}${single}Request) {`,
      `    return this.http.post<${respType}>(\`\${API_BASE_URL}/${tag}/\${id}/${op.name}\`, input);`,
      "  }",
    ];
  });
  const opFactories = ops.flatMap((op) => {
    const reqType = `${upperFirst(op.name)}${single}Request`;
    const u = op.returnType ? unionReturn(op.returnType) : null;
    if (u) {
      // Union-returning op (async-actions-and-effects.md Stage 2): bind the record
      // `id` at hook time (mirroring the React op-mutation shape the awaiting
      // action's variant-match envelope expects) so `mutateAsync(input)` resolves
      // the parsed tagged union.  The client never receives the error variant at
      // 200 — it's intercepted into a non-2xx ProblemDetails and reified from the
      // thrown `ApiError` at the call site — but the type carries every arm so the
      // action's `switch (result.type)` narrows.
      return [
        `/** \`${op.name}\` union-returning operation mutation (TanStack \`injectMutation\`).`,
        " *  `mutateAsync(input)` POSTs the payload and resolves with the tagged",
        " *  success variant; on success it invalidates the affected record + the",
        " *  collection so the cached reads refetch. */",
        `export function use${upperFirst(op.name)}${single}(id: string) {`,
        `  const service = inject(${serviceName});`,
        "  const queryClient = inject(QueryClient);",
        "  return injectMutation(() => ({",
        `    mutationFn: (input: ${reqType}) => firstValueFrom(service.${op.name}(id, input)),`,
        "    onSuccess: () =>",
        `      queryClient`,
        `        .invalidateQueries({ queryKey: ["${oneTag}", id] })`,
        `        .then(() => queryClient.invalidateQueries({ queryKey: ["${tag}"] })),`,
        "  }));",
        "}",
        "",
      ];
    }
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
  // Union-returning-operation response TYPES (emitted before the service so the
  // service method + factory can reference them).
  const opUnionTypes = ops.flatMap((op) => {
    const u = op.returnType ? unionReturn(op.returnType) : null;
    return u ? emitAngularUnionResponseType(op.name, agg, u.variants, bc) : [];
  });

  // Parameterised finds → a `GET /<tag>/<find>?<params>` service method each +
  // an `injectQuery` factory keyed on the rendered param values.  The find's
  // return type decides the response TS type: an array find returns
  // `<Agg>Response[]`, an optional/single find `<Agg>Response | null`.  (Paged /
  // discriminated-union returns fall back to the list shape — the precise
  // envelope typing is a later slice; the read path only needs the row shape.)
  const finds = paramFinds(repo);
  const findReturnTs = (f: FindIR): string =>
    f.returnType.kind === "array"
      ? `${responseName}[]`
      : f.returnType.kind === "optional"
        ? `${responseName} | null`
        : responseName;
  // The find query type — the shared walker (`adjustFindHookArgs`) renders a
  // find's args into a single `{ <param>: <value>, … }` object, so the Angular
  // factory takes one `<Find><Agg>Query` object (matching that call shape) and
  // the service method spreads it into the query string.
  const findQueryType = (f: FindIR): string => `${upperFirst(f.name)}${single}Query`;
  const findQueryInterfaces = finds.flatMap((f) => [
    `export interface ${findQueryType(f)} {`,
    ...f.params.map((p) => `  ${p.name}: ${wireTsType(p.type)};`),
    "}",
    "",
  ]);
  const findMethods = finds.flatMap((f) => {
    const findSnake = snake(f.name);
    return [
      "",
      `  ${f.name}(query: ${findQueryType(f)}) {`,
      "    const qs = new URLSearchParams(",
      "      Object.entries(query).map(([k, v]) => [k, String(v)]),",
      "    ).toString();",
      `    return this.http.get<${findReturnTs(f)}>(\`\${API_BASE_URL}/${tag}/${findSnake}\${qs ? "?" + qs : ""}\`);`,
      "  }",
    ];
  });
  const findFactories = finds.flatMap((f) => {
    const fn = `use${upperFirst(f.name)}${single}`;
    return [
      `/** \`${f.name}\` parameterised find (TanStack \`injectQuery\`) — hoisted as a`,
      " *  component field; the field initializer is the injection context.  Takes",
      " *  a REACTIVE getter (not a snapshot): the `injectQuery(() => …)` options",
      " *  callback re-reads `query()` so a page-state-bound filter live-refetches",
      " *  (the query key + fetch track the getter).  Keyed on the resolved query as",
      " *  the shared cache's `[tag, find, name, query]` entry. */",
      `export function ${fn}(query: () => ${findQueryType(f)}) {`,
      `  const service = inject(${serviceName});`,
      "  return injectQuery(() => ({",
      `    queryKey: ["${tag}", "find", "${snake(f.name)}", query()] as const,`,
      `    queryFn: () => firstValueFrom(service.${f.name}(query())),`,
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
    ...opUnionTypes,
    ...findQueryInterfaces,
    // Paged-by-default findAll envelope + query input (M-T2.6).
    ...(allPaged
      ? [
          `export interface ${pagedName} {`,
          `  items: ${responseName}[];`,
          "  page: number;",
          "  pageSize: number;",
          "  total: number;",
          "  totalPages: number;",
          "}",
          "",
          "export interface AllQuery {",
          "  page?: number;",
          "  pageSize?: number;",
          "  sort?: string;",
          "  dir?: string;",
          "}",
          "",
        ]
      : []),
    `@Injectable({ providedIn: "root" })`,
    `export class ${serviceName} {`,
    "  private readonly http = inject(HttpClient);",
    "",
    ...(allPaged
      ? [
          `  findAll(query: AllQuery = {}) {`,
          `    const q = { page: ${PAGED_DEFAULT_PAGE}, pageSize: ${PAGED_DEFAULT_PAGE_SIZE}, sort: "id", dir: "asc", ...query };`,
          "    const qs = new URLSearchParams(",
          "      Object.entries(q).map(([k, v]) => [k, String(v)]),",
          "    ).toString();",
          `    return this.http.get<${pagedName}>(\`\${API_BASE_URL}/${tag}\${qs ? "?" + qs : ""}\`);`,
          "  }",
        ]
      : [
          `  findAll() {`,
          `    return this.http.get<${responseName}[]>(\`\${API_BASE_URL}/${tag}\`);`,
          "  }",
        ]),
    "",
    `  findById(id: string) {`,
    `    return this.http.get<${responseName}>(\`\${API_BASE_URL}/${tag}/\${id}\`);`,
    "  }",
    "",
    `  create(input: ${createName}) {`,
    `    return this.http.post<{ id: string }>(\`\${API_BASE_URL}/${tag}\`, input);`,
    "  }",
    ...(hasDelete
      ? [
          "",
          `  delete(id: string) {`,
          `    return this.http.delete<void>(\`\${API_BASE_URL}/${tag}/\${id}\`);`,
          "  }",
        ]
      : []),
    ...opMethods,
    ...findMethods,
    "}",
    "",
    "/** `findAll` query (TanStack `injectQuery`) — hoisted as a component field;",
    " *  the injection context is the field initializer.  The shared query cache,",
    " *  keyed by the collection tag, dedupes concurrent reads and is invalidated",
    " *  by the matching mutations.  `data` (a `T[] | undefined` signal — defaulted",
    " *  to `[]` at the read site) / `isLoading` / `isError` are read via `()`. */",
    ...(allPaged
      ? [
          `export function ${allFn}(query: () => AllQuery = () => ({})) {`,
          `  const service = inject(${serviceName});`,
          `  return injectQuery(() => ({`,
          `    queryKey: ["${tag}", "list", query()] as const,`,
          `    queryFn: () => firstValueFrom(service.findAll(query())),`,
          `  }));`,
          "}",
        ]
      : [
          `export function ${allFn}() {`,
          `  const service = inject(${serviceName});`,
          `  return injectQuery(() => ({`,
          `    queryKey: ["${tag}"] as const,`,
          `    queryFn: () => firstValueFrom(service.findAll()),`,
          `  }));`,
          "}",
        ]),
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
    // Delete mutation (canonical destroy) — `mutateAsync(id)` DELETEs the record
    // and invalidates the collection so the list refetches.  `isPending` is a
    // signal the confirm-delete button reads via `()`.
    ...(hasDelete
      ? [
          `export function ${deleteFn}() {`,
          `  const service = inject(${serviceName});`,
          "  const queryClient = inject(QueryClient);",
          "  return injectMutation(() => ({",
          `    mutationFn: (id: string) => firstValueFrom(service.delete(id)),`,
          `    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["${tag}"] }),`,
          "  }));",
          "}",
          "",
        ]
      : []),
    ...opFactories,
    ...findFactories,
    // Reference the var names the page-shell will hoist so the naming stays
    // discoverable next to the factories.
    `// hoisted as: readonly ${allVar} = ${allFn}();`,
    `// hoisted as: readonly ${lowerFirst(single)}Create = ${createFn}();`,
    "",
  );
}
