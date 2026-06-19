import { wireShapeFor } from "../../ir/enrich/enrichments.js";
import { createInputFields, forApiRead } from "../../ir/enrich/wire-projection.js";
import type { EnrichedAggregateIR, TypeIR } from "../../ir/types/loom-ir.js";
import { peelCollection, peelNullable, wireTypeInfo } from "../../ir/types/wire-types.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Per-aggregate Angular API module (`src/api/<agg>.ts`).
//
// IDIOMATIC ANGULAR, not the React/Vue TanStack module: a `@Injectable`
// service wraps `HttpClient`, and a `use<Op><Agg>()` factory returns a
// signal-backed read handle (`{ data, isLoading, isError }`) the page-shell
// hoists as a class field.  The factory mirrors the TanStack result shape so
// the SHARED QueryView walker's `<handle>.isLoading` / `.data` accesses line
// up — only the read syntax diverges (Angular signals are called: `()`),
// which the angular QueryView template + the `renderQueryDataAccess` seam own.
//
// Response types are plain TS interfaces derived from the aggregate's
// `wireShape` (the same ordered field list every backend's DTO emitter
// consumes).  Primitive + id fields map precisely; value-object / enum /
// nested-entity fields fall back to `unknown` for now (the read path only
// needs the collection shape — precise nested typing is a later slice).
//
// Batch scope (Slice 4b — data path sub-slice A): the `findAll` collection
// read only.  `byId` / mutations / find-params land in following sub-slices.
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
      `/** Signal-backed \`${op.name}\` operation mutation.  \`mutate\` takes the`,
      " *  record id AT CALL TIME (not hoist time) so an async QueryView record —",
      " *  resolved after the component's field initialisers run — still targets the",
      " *  right row; it POSTs the op params and resolves when the command lands. */",
      `export function use${upperFirst(op.name)}${single}() {`,
      `  const service = inject(${serviceName});`,
      "  const isPending = signal(false);",
      "  const error = signal<unknown>(null);",
      `  const mutate = (id: string, input: ${reqType}): Promise<void> => {`,
      "    isPending.set(true);",
      "    error.set(null);",
      `    return firstValueFrom(service.${op.name}(id, input))`,
      "      .catch((e) => {",
      "        error.set(e);",
      "        throw e;",
      "      })",
      "      .finally(() => isPending.set(false));",
      "  };",
      "  return { mutate, isPending, error };",
      "}",
      "",
    ];
  });

  return lines(
    "// Auto-generated.  Do not edit by hand.",
    'import { HttpClient } from "@angular/common/http";',
    'import { Injectable, inject, signal } from "@angular/core";',
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
    "/** Signal-backed `findAll` read — hoisted as a component field; the",
    " *  injection context is the field initializer.  Mirrors the TanStack",
    " *  result shape (`data` / `isLoading` / `isError`) the shared QueryView",
    " *  walker consumes, with signals read via `()` in the angular template. */",
    `export function ${allFn}() {`,
    `  const service = inject(${serviceName});`,
    `  const data = signal<${responseName}[]>([]);`,
    "  const isLoading = signal(true);",
    "  const isError = signal(false);",
    "  service.findAll().subscribe({",
    "    next: (rows) => {",
    "      data.set(rows);",
    "      isLoading.set(false);",
    "    },",
    "    error: () => {",
    "      isError.set(true);",
    "      isLoading.set(false);",
    "    },",
    "  });",
    "  return { data, isLoading, isError };",
    "}",
    "",
    "/** Signal-backed `findById` read — the single-record sibling of the",
    " *  collection factory.  `data` is `null` until the row resolves; the shared",
    " *  QueryView walker's detail-lambda reads it via `()` like the list case.",
    " *  `id` is nullable (mirrors the TanStack `enabled: !!id` guard): an absent",
    " *  route param skips the fetch and settles immediately. */",
    `export function ${byIdFn}(id: string | undefined) {`,
    `  const service = inject(${serviceName});`,
    `  const data = signal<${responseName} | null>(null);`,
    "  const isLoading = signal(true);",
    "  const isError = signal(false);",
    "  if (id) {",
    "    service.findById(id).subscribe({",
    "      next: (row) => {",
    "        data.set(row);",
    "        isLoading.set(false);",
    "      },",
    "      error: () => {",
    "        isError.set(true);",
    "        isLoading.set(false);",
    "      },",
    "    });",
    "  } else {",
    "    isLoading.set(false);",
    "  }",
    "  return { data, isLoading, isError };",
    "}",
    "",
    "/** Signal-backed create mutation — hoisted as a component field; `mutate`",
    " *  POSTs the form payload and resolves with the new id.  `isPending` /",
    " *  `error` are signals the form template reads via `()`. */",
    `export function ${createFn}() {`,
    `  const service = inject(${serviceName});`,
    "  const isPending = signal(false);",
    "  const error = signal<unknown>(null);",
    `  const mutate = (input: ${createName}): Promise<{ id: string }> => {`,
    "    isPending.set(true);",
    "    error.set(null);",
    "    return firstValueFrom(service.create(input))",
    "      .catch((e) => {",
    "        error.set(e);",
    "        throw e;",
    "      })",
    "      .finally(() => isPending.set(false));",
    "  };",
    "  return { mutate, isPending, error };",
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
