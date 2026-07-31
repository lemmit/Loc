// ---------------------------------------------------------------------------
// Typed in-system api client (M-T4.8 slice 4c) — the Java/Spring Boot caller
// half.
//
// Fourth sibling of the Hono / Python / .NET clients; same contract, Java
// idiom.  One `public static <T> <resource><OperationId>(...)` per operation
// the CALLEE exposes, replacing the untyped `get(path)` / `post(path, body)`
// verbs the `storage restApi` binding carries.
//
// Both halves stay derived, so neither can drift from the callee:
//   - paths from `deriveContextOperations` (what the callee actually mounts),
//   - the response record from `forApiRead(wireFieldsForAggregate(...))` (the
//     field list the callee serializes).
//
// Two deliberate divergences from the .NET sibling:
//
//   - SYNCHRONOUS.  Spring's workflow beans are plain blocking methods, so the
//     client uses `HttpClient.send`, and the call site needs no await wrapper
//     (the .NET arm parenthesises `(await …)` precisely because C# does).
//   - NO new dependency.  `java.net.http.HttpClient` is JDK-native and Jackson
//     already ships with Spring Boot, so `build.gradle.kts` stays byte-identical
//     — unlike the Python client, which had to declare `httpx`.
//
// Record components are BOXED (`Integer`, not `int`): Jackson binds a missing
// field to null, and a null into a primitive component throws at parse time
// with a message that points at the record rather than at the callee.
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
import { escapeJavaIdent, lowerFirst, upperFirst } from "../../../util/naming.js";
import { resourceEnvUrlVar } from "../../../util/resource-env.js";
// `API_CLIENT_CLASS` lives in `render-expr.ts` for the same reason as on .NET:
// this module already imports the type printer from there, and owning the name
// here too would make the pair mutually importing.
import { API_CLIENT_CLASS, boxedJavaType } from "../render-expr.js";

/** The aggregate an operation answers with, looked up ACROSS the system — the
 *  callee's context belongs to another deployable. */
function aggregateNamed(sys: SystemIR, name: string): AggregateIR | undefined {
  for (const sd of sys.subdomains) {
    for (const ctx of sd.contexts) {
      const agg = ctx.aggregates.find((a) => a.name === name);
      if (agg) return agg;
    }
  }
  return undefined;
}

function arg(name: string): string {
  return escapeJavaIdent(lowerFirst(name));
}

/** Java parameter type.  Ids and path/query scalars ride the wire as `String`;
 *  an entity-typed body is the callee's createInput projection, which the
 *  caller does not model — `Object` rather than a false precision. */
function javaParamType(t: TypeIR): string {
  if (t.kind === "id") return "String";
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
        return "Integer";
      case "long":
        return "Long";
      case "decimal":
      case "money":
        return "java.math.BigDecimal";
      case "bool":
        return "Boolean";
      default:
        return "String";
    }
  }
  return "Object";
}

/** `/api/orders/{id}` → a Java string expression with path params encoded. */
function pathExpr(op: ApiOperationIR): string {
  const parts: string[] = [];
  let rest = op.path;
  for (const p of op.params) {
    if (p.location !== "path") continue;
    const token = `{${p.name}}`;
    const at = rest.indexOf(token);
    if (at < 0) continue;
    parts.push(JSON.stringify(rest.slice(0, at)));
    parts.push(`enc(String.valueOf(${arg(p.name)}))`);
    rest = rest.slice(at + token.length);
  }
  parts.push(JSON.stringify(rest));
  return parts.join(" + ");
}

/** A `record` mirroring the aggregate's read wire shape. */
function responseRecord(agg: AggregateIR, recordName: string): string[] {
  const fields = forApiRead(wireFieldsForAggregate(agg));
  const members = fields.map((wf) => {
    const t = wf.source === "id" ? "String" : boxedJavaType(wf.type);
    return `${t} ${arg(wf.name)}`;
  });
  return [`    public record ${recordName}(${members.join(", ")}) { }`, ""];
}

/** Emit the typed client class, or nothing when this deployable binds no
 *  in-system api (the gate that keeps existing projects byte-identical). */
export function emitJavaApiClients(
  bindings: readonly ApiResourceBinding[],
  sys: SystemIR,
  pkg: string,
): string | undefined {
  if (bindings.length === 0) return undefined;

  const records: string[] = [];
  const methods: string[] = [];
  const emittedRecords = new Set<string>();

  for (const b of bindings) {
    const res = lowerFirst(b.resource.name);
    methods.push(
      `    // ---- ${b.resource.name} -> api '${b.apiName}' (served by '${b.server.name}')`,
      `    private static final String ${res}BaseUrl =`,
      `        System.getenv().getOrDefault("${resourceEnvUrlVar(b.resource.name)}", "http://localhost:3000");`,
      "",
    );

    for (const ctx of servedContextsFor(b, sys)) {
      for (const op of deriveContextOperations(ctx)) {
        // An ABSENCE union reads the same record as a plain entity response;
        // only the absent status differs (null, not a throw).  See
        // payloads.md §Union finds — there is no `type` discriminator.
        const absentAgg = absenceUnionSuccess(op.responseType);
        // A COLLECTION response reads the same per-row record, wrapped: the
        // auto-`findAll` answers with the paged envelope, a declared `T[]` find
        // with a bare array.  Without this arm both returned `void` — the call
        // was made and every row discarded.
        const coll = collectionSuccess(op.responseType);
        const respAgg =
          op.responseType?.kind === "entity" ? op.responseType.name : (absentAgg ?? coll?.agg);
        const agg = respAgg ? aggregateNamed(sys, respAgg) : undefined;
        const recordName = agg ? `${agg.name}Response` : undefined;
        if (agg && recordName && !emittedRecords.has(recordName)) {
          emittedRecords.add(recordName);
          records.push(...responseRecord(agg, recordName));
        }
        // The paged envelope mirrors the callee's `<Agg>Paged` field for field.
        // Components stay BOXED for the same reason the row record's are: a
        // missing field binds null, and null into an `int` throws at parse time
        // pointing at the record rather than at the callee.
        // The SHIPPED create route answers `201 {id}` — not the whole entity
        // its declared responseType names.  Reading the entity record against
        // that body leaves every other component null, at RUNTIME.
        const createName = agg && op.kind === "create" ? `${agg.name}Created` : undefined;
        if (createName && !emittedRecords.has(createName)) {
          emittedRecords.add(createName);
          records.push(`    public record ${createName}(String id) { }`, "");
        }
        const pagedName = agg && coll?.carrier === "paged" ? `${agg.name}Paged` : undefined;
        if (pagedName && recordName && !emittedRecords.has(pagedName)) {
          emittedRecords.add(pagedName);
          records.push(
            `    public record ${pagedName}(java.util.List<${recordName}> items, Integer page, Integer pageSize, Integer total, Integer totalPages) { }`,
            "",
          );
        }
        // Jackson needs a TypeReference for a generic container — `List<T>.class`
        // does not exist, and `List.class` erases to `List<LinkedHashMap>`,
        // which fails on the first field read rather than at the boundary.
        const readExpr = createName
          ? `MAPPER.readValue(res.body(), ${createName}.class)`
          : pagedName
            ? `MAPPER.readValue(res.body(), ${pagedName}.class)`
            : recordName && coll
              ? `MAPPER.readValue(res.body(), new tools.jackson.core.type.TypeReference<java.util.List<${recordName}>>() { })`
              : recordName
                ? `MAPPER.readValue(res.body(), ${recordName}.class)`
                : undefined;
        const respType = createName
          ? createName
          : pagedName
            ? pagedName
            : recordName && coll
              ? `java.util.List<${recordName}>`
              : recordName;

        const bodyParams = op.params.filter((p) => p.location === "body");
        // Two body shapes, both derived (api-surface.ts): `create` carries ONE
        // whole-shape param, while a domain operation carries one per declared
        // argument, which the callee reads as a flat JSON object.  Serializing
        // only the first silently drops every argument after it.
        const wholeShapeBody = bodyParams.length === 1 && bodyParams[0]?.type.kind === "entity";
        const query = op.params.filter((p) => p.location === "query");
        const params = op.params.map((p) => `${javaParamType(p.type)} ${arg(p.name)}`);
        const ret = respType ?? "void";

        methods.push(
          `    public static ${ret} ${res}${upperFirst(op.id)}(${params.join(", ")}) {`,
          `        var path = ${pathExpr(op)};`,
        );
        if (query.length > 0) {
          methods.push(
            `        path += "?" + String.join("&", java.util.List.of(`,
            query
              .map(
                (q) =>
                  `            ${JSON.stringify(`${q.name}=`)} + enc(String.valueOf(${arg(q.name)}))`,
              )
              .join(",\n"),
            "        ));",
          );
        }
        methods.push(
          `        var req = HttpRequest.newBuilder(URI.create(${res}BaseUrl + path))`,
          `            .header("content-type", "application/json")`,
        );
        if (bodyParams.length > 0) {
          const payload = wholeShapeBody
            ? arg(bodyParams[0]?.name ?? "body")
            : `java.util.Map.of(${bodyParams.map((p) => `${JSON.stringify(p.name)}, ${arg(p.name)}`).join(", ")})`;
          methods.push(
            `            .method("${op.method.toUpperCase()}", HttpRequest.BodyPublishers.ofString(writeJson(${payload})))`,
          );
        } else {
          methods.push(
            `            .method("${op.method.toUpperCase()}", HttpRequest.BodyPublishers.noBody())`,
          );
        }
        methods.push(
          "            .build();",
          "        HttpResponse<String> res;",
          "        try {",
          "            res = HTTP.send(req, HttpResponse.BodyHandlers.ofString());",
          "        } catch (java.io.IOException | InterruptedException e) {",
          "            if (e instanceof InterruptedException) Thread.currentThread().interrupt();",
          `            throw new RemoteCallException(${JSON.stringify(b.resource.name)}, ${JSON.stringify(op.id)}, 0, e);`,
          "        }",
          ...(absentAgg
            ? [
                // Absence is a VALUE the caller matches on, not a failure.
                "        if (res.statusCode() == 404) {",
                "            return null;",
                "        }",
              ]
            : []),
          "        if (res.statusCode() >= 400) {",
          `            throw new RemoteCallException(${JSON.stringify(b.resource.name)}, ${JSON.stringify(op.id)}, res.statusCode(), null);`,
          "        }",
        );
        if (readExpr) {
          methods.push(
            "        try {",
            `            return ${readExpr};`,
            "        } catch (Exception e) {",
            `            throw new RemoteCallException(${JSON.stringify(b.resource.name)}, ${JSON.stringify(op.id)}, res.statusCode(), e);`,
            "        }",
          );
        }
        methods.push("    }", "");
      }
    }
  }

  return [
    "// Auto-generated by Loom.  Typed in-system api clients (M-T4.8).",
    `package ${pkg};`,
    "",
    // Jackson 3 (`tools.jackson.*`), matching every other Java emitter.  A
    // stale `com.fasterxml.jackson.*` import still COMPILES here — springdoc
    // drags swagger-core's Jackson 2 onto the classpath — so the only thing
    // that catches it is `jackson3-packages.test.ts`, and the symptom would be
    // this client serializing through a different mapper than the rest of the
    // app.
    "import java.net.URI;",
    "import java.net.URLEncoder;",
    "import java.net.http.HttpClient;",
    "import java.net.http.HttpRequest;",
    "import java.net.http.HttpResponse;",
    "import java.nio.charset.StandardCharsets;",
    "import tools.jackson.databind.ObjectMapper;",
    "import tools.jackson.databind.json.JsonMapper;",
    "",
    "/** Raised when an in-system call answers with a status the callee's",
    " *  contract does not describe as a success, or when its body cannot be",
    " *  read.  Carries the status so a caller can branch on it rather than",
    " *  string-matching a message. */",
    "class RemoteCallException extends RuntimeException {",
    "    private final String resource;",
    "    private final String operationId;",
    "    private final int status;",
    "",
    "    RemoteCallException(String resource, String operationId, int status, Throwable cause) {",
    '        super("in-system call " + resource + "." + operationId + " failed with status " + status, cause);',
    "        this.resource = resource;",
    "        this.operationId = operationId;",
    "        this.status = status;",
    "    }",
    "",
    "    public String resource() { return resource; }",
    "    public String operationId() { return operationId; }",
    "    public int status() { return status; }",
    "}",
    "",
    `public final class ${API_CLIENT_CLASS} {`,
    `    private ${API_CLIENT_CLASS}() { }`,
    "",
    "    private static final HttpClient HTTP = HttpClient.newHttpClient();",
    "    // Self-constructed rather than injected: this class is static (the",
    "    // render layer calls it without a bean reference), and the generated",
    "    // context declares no ObjectMapper bean.",
    // `JsonMapper.builder().build()`, not `new ObjectMapper()`: the Jackson 3
    // idiom the rest of the Java emitters use (module discovery is automatic,
    // so there is no `findAndRegisterModules()` to call).
    "    private static final ObjectMapper MAPPER = JsonMapper.builder().build();",
    "",
    "    private static String enc(String v) {",
    "        return URLEncoder.encode(v, StandardCharsets.UTF_8);",
    "    }",
    "",
    "    private static String writeJson(Object value) {",
    "        try {",
    "            return MAPPER.writeValueAsString(value);",
    "        } catch (Exception e) {",
    '            throw new IllegalStateException("failed to serialize in-system call body", e);',
    "        }",
    "    }",
    "",
    ...records,
    ...methods,
    "}",
    "",
  ].join("\n");
}
