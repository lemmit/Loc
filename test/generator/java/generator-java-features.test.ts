// ---------------------------------------------------------------------------
// Java backend — workflows, views, auth, extern (slice S6 of
// docs/plans/java-backend-implementation.md).  The same surface boots and
// behaves against Postgres (manually verified; LOOM_JAVA_BUILD compiles
// examples/showcase.ddd's java deployable); these unit tests pin the
// emitted shapes.
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

describe("java generator — extern operations (domain extension point, Phase 2)", () => {
  // The aggregate `operation X() extern` re-homes from an injected per-op handler
  // to a co-located, scaffold-once `<Agg>Extern` hook the op delegates to
  // (extern-domain-extension-point.md §3a; mirrors the Elixir analog #1841).
  it("scaffolds a co-located <Agg>Extern hook — same package, loud throw, marker", async () => {
    const f = await files();
    const hook = f.get(`${ROOT}/features/projects/ProjectExtern.java`)!;
    // Scaffold-once marker on line 1 so the CLI writer preserves it on regen.
    expect(hook.split("\n")[0]).toContain("loom:scaffold-once");
    // Same package as the aggregate → native package-private field access.
    expect(hook).toContain("package com.loom.hub.features.projects;");
    expect(hook).toContain("final class ProjectExtern {");
    // One static method per extern op, taking the loaded aggregate; loud default.
    expect(hook).toContain("static void syncFromVcs(Project project) {");
    expect(hook).toContain(
      'throw new UnsupportedOperationException("extern operation `syncFromVcs` on Project is not implemented — fill in ProjectExtern.syncFromVcs(...)");',
    );
  });

  it("the aggregate op runs preconditions → delegates to the hook → re-asserts invariants", async () => {
    const proj = (await files()).get(`${ROOT}/features/projects/Project.java`)!;
    expect(proj).toContain("public void syncFromVcs() {");
    // preconditions inline, then delegate, then invariants — the framework flow.
    expect(proj).toContain('throw new DomainException("Precondition failed: active == true");');
    expect(proj).toContain("ProjectExtern.syncFromVcs(this);");
    expect(proj).toContain("this._assertInvariants();");
    // The `_raiseEvent` hook the extern impl uses to emit domain events.
    expect(proj).toContain("public void _raiseEvent(DomainEvent ev) {");
  });

  it("the service calls the op directly — no injected handler, no ExternHandlerException", async () => {
    const f = await files();
    const svc = f.get(`${ROOT}/features/projects/ProjectService.java`)!;
    expect(svc).toContain("var aggregate = repository.getById(id);");
    expect(svc).toContain("aggregate.syncFromVcs();");
    // The injected apparatus is gone: no handler field/injection, no check<Op>,
    // no ExternHandlerException wrap.
    expect(svc).not.toContain("Handler");
    expect(svc).not.toContain("checkSyncFromVcs");
    expect(svc).not.toContain("ExternHandlerException");
    // ExternHandlerException itself is deleted (grep-confirmed not shared with the
    // Phase 1 `extern commandHandler`/`queryHandler` feature).
    expect(f.has(`${ROOT}/domain/common/ExternHandlerException.java`)).toBe(false);
    expect(f.get(`${ROOT}/api/ApiExceptionAdvice.java`)!).not.toContain("ExternHandlerException");
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
