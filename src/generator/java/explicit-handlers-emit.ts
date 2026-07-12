// ---------------------------------------------------------------------------
// Explicit application/transport layer → Java / Spring emission
// (unfoldable-api-derivation.md, Layers 3-4; A2 slice — the Java sibling of the
// .NET A1 emitter in ../dotnet/explicit-handlers-emit.ts).
//
// Reads the explicit `commandHandler` / `queryHandler` context members and the
// `route <METHOD> "<path>" -> <Ctx>.<Handler>` api bindings shipped in #1756 /
// #1793 and emits them onto the SAME repository seam the backend already uses —
// no mediator, no marker records:
//
//   commandHandler  → a `@Service @Transactional` bean with a `handle(...)`
//                     method, constructor-injected `<Agg>Repository` fields.
//   queryHandler    → the same, `@Transactional(readOnly = true)`.
//   route <M> <p>   → a `@RestController` per served api whose actions coerce
//                     the wire path params into the domain types and call the
//                     handler bean directly.
//
// PARALLEL emitter (the reuse fork): it reuses the shared workflow statement
// spine (`renderWorkflowStmtChunks` + `javaWorkflowStmtTarget`, from
// emit/workflow.ts) but writes its own handler shell, so the shipped workflow
// emitter stays byte-identical.  The handler body renders the workflow
// statements + exit-saves, then `return <returnValue>` (the IR field #1793
// added — the workflow stmt target has no return arm).
//
// Java takes NO command-param rewrite (unlike .NET's renderExprWithCmdParams):
// a handler param is a domain-typed `handle(...)` method parameter, so a `param`
// ref renders as its bare name and the route controller coerces the wire path
// param into the domain type at the call site (`new <Agg>Id(id)`).
//
// Route param binding (B2, the Java sibling of .NET B1 #1822): a handler param
// bound by a `{token}` in the route path stays URL-bound (id → wire type coerced
// back with `new <Agg>Id`); every other param rides in one `<Handler>Body`
// `@RequestBody` record (a domain-typed record emitted alongside the controller,
// package-private so it can share the controller file — Java allows at most one
// public top-level type per file).  The handler call args keep declared order:
// path coercions and `body.<name>()` accessors interleaved.
// v1 scope: full response-DTO projection rides with the contract-scaffold layer.
// ---------------------------------------------------------------------------

import type {
  CommandHandlerIR,
  EnrichedBoundedContextIR,
  ParamIR,
  QueryHandlerIR,
  RouteIR,
  WorkflowStmtIR,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst } from "../../util/naming.js";
import { collectUnionFindLets, renderWorkflowStmtChunks } from "../_workflow/stmt-target.js";
import { javaWorkflowStmtTarget, repoField } from "./emit/workflow.js";
import {
  collectJavaExprImports,
  collectJavaTypeImports,
  type JavaRenderContext,
  javaValueTypeForId,
  renderJavaExpr,
  renderJavaType,
} from "./render-expr.js";

type Handler = CommandHandlerIR | QueryHandlerIR;

/** The aggregates a handler body loads / saves — its injected
 *  `<Agg>Repository` fields (repo-let loads + exit-saves).  Same derivation the
 *  shared workflow stmt target uses for its field/method names. */
function reposUsed(h: Handler): string[] {
  const aggs = new Set<string>();
  const walk = (stmts: readonly WorkflowStmtIR[]): void => {
    for (const s of stmts) {
      if (s.kind === "repo-let" || s.kind === "repo-run" || s.kind === "factory-let") {
        aggs.add(s.aggName);
      } else if (s.kind === "for-each") {
        for (const save of s.savesPerIteration) aggs.add(save.aggName);
        walk(s.body);
      } else if (s.kind === "if-let") {
        aggs.add(s.aggName);
        walk(s.thenBody);
        walk(s.elseBody ?? []);
      }
    }
  };
  walk(h.statements);
  for (const save of h.savesAtExit) aggs.add(save.aggName);
  return [...aggs].sort();
}

const baseRenderCtx: JavaRenderContext = { thisName: "this" };

/** Render one `commandHandler` / `queryHandler` as a `@Service` bean. */
function renderHandlerClass(
  h: Handler,
  kind: "command" | "query",
  basePkg: string,
  appPkg: string,
  ctx: EnrichedBoundedContextIR,
  entityPkgOf: (agg: string) => string,
  repoPkgOf: (agg: string) => string,
): string {
  const handlerName = `${h.name}Handler`;
  const imports = new Set<string>();

  // Body — the shared workflow statement spine, rendered at 8-space indent
  // (method-body depth), with a DEFAULT render context (param refs stay bare).
  const bodyLines = renderWorkflowStmtChunks(
    h.statements,
    javaWorkflowStmtTarget(
      ctx,
      imports,
      baseRenderCtx,
      undefined,
      collectUnionFindLets(h.statements),
    ),
    "        ",
  ).flat();
  const saveLines = h.savesAtExit.map((s) => `        ${repoField(s.aggName)}.save(${s.name});`);
  const returnLines: string[] = [];
  if (h.returnValue) {
    collectJavaExprImports(h.returnValue, imports);
    returnLines.push(`        return ${renderJavaExpr(h.returnValue, baseRenderCtx)};`);
  }

  const retType = h.returnType ? renderJavaType(h.returnType) : "void";
  if (h.returnType) collectJavaTypeImports(h.returnType, imports);
  const params = h.params
    .map((p) => {
      collectJavaTypeImports(p.type, imports);
      return `${renderJavaType(p.type)} ${p.name}`;
    })
    .join(", ");

  const repoAggs = reposUsed(h);
  const fields = repoAggs.map((a) => `    private final ${a}Repository ${repoField(a)};`);
  const ctorParams = repoAggs.map((a) => `${a}Repository ${repoField(a)}`).join(", ");
  const ctor =
    repoAggs.length > 0
      ? [
          `    public ${handlerName}(${ctorParams}) {`,
          ...repoAggs.map((a) => `        this.${repoField(a)} = ${repoField(a)};`),
          `    }`,
          ``,
        ]
      : [];

  // Cross-package imports for each loaded aggregate + its repository interface.
  const aggImports = repoAggs.flatMap((a) => {
    const ePkg = entityPkgOf(a);
    const rPkg = repoPkgOf(a);
    return [
      ePkg !== appPkg ? `import ${ePkg}.${a};` : null,
      rPkg !== appPkg ? `import ${rPkg}.${a}Repository;` : null,
    ].filter((l): l is string => l !== null);
  });

  // CatalogLog is only referenced when the body renders an `emit` (the shared
  // spine logs event_dispatched there); a plain load/mutate/save handler leaves
  // it out so the import header stays tight.
  const usesCatalog = bodyLines.some((l) => l.includes("CatalogLog"));

  const tx = kind === "command" ? "@Transactional" : "@Transactional(readOnly = true)";

  return lines(
    `package ${appPkg};`,
    ``,
    ...[...imports].sort().map((i) => `import ${i};`),
    imports.size > 0 ? `` : null,
    `import org.springframework.stereotype.Service;`,
    `import org.springframework.transaction.annotation.Transactional;`,
    ``,
    ...aggImports,
    `import ${basePkg}.domain.common.*;`,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    usesCatalog ? `import ${basePkg}.config.CatalogLog;` : null,
    ``,
    `@Service`,
    tx,
    `public class ${handlerName} {`,
    ...fields,
    fields.length > 0 ? `` : null,
    ...ctor,
    `    public ${retType} handle(${params}) {`,
    ...bodyLines,
    ...saveLines,
    ...returnLines,
    `    }`,
    `}`,
    ``,
  );
}

/** Emit the `<Name>Handler` bean for every explicit handler in a context.
 *  Returns `[]` for a context that declares none. */
export function emitExplicitHandlers(
  ctx: EnrichedBoundedContextIR,
  basePkg: string,
  appPkg: string,
  entityPkgOf: (agg: string) => string,
  repoPkgOf: (agg: string) => string,
): { name: string; content: string }[] {
  const files: { name: string; content: string }[] = [];
  for (const h of ctx.commandHandlers ?? []) {
    files.push({
      name: `${h.name}Handler.java`,
      content: renderHandlerClass(h, "command", basePkg, appPkg, ctx, entityPkgOf, repoPkgOf),
    });
  }
  for (const h of ctx.queryHandlers ?? []) {
    files.push({
      name: `${h.name}Handler.java`,
      content: renderHandlerClass(h, "query", basePkg, appPkg, ctx, entityPkgOf, repoPkgOf),
    });
  }
  return files;
}

const HTTP_ANNOT: Record<string, string> = {
  GET: "GetMapping",
  POST: "PostMapping",
  PUT: "PutMapping",
  PATCH: "PatchMapping",
  DELETE: "DeleteMapping",
};

/** The `{token}` names in a route path — the params bound from the URL rather
 *  than the request body. */
function pathParamNames(path: string): Set<string> {
  const names = new Set<string>();
  for (const m of path.matchAll(/\{(\w+)\}/g)) names.add(m[1]);
  return names;
}

/** The wire-typed `@PathVariable` declaration + the domain-coerced call
 *  argument for a PATH-bound handler param: id → `UUID`/`long`/`String` path
 *  param wrapped in `new <Agg>Id(...)`; scalar → the rendered domain type
 *  verbatim.  Body params take a separate `@RequestBody` record path below. */
function wireActionParam(
  p: ParamIR,
  imports: Set<string>,
): { actionParam: string; callArg: string } {
  const t = p.type;
  if (t.kind === "id") {
    const wire = javaValueTypeForId(t.valueType);
    if (wire === "UUID") imports.add("java.util.UUID");
    return {
      actionParam: `@PathVariable ${wire} ${p.name}`,
      callArg: `new ${t.targetName}Id(${p.name})`,
    };
  }
  collectJavaTypeImports(t, imports);
  return { actionParam: `@PathVariable ${renderJavaType(t)} ${p.name}`, callArg: p.name };
}

/** Emit one `@RestController` per api whose route list is non-empty: each
 *  `route` becomes an action that coerces its (wire-typed) path params into the
 *  target handler's domain params and calls the handler bean directly.  Returns
 *  null when the api binds no resolvable route. */
export function emitExplicitRouteController(
  apiName: string,
  routes: readonly RouteIR[],
  contexts: readonly EnrichedBoundedContextIR[],
  basePkg: string,
  appPkg: string,
): { name: string; content: string } | null {
  if (routes.length === 0) return null;
  const byName = new Map(contexts.map((c) => [c.name, c]));
  const imports = new Set<string>();
  // handlerName → field name, in first-seen order (deduped across routes that
  // target the same handler).
  const injected = new Map<string, string>();
  const actions: string[] = [];
  // Package-private `<Handler>Body` records for routes with body params — one
  // record per route that has any non-path-bound param.
  const bodyRecords: string[] = [];
  for (const r of routes) {
    const ctx = byName.get(r.target.context);
    if (!ctx) continue;
    const cmd = (ctx.commandHandlers ?? []).find((h) => h.name === r.target.handler);
    const qry = (ctx.queryHandlers ?? []).find((h) => h.name === r.target.handler);
    const h = cmd ?? qry;
    if (!h) continue;
    const handlerName = `${h.name}Handler`;
    const field = lowerFirst(handlerName);
    injected.set(handlerName, field);

    // Split params: those bound by a `{token}` in the route path stay
    // `@PathVariable`s; the rest collect into one `@RequestBody` record.  A bare
    // complex `@PathVariable Money` param would be unbindable — Spring can't
    // materialise a value object from a URL segment that isn't even in the path.
    const pathNames = pathParamNames(r.path);
    const pathParams = h.params.filter((p) => pathNames.has(p.name));
    const bodyParams = h.params.filter((p) => !pathNames.has(p.name));
    const pathArg = new Map(pathParams.map((p) => [p.name, wireActionParam(p, imports)]));

    const actionParamParts = pathParams.map((p) => pathArg.get(p.name)!.actionParam);
    if (bodyParams.length > 0) {
      const bodyRecName = `${h.name}Body`;
      const fields = bodyParams
        .map((p) => {
          collectJavaTypeImports(p.type, imports);
          return `${renderJavaType(p.type)} ${p.name}`;
        })
        .join(", ");
      bodyRecords.push(`record ${bodyRecName}(${fields}) {}`);
      actionParamParts.push(`@RequestBody ${bodyRecName} body`);
    }
    const actionParams = actionParamParts.join(", ");
    // Handler call args keep declared param order: path params coerce from the
    // route token, body params read off `body.<name>()` (record accessor).
    const callArgs = h.params
      .map((p) => (pathNames.has(p.name) ? pathArg.get(p.name)!.callArg : `body.${p.name}()`))
      .join(", ");
    const hasReturn = !!qry || !!cmd?.returnType;
    const annot = HTTP_ANNOT[r.method] ?? "GetMapping";
    const callLines = hasReturn
      ? [
          `        var result = ${field}.handle(${callArgs});`,
          `        return ResponseEntity.ok(result);`,
        ]
      : [
          `        ${field}.handle(${callArgs});`,
          `        return ResponseEntity.noContent().build();`,
        ];
    actions.push(
      `    @${annot}("${r.path}")`,
      `    public ResponseEntity<?> ${lowerFirst(h.name)}(${actionParams}) {`,
      ...callLines,
      `    }`,
      ``,
    );
  }
  if (injected.size === 0) return null;
  while (actions[actions.length - 1] === "") actions.pop();

  const className = `${apiName}RoutesController`;
  const fields = [...injected].map(([type, field]) => `    private final ${type} ${field};`);
  const ctorParams = [...injected].map(([type, field]) => `${type} ${field}`).join(", ");
  const ctorAssigns = [...injected].map(([, field]) => `        this.${field} = ${field};`);
  return {
    name: `${className}.java`,
    content: lines(
      `package ${basePkg}.api;`,
      ``,
      ...[...imports].sort().map((i) => `import ${i};`),
      imports.size > 0 ? `` : null,
      `import org.springframework.http.ResponseEntity;`,
      `import org.springframework.web.bind.annotation.*;`,
      ``,
      `import ${appPkg}.*;`,
      `import ${basePkg}.domain.ids.*;`,
      // Body records reference domain value objects / enums by their wildcard
      // packages (Money, etc.); only pulled in when a route carries body params
      // so the no-body header stays byte-identical to the path-only emitter.
      bodyRecords.length > 0 ? `import ${basePkg}.domain.enums.*;` : null,
      bodyRecords.length > 0 ? `import ${basePkg}.domain.valueobjects.*;` : null,
      ``,
      `@RestController`,
      `public class ${className} {`,
      ...fields,
      ``,
      `    public ${className}(${ctorParams}) {`,
      ...ctorAssigns,
      `    }`,
      ``,
      ...actions,
      `}`,
      ``,
      // Package-private request-body records, co-located with the controller
      // (the .NET B1 precedent puts them in the controller file too; Java's
      // one-public-type-per-file rule forces package-private).
      ...(bodyRecords.length > 0 ? ["", ...bodyRecords, ""] : []),
    ),
  };
}
