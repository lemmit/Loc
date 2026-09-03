// ---------------------------------------------------------------------------
// Typed in-system api client (M-T4.8) — the .NET caller half.
//
// Third sibling of `src/platform/hono/v4/adapters/api-client.ts` and
// `src/generator/python/api-client.ts`; same contract, C# idiom.  One
// `public static async Task<T> <Resource>_<OperationId>(...)` per operation the
// CALLEE exposes, replacing the untyped `Get(path)` / `Post(path, body)` verbs
// the `storage restApi` binding carries.
//
// Both halves stay derived, so neither can drift from the callee:
//   - paths from `deriveContextOperations` (what the callee actually mounts),
//   - the response record from `forApiRead(wireFieldsForAggregate(...))` (the
//     field list the callee serializes).
//
// The boundary check is `JsonSerializer.Deserialize` + an explicit null guard,
// the C# analogue of zod's `.parse` / pydantic's `model_validate`.  It is
// weaker than either — System.Text.Json fills missing members with defaults
// rather than raising — so the null guard is the part that must not be
// dropped: without it a body the callee never sent becomes a `null` that
// surfaces three frames later as a NullReferenceException.
//
// `PropertyNameCaseInsensitive` is load-bearing, not defensive tidiness.  The
// callee serializes camelCase (`orderCode`); the record's members are Pascal
// (`OrderCode`).  Without it every field silently deserializes to its default
// and the call "succeeds" carrying nothing — precisely the class of runtime
// defect the compile gates cannot see, which is why the runtime e2e exists.
// ---------------------------------------------------------------------------

import { forApiRead, wireFieldsForAggregate } from "../../../ir/enrich/wire-projection.js";
import type { AggregateIR, SystemIR, TypeIR } from "../../../ir/types/loom-ir.js";
import {
  type ApiResourceBinding,
  servedContextsFor,
} from "../../../ir/util/api-resource-binding.js";
import {
  type ApiOperationIR,
  absenceUnionSuccess,
  collectionSuccess,
  deriveContextOperations,
} from "../../../ir/util/api-surface.js";
import { escapeCsharpIdent, lowerFirst, upperFirst } from "../../../util/naming.js";
import { resourceEnvUrlVar } from "../../../util/resource-env.js";
// `API_CLIENT_CLASS` lives in `render-expr.ts`, not here: this module already
// imports `renderCsType` from there, and owning the name here too would make
// the pair mutually importing.  One direction, one home for the name.
import { API_CLIENT_CLASS, renderCsType } from "../render-expr.js";

/** The aggregate an operation answers with, looked up ACROSS the system — the
 *  callee's context belongs to another deployable, so it is not in the caller's
 *  own `contexts`. */
function aggregateNamed(sys: SystemIR, name: string): AggregateIR | undefined {
  for (const sd of sys.subdomains) {
    for (const ctx of sd.contexts) {
      const agg = ctx.aggregates.find((a) => a.name === name);
      if (agg) return agg;
    }
  }
  return undefined;
}

/** C# parameter type.  Ids and path/query scalars ride the wire as `string`; an
 *  entity-typed body is the callee's createInput projection, which the caller
 *  does not model — `object` rather than a false precision. */
function csParamType(t: TypeIR): string {
  if (t.kind === "id") return "string";
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
        return "int";
      case "long":
        return "long";
      case "decimal":
      case "money":
        return "decimal";
      case "bool":
        return "bool";
      default:
        return "string";
    }
  }
  return "object";
}

/** A C# parameter identifier for an operation param — camel, and escaped when
 *  the name collides with a C# keyword. */
function arg(name: string): string {
  return escapeCsharpIdent(lowerFirst(name));
}

/** `/api/orders/{id}` → an interpolated C# string with path params escaped. */
function pathExpr(op: ApiOperationIR): string {
  let out = op.path;
  let interpolated = false;
  for (const p of op.params) {
    if (p.location !== "path") continue;
    out = out.replace(
      `{${p.name}}`,
      `{Uri.EscapeDataString(${arg(p.name)}?.ToString() ?? string.Empty)}`,
    );
    interpolated = true;
  }
  return interpolated ? `$"${out}"` : `"${out}"`;
}

/** A `record` mirroring the aggregate's read wire shape — the same walk the
 *  callee serializes from. */
function responseRecord(agg: AggregateIR, recordName: string): string[] {
  const fields = forApiRead(wireFieldsForAggregate(agg));
  if (fields.length === 0) return [`    public sealed record ${recordName}();`];
  const members = fields.map((wf) => {
    const t = wf.source === "id" ? "string" : renderCsType(wf.type);
    // Mirror the CALLEE's optionality rather than making everything nullable.
    // Blanket-nullable compiles here but moves the problem one frame out: the
    // caller then passes `string?` into a domain factory that wants `string`,
    // and `/warnaserror` rejects THAT instead (CS8604).  Deriving nullability
    // from `wf.optional` is also just what the wire contract says.
    //
    // Honest limit: System.Text.Json will still bind null into a non-nullable
    // member if the callee omits a required field, where zod's `.parse` and
    // pydantic's `model_validate` would raise.  The .NET client's boundary
    // check is therefore weaker than its two siblings — the null guard on the
    // deserialized ROOT is real, per-field presence is not.
    const optional = wf.optional || t.endsWith("?");
    const rendered = optional && !t.endsWith("?") ? `${t}?` : t;
    return `        ${rendered} ${upperFirst(wf.name)}`;
  });
  return [`    public sealed record ${recordName}(`, `${members.join(",\n")});`];
}

/** Emit `Resources/ApiClients.cs`, or nothing when this deployable binds no
 *  in-system api (the gate that keeps existing projects byte-identical). */
export function emitDotnetApiClients(
  bindings: readonly ApiResourceBinding[],
  sys: SystemIR,
  ns: string,
): string | undefined {
  if (bindings.length === 0) return undefined;

  const records: string[] = [];
  const methods: string[] = [];
  const emittedRecords = new Set<string>();

  for (const b of bindings) {
    const envVar = resourceEnvUrlVar(b.resource.name);
    const res = upperFirst(b.resource.name);
    methods.push(
      `        // ---- ${b.resource.name} -> api '${b.apiName}' (served by '${b.server.name}')`,
      `        private static readonly string ${res}BaseUrl =`,
      `            Environment.GetEnvironmentVariable("${envVar}") ?? "http://localhost:3000";`,
      "",
    );

    for (const ctx of servedContextsFor(b, sys)) {
      for (const op of deriveContextOperations(ctx)) {
        // An ABSENCE union deserializes the same record as a plain entity
        // response — the callee answers the success body directly at 200 and
        // rides absence on 404, no `type` discriminator (payloads.md §Union
        // finds).  Only the absent status differs: `null`, not a throw.
        const absentAgg = absenceUnionSuccess(op.responseType);
        // A COLLECTION response deserializes the same per-row record, wrapped:
        // the auto-`findAll` answers with the paged envelope, a declared `T[]`
        // find with a bare array.  Without this arm both returned a bare `Task`
        // — the call was made and every row discarded.
        const coll = collectionSuccess(op.responseType);
        const respAgg =
          op.responseType?.kind === "entity" ? op.responseType.name : (absentAgg ?? coll?.agg);
        const agg = respAgg ? aggregateNamed(sys, respAgg) : undefined;
        const recordName = agg ? `${agg.name}Response` : undefined;
        if (agg && recordName && !emittedRecords.has(recordName)) {
          emittedRecords.add(recordName);
          records.push(...responseRecord(agg, recordName), "");
        }
        // The paged envelope mirrors the callee's `<Agg>Paged` field for field.
        // Members are non-nullable value types with defaults: the callee always
        // sends all five, and a nullable `int?` would push the null check onto
        // every call site.
        // The SHIPPED create route answers `201 {id}` — not the whole entity
        // its declared responseType names.  Deserializing the entity record
        // against that body leaves every other member null, at RUNTIME.
        const createName = agg && op.kind === "create" ? `${agg.name}Created` : undefined;
        if (createName && !emittedRecords.has(createName)) {
          emittedRecords.add(createName);
          records.push(`    public sealed record ${createName}(string Id);`, "");
        }
        const pagedName = agg && coll?.carrier === "paged" ? `${agg.name}Paged` : undefined;
        if (pagedName && recordName && !emittedRecords.has(pagedName)) {
          emittedRecords.add(pagedName);
          records.push(
            `    public sealed record ${pagedName}(`,
            `        System.Collections.Generic.List<${recordName}> Items,`,
            "        int Page,",
            "        int PageSize,",
            "        int Total,",
            "        int TotalPages);",
            "",
          );
        }
        // The deserialized shape and the declared return move together.
        const respType = createName
          ? createName
          : pagedName
            ? pagedName
            : recordName && coll
              ? `System.Collections.Generic.List<${recordName}>`
              : recordName;

        const bodyParams = op.params.filter((p) => p.location === "body");
        // Two body shapes, both derived (api-surface.ts): `create` carries ONE
        // whole-shape param, while a domain operation carries one per declared
        // argument, which the callee reads as a flat JSON object.  Serializing
        // only the first silently drops every argument after it.
        const wholeShapeBody = bodyParams.length === 1 && bodyParams[0]?.type.kind === "entity";
        const query = op.params.filter((p) => p.location === "query");
        const params = op.params.map((p) => `${csParamType(p.type)} ${arg(p.name)}`);
        const ret = respType ? `Task<${respType}${absentAgg ? "?" : ""}>` : "Task";

        methods.push(
          `        public static async ${ret} ${res}_${upperFirst(op.id)}(${params.join(", ")})`,
          "        {",
          `            var path = ${pathExpr(op)};`,
        );
        if (query.length > 0) {
          methods.push(
            `            path += "?" + string.Join("&", new[] {`,
            ...query.map(
              (q) =>
                `                $"${q.name}={Uri.EscapeDataString(${arg(q.name)}?.ToString() ?? string.Empty)}",`,
            ),
            "            });",
          );
        }
        methods.push(
          `            using var req = new HttpRequestMessage(new HttpMethod("${op.method.toUpperCase()}"), ${res}BaseUrl + path);`,
        );
        if (bodyParams.length > 0) {
          const payload = wholeShapeBody
            ? arg(bodyParams[0]?.name ?? "body")
            : `new Dictionary<string, object?> { ${bodyParams.map((p) => `[${JSON.stringify(p.name)}] = ${arg(p.name)}`).join(", ")} }`;
          methods.push(
            `            req.Content = new StringContent(JsonSerializer.Serialize(${payload}, JsonOpts), Encoding.UTF8, "application/json");`,
          );
        }
        methods.push("            using var res = await Http.SendAsync(req);");
        if (absentAgg) {
          // Absence is a VALUE the caller matches on, not a failure.
          methods.push(
            "            if ((int)res.StatusCode == 404)",
            "                return null;",
          );
        }
        methods.push(
          "            if (!res.IsSuccessStatusCode)",
          `                throw new RemoteCallException(${JSON.stringify(b.resource.name)}, ${JSON.stringify(op.id)}, (int)res.StatusCode);`,
        );
        if (respType) {
          methods.push(
            // `__payload`, not `body`: a whole-shape create takes a PARAMETER
            // named `body`, and a local of the same name is a C# compile error
            // — invisible to every vitest-tier assertion.
            "            var __payload = await res.Content.ReadAsStringAsync();",
            `            return JsonSerializer.Deserialize<${respType}>(__payload, JsonOpts)`,
            `                ?? throw new RemoteCallException(${JSON.stringify(b.resource.name)}, ${JSON.stringify(op.id)}, (int)res.StatusCode);`,
          );
        }
        methods.push("        }", "");
      }
    }
  }

  return [
    "// Auto-generated by Loom.  Typed in-system api clients.",
    "using System;",
    "using System.Collections.Generic;",
    "using System.Net.Http;",
    "using System.Text;",
    "using System.Text.Json;",
    "using System.Threading.Tasks;",
    "",
    `namespace ${ns}.Resources;`,
    "",
    "/// <summary>Raised when an in-system call answers with a status the callee's",
    "/// contract does not describe as a success.  Carries the status so a caller",
    "/// can branch on it rather than string-matching a message.</summary>",
    "public sealed class RemoteCallException : Exception",
    "{",
    "    public RemoteCallException(string resource, string operationId, int status)",
    '        : base($"in-system call {resource}.{operationId} failed with status {status}")',
    "    {",
    "        Resource = resource;",
    "        OperationId = operationId;",
    "        Status = status;",
    "    }",
    "",
    "    public string Resource { get; }",
    "    public string OperationId { get; }",
    "    public int Status { get; }",
    "}",
    "",
    `public static class ${API_CLIENT_CLASS}`,
    "{",
    "    private static readonly HttpClient Http = new HttpClient();",
    "",
    "    // The callee serializes camelCase; these records are Pascal.  Without",
    "    // BOTH halves of this every field deserializes to its default and the",
    "    // call succeeds carrying nothing.",
    "    private static readonly JsonSerializerOptions JsonOpts = new JsonSerializerOptions",
    "    {",
    "        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,",
    "        PropertyNameCaseInsensitive = true,",
    "    };",
    "",
    ...records.map((l) => (l ? l : "")),
    ...methods,
    "}",
    "",
  ].join("\n");
}
