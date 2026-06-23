// ---------------------------------------------------------------------------
// Java backend — workflows, views, auth, extern (slice S6 of
// docs/plans/java-backend-implementation.md).  The same surface boots and
// behaves against Postgres (manually verified; LOOM_JAVA_BUILD compiles
// the committed showcase-java fixture); these unit tests pin the emitted
// shapes.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Hub {
  user {
    id: guid
    role: string
  }
  subdomain Projects {
    context Catalog {
      enum Visibility { Private, Public }
      aggregate Project {
        name: string
        visibility: Visibility
        active: bool
        operation rename(newName: string) {
          requires currentUser.role == "admin"
          precondition newName.length > 0
          name := newName
        }
        operation syncFromVcs() extern {
          precondition active == true
        }
      }
      repository Projects for Project { }

      workflow registerProject {
        create(name: string, visibility: Visibility) {
          requires currentUser.role == "admin"
          precondition name.length > 0
          let proj = Project.create({ name: name, visibility: visibility, active: true })
          proj.rename(name)
        }
      }

      view ActiveProjects = Project where active == true
      view ProjectSummary {
        projectId: Project id
        name: string
        from Project where visibility != Private
        bind projectId = id,
             name = name
      }
    }
  }
  api ProjectsApi from Projects
  storage primary { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: primary }
  deployable hub {
    platform: java
    contexts: [Catalog]
    dataSources: [catalogState]
    serves: ProjectsApi
    port: 8081
    auth: required
  }
}
`;

const ROOT = "hub/src/main/java/com/loom/hub";

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("java generator — auth surface (S6)", () => {
  it("emits the typed User record, verifier boundary, dev stub, and 401 filter", async () => {
    const f = await files();
    expect(f.get(`${ROOT}/auth/User.java`)).toContain("public record User(UUID id, String role) {");
    expect(f.get(`${ROOT}/auth/UserVerifier.java`)).toContain(
      "User verify(HttpServletRequest request);",
    );
    expect(f.get(`${ROOT}/auth/DevStubUserVerifier.java`)).toContain(
      'return new User(new UUID(0L, 0L), "admin");',
    );
    const filter = f.get(`${ROOT}/auth/UserFilter.java`)!;
    expect(filter).toContain('"/health",');
    expect(filter).toContain("response.setStatus(401);");
  });

  it("threads currentUser from the accessor into ops that require it", async () => {
    const svc = (await files()).get(`${ROOT}/features/projects/ProjectService.java`)!;
    expect(svc).toContain("var currentUser = currentUserAccessor.user();");
    expect(svc).toContain("aggregate.rename(newName, currentUser);");
  });
});

describe("java generator — extern operations (S6)", () => {
  it("emits the handler interface + throwing dev stub", async () => {
    const f = await files();
    const iface = f.get(`${ROOT}/features/projects/SyncFromVcsProjectHandler.java`)!;
    expect(iface).toContain("public interface SyncFromVcsProjectHandler {");
    expect(iface).toContain("void handle(Project aggregate);");
    const stub = f.get(`${ROOT}/features/projects/DevStubSyncFromVcsProjectHandler.java`)!;
    expect(stub).toContain("@Component");
    expect(stub).toContain("throw new UnsupportedOperationException(");
  });

  it("service runs check → handler → invariants → save", async () => {
    const svc = (await files()).get(`${ROOT}/features/projects/ProjectService.java`)!;
    expect(svc).toContain("aggregate.checkSyncFromVcs();");
    expect(svc).toContain("syncFromVcsHandler.handle(aggregate);");
    expect(svc).toContain("aggregate._assertInvariants();");
  });

  it("wraps a throwing handler so non-domain faults log extern_handler_threw", async () => {
    // Parity with Hono/.NET/Python: a non-domain throw from the user handler
    // becomes an ExternHandlerException (→ catalog extern_handler_threw + a
    // sanitized 500), distinct from a generic internal_error.  Domain
    // exceptions re-throw untranslated so 400/403/404/409 still apply.
    const f = await files();
    const svc = f.get(`${ROOT}/features/projects/ProjectService.java`)!;
    expect(svc).toContain(
      "} catch (DomainException | ForbiddenException | DisallowedException | AggregateNotFoundException e) {",
    );
    expect(svc).toContain('throw new ExternHandlerException("syncFromVcs", "Project", e);');

    const exc = f.get(`${ROOT}/domain/common/ExternHandlerException.java`)!;
    expect(exc).toContain("public class ExternHandlerException extends RuntimeException {");
    expect(exc).toContain(
      "public ExternHandlerException(String opName, String aggName, Throwable cause) {",
    );

    const advice = f.get(`${ROOT}/api/ApiExceptionAdvice.java`)!;
    expect(advice).toContain("@ExceptionHandler(ExternHandlerException.class)");
    expect(advice).toContain(
      'CatalogLog.event("extern_handler_threw", "error", "aggregate", e.aggName(), "op", e.opName(), "error", e.getMessage());',
    );
    expect(advice).toContain(
      'return respond(problem(500, "Internal Server Error", e.getMessage(), request), 500);',
    );
  });
});

describe("java generator — workflows (S6)", () => {
  it("routes POST /workflows/<snake> through the per-context workflows service", async () => {
    const f = await files();
    const ctrl = f.get(`${ROOT}/api/CatalogWorkflowsController.java`)!;
    expect(ctrl).toContain('@RequestMapping("/api/workflows")');
    expect(ctrl).toContain('@PostMapping("/register_project")');
    expect(ctrl).toContain("workflows.registerProject(request);");
    const svc = f.get(`${ROOT}/application/workflows/CatalogWorkflows.java`)!;
    expect(svc).toContain(
      'if (!(Objects.equals(currentUser.role(), "admin"))) throw new ForbiddenException',
    );
    // factory-let orders the target's create-input list, nulls for absent.
    expect(svc).toContain("var proj = Project.create(name, visibility, true);");
    // op-call threads currentUser into ops that use it.
    expect(svc).toContain("proj.rename(name, currentUser);");
    // at-exit save for the dirty let.
    expect(svc).toContain("projectsRepository.save(proj);");
  });
});

describe("java generator — views (S6)", () => {
  it("shorthand views reuse the aggregate response; full-form views get Row records", async () => {
    const f = await files();
    const ctrl = f.get(`${ROOT}/api/CatalogViewsController.java`)!;
    expect(ctrl).toContain('@RequestMapping("/api/views")');
    expect(ctrl).toContain('@GetMapping("/active_projects")');
    expect(ctrl).toContain('@GetMapping("/project_summary")');
    const svc = f.get(`${ROOT}/application/views/CatalogViews.java`)!;
    expect(svc).toContain(
      "return projectsRepository.activeProjects().stream().map(ProjectResponse::from).toList();",
    );
    // Bind exprs render through accessors (cross-package) + wire conversion.
    expect(svc).toContain(".map(a -> new ProjectSummaryRow(a.id().value(), a.name()))");
    const row = f.get(`${ROOT}/application/views/ProjectSummaryRow.java`)!;
    expect(row).toContain("public record ProjectSummaryRow(UUID projectId, String name) {");
  });

  it("view reads ride synthesized repository finds (JPQL)", async () => {
    const jpa = (await files()).get(`${ROOT}/features/projects/ProjectJpaRepository.java`)!;
    expect(jpa).toContain('@Query("select e from Project e where e.active = true")');
    expect(jpa).toContain("List<Project> activeProjects();");
  });
});
