// ---------------------------------------------------------------------------
// F2-W-07 — java published a DIFFERENTLY-NAMED paged envelope for a DECLARED
// `find … : T paged` than the other four backends.
//
// `emit/api.ts` returned the raw generic for the declared find:
//
//     public Paged<WidgetResponse> byGradeWidget(…)
//
// springdoc names a generic component by flattening it — `PagedWidgetResponse`
// — while the auto-`findAll` two blocks below already returned the concrete
// record `WidgetPaged`.  Every sibling backend publishes `WidgetPaged` for the
// same route: node `.openapi("WidgetPaged")`, python
// `response_model=WidgetPaged`, elixir's `WidgetPaged` OpenApiSpex schema,
// .NET's `CustomSchemaIds` mapping of `Paged<T>` → `<Agg>Paged`.  So a client
// generated against the java spec got a type no other backend names, and the
// java document carried an extra component no sibling has.
//
// WHY NO EXISTING GATE CAUGHT IT: `examples/showcase.ddd` declares no
// `find … paged` at all (only auto-`all` routes), so the strict per-PR OpenAPI
// differential never reached the route.  This file covers that shape directly.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const paged = (shape = ""): string => `
system PG {
  subdomain S {
    context C {
      enum Grade { A, B }
      aggregate Widget ${shape}with crudish {
        grade: Grade
      }
      repository Widgets for Widget {
        find byGrade(grade: Grade): Widget paged where this.grade == grade
      }
    }
  }
  api A from S
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable dj { platform: java, contexts: [C], dataSources: [st], serves: A, port: 4000 }
}`;

async function file(source: string, suffix: string): Promise<string> {
  const files = await generateSystemFiles(source);
  const hit = [...files.entries()].find(([p]) => p.endsWith(suffix));
  if (!hit) throw new Error(`no ${suffix}; got:\n${[...files.keys()].sort().join("\n")}`);
  return hit[1];
}

describe("java paged envelope naming (F2-W-07)", () => {
  it("a DECLARED paged find returns the concrete `<Agg>Paged`, not the raw generic", async () => {
    const controller = await file(paged(), "features/widgets/WidgetsController.java");
    expect(controller).toContain("public WidgetPaged byGradeWidget(");
    // The raw generic is what springdoc flattened to `PagedWidgetResponse`.
    expect(controller).not.toContain("Paged<WidgetResponse>");
  });

  it("wraps the service's `Paged<T>` at the controller, so the service is unchanged", async () => {
    const controller = await file(paged(), "features/widgets/WidgetsController.java");
    expect(controller).toContain("var result = service.byGrade(grade, page, pageSize, sort, dir);");
    expect(controller).toContain(
      "return new WidgetPaged(result.items(), result.page(), result.pageSize(), " +
        "result.total(), result.totalPages());",
    );
  });

  it("matches the auto-findAll route, which already published `<Agg>Paged`", async () => {
    const controller = await file(paged(), "features/widgets/WidgetsController.java");
    expect(controller).toContain("public WidgetPaged allWidget(");
  });

  // A `shape: document` aggregate has a NON-paged auto-findAll, so
  // `isPagedAutoAll` is false — and `<Agg>Paged.java` used to be emitted only
  // under that flag.  Returning the concrete record from the declared find
  // without this would emit a controller referencing a class that does not
  // exist.
  it("emits `<Agg>Paged.java` for a declared paged find even with a non-paged auto-findAll", async () => {
    const source = paged("shape: document, ");
    const files = await generateSystemFiles(source);
    const paths = [...files.keys()];
    expect(paths.some((p) => p.endsWith("WidgetPaged.java"))).toBe(true);
    const controller = files.get(
      paths.find((p) => p.endsWith("features/widgets/WidgetsController.java"))!,
    )!;
    expect(controller).toContain("public WidgetPaged byGradeWidget(");
    // The document auto-findAll is the bare array — unchanged by this fix.
    expect(controller).toContain("public List<WidgetResponse> allWidget()");
  });

  it("registers the `<Agg>Paged` required set on the OpenAPI customizer", async () => {
    const customizer = await file(paged(), "config/OpenApiContractCustomizer.java");
    expect(customizer).toContain("WidgetPaged");
    expect(customizer).not.toContain("PagedWidgetResponse");
  });
});
