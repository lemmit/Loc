// ---------------------------------------------------------------------------
// Typed in-system api client (M-T4.8 slice 4) — the Python/FastAPI caller half.
//
// Sibling of `src/platform/hono/v4/adapters/api-client.ts`; same contract,
// idiomatic Python.  One `async def <resource>_<operation_id>(...)` per
// operation the CALLEE exposes, replacing the untyped `get(path) -> object`
// verbs the `storage restApi` binding carries.
//
// Both halves are derived, so neither can drift from the callee:
//   - paths from `deriveContextOperations` (what the callee actually mounts),
//   - the response model from `forApiRead(wireFieldsForAggregate(...))` (the
//     field list the callee serializes).
//
// pydantic's `model_validate` is the direct analogue of the Hono client's
// `zod.parse` — a real runtime check at the boundary, not just a static cast,
// so a contract violation fails here rather than three frames deeper.  It is
// already a dependency (FastAPI), so this adds no new one.
// ---------------------------------------------------------------------------

import { forApiRead, wireFieldsForAggregate } from "../../ir/enrich/wire-projection.js";
import type { AggregateIR, SystemIR, TypeIR } from "../../ir/types/loom-ir.js";
import { type ApiResourceBinding, servedContextsFor } from "../../ir/util/api-resource-binding.js";
import { type ApiOperationIR, deriveContextOperations } from "../../ir/util/api-surface.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import { resourceEnvUrlVar } from "../../util/resource-env.js";
import { renderPyType } from "./render-expr.js";

/** The aggregate an operation answers with — looked up ACROSS the system, since
 *  the callee's context belongs to a different deployable. */
function aggregateNamed(sys: SystemIR, name: string): AggregateIR | undefined {
  for (const sd of sys.subdomains) {
    for (const ctx of sd.contexts) {
      const agg = ctx.aggregates.find((a) => a.name === name);
      if (agg) return agg;
    }
  }
  return undefined;
}

/** Python parameter type.  Ids and path/query scalars ride the wire as `str`;
 *  an entity-typed body is the callee's createInput projection, which the
 *  caller does not model — `object` rather than a false precision. */
function pyParamType(t: TypeIR): string {
  if (t.kind === "id") return "str";
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
      case "long":
        return "int";
      case "decimal":
      case "money":
        return "Decimal";
      case "bool":
        return "bool";
      default:
        return "str";
    }
  }
  return "object";
}

/** `/api/orders/{id}` → an f-string with the path params interpolated. */
function pathExpr(op: ApiOperationIR): string {
  let out = op.path;
  let interpolated = false;
  for (const p of op.params) {
    if (p.location !== "path") continue;
    out = out.replace(`{${p.name}}`, `{quote(str(${snake(p.name)}), safe="")}`);
    interpolated = true;
  }
  return interpolated ? `f"${out}"` : `"${out}"`;
}

/** pydantic model for an aggregate's read wire shape — the same walk the
 *  callee serializes from. */
function responseModel(agg: AggregateIR, modelName: string): string[] {
  const out: string[] = [`class ${modelName}(BaseModel):`];
  const fields = forApiRead(wireFieldsForAggregate(agg));
  if (fields.length === 0) out.push("    pass");
  for (const wf of fields) {
    const t = wf.source === "id" ? "str" : renderPyType(wf.type);
    out.push(`    ${snake(wf.name)}: ${wf.optional ? `${t} | None` : t}`);
  }
  return out;
}

/** Emit `app/resources/api_clients.py`, or nothing when this deployable binds
 *  no in-system api (the gate that keeps existing projects byte-identical). */
export function emitPythonApiClients(
  bindings: readonly ApiResourceBinding[],
  sys: SystemIR,
): string | undefined {
  if (bindings.length === 0) return undefined;
  const body: string[] = [];
  const emittedModels = new Set<string>();

  body.push(
    "class RemoteCallError(Exception):",
    '    """Raised when an in-system call answers with a status the callee\'s',
    "    contract does not describe as a success.  Carries the status so a",
    '    caller can branch on it rather than string-matching a message."""',
    "",
    "    def __init__(self, resource: str, operation_id: str, status: int) -> None:",
    "        super().__init__(",
    '            f"in-system call {resource}.{operation_id} failed with status {status}"',
    "        )",
    "        self.resource = resource",
    "        self.operation_id = operation_id",
    "        self.status = status",
    "",
    "",
  );

  for (const b of bindings) {
    const envVar = resourceEnvUrlVar(b.resource.name);
    const base = snake(b.resource.name);
    body.push(
      `# ---- ${b.resource.name} -> api '${b.apiName}' (served by '${b.server.name}')`,
      `_${base}_base_url = os.environ.get("${envVar}", "http://localhost:3000")`,
      "",
      "",
    );

    for (const ctx of servedContextsFor(b, sys)) {
      for (const op of deriveContextOperations(ctx)) {
        const respAgg = op.responseType?.kind === "entity" ? op.responseType.name : undefined;
        const agg = respAgg ? aggregateNamed(sys, respAgg) : undefined;
        const modelName = agg ? `${agg.name}Response` : undefined;
        if (agg && modelName && !emittedModels.has(modelName)) {
          emittedModels.add(modelName);
          body.push(...responseModel(agg, modelName), "", "");
        }

        const bodyParams = op.params.filter((p) => p.location === "body");
        // `create` carries ONE whole-shape body param; a domain operation
        // carries one per declared argument, which the callee reads as a flat
        // JSON object.  Sending only the first silently drops the rest.
        const wholeShapeBody = bodyParams.length === 1 && bodyParams[0]?.type.kind === "entity";
        const params = op.params.map((p) => `${snake(p.name)}: ${pyParamType(p.type)}`);
        const ret = modelName ?? "None";

        body.push(
          `async def ${base}_${snake(op.id)}(${params.join(", ")}) -> ${ret}:`,
          `    async with httpx.AsyncClient(base_url=_${base}_base_url) as client:`,
        );
        const call: string[] = [`        res = await client.request(`];
        call.push(`            "${op.method.toUpperCase()}",`);
        call.push(`            ${pathExpr(op)},`);
        const query = op.params.filter((p) => p.location === "query");
        if (query.length > 0) {
          call.push(
            `            params={${query.map((q) => `"${q.name}": ${snake(q.name)}`).join(", ")}},`,
          );
        }
        if (bodyParams.length > 0) {
          const payload = wholeShapeBody
            ? snake(bodyParams[0]?.name ?? "body")
            : `{${bodyParams.map((p) => `"${p.name}": ${snake(p.name)}`).join(", ")}}`;
          call.push(`            json=${payload},`);
        }
        call.push(`        )`);
        body.push(...call);
        body.push(
          `        if res.status_code >= 400:`,
          `            raise RemoteCallError(${JSON.stringify(b.resource.name)}, ${JSON.stringify(op.id)}, res.status_code)`,
        );
        if (modelName) {
          // Validate at the boundary — the pydantic twin of zod's `.parse`.
          body.push(`        return ${modelName}.model_validate(res.json())`);
        } else {
          body.push(`        return None`);
        }
        body.push("", "");
      }
    }
  }

  const needsDecimal = body.some((l) => l.includes("Decimal"));
  return lines(
    "# Auto-generated by Loom.  Typed in-system api clients (M-T4.8).",
    "import os",
    ...(needsDecimal ? ["from decimal import Decimal"] : []),
    "from urllib.parse import quote",
    "",
    "import httpx",
    "from pydantic import BaseModel",
    "",
    "",
    ...body,
  );
}
