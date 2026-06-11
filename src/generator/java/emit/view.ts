import type { EnrichedBoundedContextIR, ViewIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import { collectJavaExprImports, renderJavaExpr } from "../render-expr.js";
import { collectWireImports, domainToWire, wireJavaType } from "./wire.js";

// ---------------------------------------------------------------------------
// Views — read-only projections, served under `GET /views/<snake(name)>`
// (the cross-backend route contract).  A shorthand view reuses the source
// aggregate's `<Agg>Response`; a full-form view gets a `<View>Row` record
// built from its bind expressions.  The filtered read itself rides a
// synthesized repository find (`viewFindsFor` — the mergeViewsAsFinds
// analog), so the JPQL path is shared with declared finds.
// ---------------------------------------------------------------------------

/** Views sourced from `agg`, as synthesized parameterless finds the
 *  repository emitters pick up (name = lowerFirst(view name)). */
export function viewFindsFor(
  aggName: string,
  ctx: EnrichedBoundedContextIR,
): {
  name: string;
  params: never[];
  returnType: { kind: "array"; element: { kind: "entity"; name: string } };
  filter?: ViewIR["filter"];
}[] {
  return ctx.views
    .filter((v) => v.source.kind === "aggregate" && v.source.name === aggName)
    .map((v) => ({
      name: lowerFirst(v.name),
      params: [],
      returnType: { kind: "array", element: { kind: "entity", name: aggName } },
      filter: v.filter,
    }));
}

export interface ViewCtx {
  basePkg: string;
  /** Shared views package (`<base>.application.views`). */
  pkg: string;
  /** Route prefix ("/api" in fullstack mode). */
  routePrefix?: string;
  applicationPkgOf: (aggName: string) => string;
  entityPkgOf: (aggName: string) => string;
  repoPkgOf: (aggName: string) => string;
}

export function renderJavaViews(
  ctx: EnrichedBoundedContextIR,
  vctx: ViewCtx,
): Map<string, { category: "view-service" | "api-common"; content: string }> | null {
  const views = ctx.views.filter((v) => v.source.kind === "aggregate");
  if (views.length === 0) return null;
  const out = new Map<string, { category: "view-service" | "api-common"; content: string }>();
  const imports = new Set<string>(["java.util.List"]);
  const explicitImports = new Set<string>();
  const methods: string[] = [];
  const repoAggs = new Set<string>();
  const routes: string[] = [];

  for (const view of views) {
    const aggName = (view.source as { name: string }).name;
    repoAggs.add(aggName);
    const findName = lowerFirst(view.name);
    if (view.output) {
      if (view.output.auxiliaries.length > 0) {
        throw new Error(
          `java views: view '${view.name}' uses cross-aggregate follows — not yet implemented on the java backend.`,
        );
      }
      // Row record from the declared fields + bind expressions.
      const rowName = `${upperFirst(view.name)}Row`;
      const rowImports = new Set<string>();
      const components = view.output.fields.map((f) => {
        collectWireImports(f.type, rowImports);
        return `${wireJavaType(f.type, "Response")} ${f.name}`;
      });
      out.set(`${rowName}.java`, {
        category: "view-service",
        content: lines(
          `package ${vctx.pkg};`,
          ``,
          ...[...rowImports].sort().map((i) => `import ${i};`),
          rowImports.size > 0 ? `` : null,
          `import ${vctx.basePkg}.domain.enums.*;`,
          `import ${vctx.basePkg}.domain.ids.*;`,
          `import ${vctx.basePkg}.domain.valueobjects.*;`,
          ``,
          `public record ${rowName}(${components.join(", ")}) {`,
          `}`,
          ``,
        ),
      });
      const args = view.output.binds.map((b) => {
        collectJavaExprImports(b.expr, imports);
        const rendered = renderJavaExpr(b.expr, { thisName: "a", accessorProps: true });
        return domainToWire(b.type, rendered);
      });
      methods.push(
        `    public List<${rowName}> ${findName}() {`,
        `        return ${repoField(aggName)}.${findName}().stream()`,
        `            .map(a -> new ${rowName}(${args.join(", ")}))`,
        `            .toList();`,
        `    }`,
        ``,
      );
      routes.push(
        `    @GetMapping("/${snake(view.name)}")`,
        `    public List<${rowName}> ${findName}() {`,
        `        return views.${findName}();`,
        `    }`,
        ``,
      );
    } else {
      // Shorthand — reuse the aggregate's response record.
      explicitImports.add(`${vctx.applicationPkgOf(aggName)}.${aggName}Response`);
      methods.push(
        `    public List<${aggName}Response> ${findName}() {`,
        `        return ${repoField(aggName)}.${findName}().stream().map(${aggName}Response::from).toList();`,
        `    }`,
        ``,
      );
      routes.push(
        `    @GetMapping("/${snake(view.name)}")`,
        `    public List<${aggName}Response> ${findName}() {`,
        `        return views.${findName}();`,
        `    }`,
        ``,
      );
    }
  }
  while (methods[methods.length - 1] === "") methods.pop();
  while (routes[routes.length - 1] === "") routes.pop();

  const repoFields = [...repoAggs].sort();
  const serviceName = `${ctx.name}Views`;
  for (const a of repoFields) {
    if (vctx.repoPkgOf(a) !== vctx.pkg) explicitImports.add(`${vctx.repoPkgOf(a)}.${a}Repository`);
    if (vctx.entityPkgOf(a) !== vctx.pkg) explicitImports.add(`${vctx.entityPkgOf(a)}.${a}`);
  }
  out.set(`${serviceName}.java`, {
    category: "view-service",
    content: lines(
      `package ${vctx.pkg};`,
      ``,
      ...[...imports].sort().map((i) => `import ${i};`),
      ``,
      `import org.springframework.stereotype.Service;`,
      `import org.springframework.transaction.annotation.Transactional;`,
      ``,
      ...[...explicitImports].sort().map((i) => `import ${i};`),
      `import ${vctx.basePkg}.domain.enums.*;`,
      `import ${vctx.basePkg}.domain.ids.*;`,
      `import ${vctx.basePkg}.domain.valueobjects.*;`,
      ``,
      `@Service`,
      `@Transactional(readOnly = true)`,
      `public class ${serviceName} {`,
      ...repoFields.map((a) => `    private final ${a}Repository ${repoField(a)};`),
      ``,
      `    public ${serviceName}(${repoFields.map((a) => `${a}Repository ${repoField(a)}`).join(", ")}) {`,
      ...repoFields.map((a) => `        this.${repoField(a)} = ${repoField(a)};`),
      `    }`,
      ``,
      ...methods,
      `}`,
      ``,
    ),
  });

  out.set(`${ctx.name}ViewsController.java`, {
    category: "api-common",
    content: lines(
      `package ${vctx.basePkg}.api;`,
      ``,
      `import java.util.List;`,
      ``,
      `import org.springframework.web.bind.annotation.*;`,
      ``,
      `import ${vctx.pkg}.*;`,
      ...views
        .filter((v) => !v.output)
        .map((v) => {
          const aggName = (v.source as { name: string }).name;
          return `import ${vctx.applicationPkgOf(aggName)}.${aggName}Response;`;
        })
        .filter((v, i, arr) => arr.indexOf(v) === i),
      ``,
      `@RestController`,
      `@RequestMapping("${vctx.routePrefix ?? ""}/views")`,
      `public class ${ctx.name}ViewsController {`,
      `    private final ${serviceName} views;`,
      ``,
      `    public ${ctx.name}ViewsController(${serviceName} views) {`,
      `        this.views = views;`,
      `    }`,
      ``,
      ...routes,
      `}`,
      ``,
    ),
  });

  return out;
}

function repoField(aggName: string): string {
  return `${lowerFirst(plural(aggName))}Repository`;
}
