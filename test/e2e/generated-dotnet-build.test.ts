import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORPUS_DEPLOYABLE, materializeCorpusFixture } from "../fixtures/corpus/harness.js";

// ---------------------------------------------------------------------------
// Generator regression test: emit each example via `ddd generate dotnet`,
// run `dotnet restore`, then `dotnet build /warnaserror`.  Catches
// generator drift that breaks the generated C# (missing usings, bad
// EF Core configuration, signature mismatches against Mediator /
// FluentValidation / Swashbuckle) without running the full docker
// stack.
//
// Mirrors `generated-build.test.ts` (the TS-build regression).  Slow
// (~90s cold per fixture, dominated by `dotnet restore`; warm runs
// reuse the NuGet cache).  Opt-in via LOOM_DOTNET_BUILD=1 so the
// default `npm test` stays fast.  CI's
// `.github/workflows/dotnet-build.yml` runs the same check on every
// PR that touches the .NET generator.
//
// Requires the .NET SDK on PATH (10.0 — matches the generated
// `<TargetFramework>` in `templates/program.tpl.ts`).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_DOTNET_BUILD === "1";

describe.skipIf(!ENABLED)(
  "generated .NET project compiles under `dotnet build /warnaserror` (LOOM_DOTNET_BUILD=1)",
  () => {
    it.each([
      "examples/sales.ddd",
      "examples/banking.ddd",
      "examples/inventory.ddd",
      "examples/roster.ddd",
      // crudish lifecycle — the only example that emits a canonical
      // destroy, so this cell is what compiles the .NET [HttpDelete] +
      // Destroy<Agg>Command + repo DeleteAsync paths.
      "examples/lifecycle.ddd",
      // Document-persistence path (`normalised(false)`): exercises the
      // STJ round-trip emit — `<Agg>Document` record, snapshot DTOs,
      // `ToSnapshot()`/`FromSnapshot(...)`, jsonb column.
      "examples/document.ddd",
      // First-boot seeding (database-seeding.md): compiles
      // Infrastructure/Persistence/Seed.cs + the Program.cs RunSeeds wiring.
      "examples/seeding.ddd",
      // Value-object array (`Money[]`): compiles the EF `OwnsMany` mapping
      // to the id-less child table (`invoice_line_items`) — the owned
      // collection's ToTable / WithOwner FK / shadow `ordinal` key path.
      "examples/value-collections.ddd",
      // Carrier-bounded generics (payload-transport-layer.md, P3b): compiles
      // the `Paged<T>` record, the CountAsync + Skip/Take repository methods,
      // the paged CQRS query/handler, and the controller page/pageSize action.
      "examples/paged-dotnet.ddd",
      // Discriminated-union find (payload-transport-layer.md, P4c): compiles
      // the JsonPolymorphic base + variant records, the union CQRS
      // query/handler (Task.FromException stub), and the controller action.
      "examples/union-dotnet.ddd",
      // Exception-less operation return (exception-less.md, A3): compiles the
      // pure Domain union, the `ICommand<Union>` command + handler returning the
      // tagged value, and the controller action that switch-translates an error
      // variant to a ProblemDetails (stdlib status) and a success to the wire DTO.
      "examples/operation-return-dotnet.ddd",
      // A3 math intrinsics (stdlib): all 18 numeric catalogue rows in derived
      // properties + an operation (Math.Abs/Min/Max/Round-with-AwayFromZero/
      // Floor/Ceiling) AND in `find … where` positions (the EF LINQ path,
      // incl. the round query override that drops MidpointRounding).
      "test/e2e/fixtures/dotnet-build/math-intrinsics.ddd",
      // Part-in-part nesting (Order → Shipment[] → Label[]): a nested part's
      // owned-type config is nested inside its direct parent's OwnsMany, with
      // the shadow FK column named for the direct parent (labels.shipment_id)
      // and the domain ParentId branded ShipmentId (nested-parts Phase 4 — .NET).
      "test/e2e/fixtures/dotnet-build/nested-parts.ddd",
    ])("%s — `ddd generate dotnet` output restores + builds", (example) => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dotnet-"));
      try {
        execSync(`node ${cli} generate dotnet ${example} -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        execSync(`dotnet restore --nologo`, {
          cwd: outDir,
          stdio: "inherit",
          timeout: 240_000,
        });
        // `/warnaserror` keeps the gate honest about both real errors
        // and warnings (analyzer rules, nullable, EF Core warnings).
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: outDir,
          stdio: "inherit",
          timeout: 180_000,
        });
        // A `.dll` lands in `bin/Debug/net10.0/` on a successful build —
        // assert one exists so a silent no-op build can't pass.
        const binDir = path.join(outDir, "bin", "Debug", "net10.0");
        const builtDlls = fs.existsSync(binDir)
          ? fs.readdirSync(binDir).filter((f) => f.endsWith(".dll"))
          : [];
        expect(builtDlls.length, "expected at least one built .dll").toBeGreaterThan(0);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // D-REALIZATION-AXES Phase 5c: `persistence: dapper` is a SYSTEM-MODE
    // selection, so `generate dotnet` above never sees it.  Generate the SYSTEM
    // and build the dapper deployable's project under /warnaserror — proving the
    // generated Dapper repositories / DbSchema / Npgsql wiring compile.
    it("system `persistence: dapper` (dotnet) — repositories + schema build under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dapper-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/dapper.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        // Sanity: dapper replaced the EF DbContext with the self-applied schema.
        expect(fs.existsSync(path.join(proj, "Infrastructure", "Persistence", "DbSchema.cs"))).toBe(
          true,
        );
        expect(
          fs.existsSync(path.join(proj, "Infrastructure", "Persistence", "AppDbContext.cs")),
        ).toBe(false);
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        const binDir = path.join(proj, "bin", "Debug", "net10.0");
        const builtDlls = fs.existsSync(binDir)
          ? fs.readdirSync(binDir).filter((f) => f.endsWith(".dll"))
          : [];
        expect(builtDlls.length, "expected at least one built .dll").toBeGreaterThan(0);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // M-T6.9 wave 1: the Dapper adapter's PRINCIPAL surface — principal-
    // referencing lifecycle stamps (`createdBy := currentUser`,
    // `tenantId := currentUser.tenantId`) + a principal `filter`
    // (`this.tenantId == currentUser.tenantId`) on an auth deployable.  These
    // had never build-compiled on Dapper (no stamp/principal-filter dapper
    // fixture existed); this cell proves the ambient-RequestContext accessor +
    // `@__cu_<claim>` param binding compile under /warnaserror, and that no EF
    // SaveChangesInterceptor leaks onto the Dapper deployable.
    it("system `persistence: dapper` (dotnet) — principal stamps + filters build under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dapper-tenancy-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/dapper-tenancy.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        // No EF interceptor on the Dapper deployable (it would reference
        // Microsoft.EntityFrameworkCore, absent here).
        expect(
          fs.existsSync(
            path.join(proj, "Infrastructure", "Persistence", "AuditableInterceptor.cs"),
          ),
        ).toBe(false);
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        const binDir = path.join(proj, "bin", "Debug", "net10.0");
        const builtDlls = fs.existsSync(binDir)
          ? fs.readdirSync(binDir).filter((f) => f.endsWith(".dll"))
          : [];
        expect(builtDlls.length, "expected at least one built .dll").toBeGreaterThan(0);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // M-T6.9 wave 1: the Dapper adapter's PROVENANCE surface — a `provenanced`
    // field's co-located `<field>_provenance` jsonb column + the
    // `provenance_records` history flush (raw Npgsql, DbSchema DDL).  Proves the
    // shared ProvLineage SDK + the co-located round-trip + the flush compile
    // under /warnaserror, and that no EF ProvenanceRecord POCO/config leaks.
    it("system `persistence: dapper` (dotnet) — provenance columns + history flush build under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dapper-prov-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/dapper-provenance.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "d");
        // Shared lineage SDK present; EF history POCO absent on the Dapper path.
        expect(fs.existsSync(path.join(proj, "Domain", "Common", "ProvLineage.cs"))).toBe(true);
        expect(
          fs.existsSync(path.join(proj, "Infrastructure", "Persistence", "ProvenanceRecord.cs")),
        ).toBe(false);
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        const binDir = path.join(proj, "bin", "Debug", "net10.0");
        const builtDlls = fs.existsSync(binDir)
          ? fs.readdirSync(binDir).filter((f) => f.endsWith(".dll"))
          : [];
        expect(builtDlls.length, "expected at least one built .dll").toBeGreaterThan(0);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // OIDC turnkey auth (D-AUTH-OIDC): an `auth { oidc }` block emits the
    // generated OidcUserVerifier (JWKS validation + claims→User) + its NuGet
    // refs + the Program.cs registration.  This cell compiles the verifier
    // against the real Microsoft.IdentityModel.* packages under the
    // AnalysisLevel CA gate — auth files are system-mode only.
    it("system `auth { oidc }` (dotnet) — generated OIDC verifier builds under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dotnet-oidc-"));
      try {
        // Generated from the shared corpus fixture (one canonical auth-oidc across all backends).
        const src = materializeCorpusFixture("auth-oidc", "dotnet", outDir);
        execSync(`node ${cli} generate system ${src} -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        const proj = path.join(outDir, CORPUS_DEPLOYABLE);
        expect(fs.existsSync(path.join(proj, "Auth", "OidcUserVerifier.cs"))).toBe(true);
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        const binDir = path.join(proj, "bin", "Debug", "net10.0");
        const builtDlls = fs.existsSync(binDir)
          ? fs.readdirSync(binDir).filter((f) => f.endsWith(".dll"))
          : [];
        expect(builtDlls.length, "expected at least one built .dll").toBeGreaterThan(0);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // Lifecycle stamps (audit) on .NET: the EF Core AuditableInterceptor stamps
    // `createdAt := now()` (→ DateTime.UtcNow) and `createdBy := currentUser`
    // (→ the request principal's id from the ambient RequestContext) before
    // SaveChanges; stamped fields are widened to `internal set` so the
    // same-assembly interceptor can write them.  This is the .NET analogue of
    // the java-build `stamps-principal.ddd` cell — principal stamping had never
    // been compiled on .NET before.
    it("system `stamp onCreate/onUpdate` (dotnet) — AuditableInterceptor builds under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dotnet-stamps-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/stamps-principal.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        expect(
          fs.existsSync(
            path.join(proj, "Infrastructure", "Persistence", "AuditableInterceptor.cs"),
          ),
        ).toBe(true);
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        const binDir = path.join(proj, "bin", "Debug", "net10.0");
        const builtDlls = fs.existsSync(binDir)
          ? fs.readdirSync(binDir).filter((f) => f.endsWith(".dll"))
          : [];
        expect(builtDlls.length, "expected at least one built .dll").toBeGreaterThan(0);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // `with auditable` (built-in capability) — the audit-columns + stamp
    // bundle.  Its `createdBy/updatedBy: User id` names the PRINCIPAL (no
    // `aggregate User`), so it must lower to the principal's declared id scalar
    // (`user { id: guid }` → Guid), never a dangling `UserId` strong-id class.
    // Before the principal-id lowering fix this emitted an undefined `UserId`
    // (field, EF HasConversion, response DTO) and no build matrix compiled it.
    it("`with auditable` (dotnet) — audit columns + stamps build under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dotnet-auditable-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/auditable.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        const binDir = path.join(proj, "bin", "Debug", "net10.0");
        const builtDlls = fs.existsSync(binDir)
          ? fs.readdirSync(binDir).filter((f) => f.endsWith(".dll"))
          : [];
        expect(builtDlls.length, "expected at least one built .dll").toBeGreaterThan(0);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // `ignoring` filter-bypass (named-filter-bypass.md §11) — the only honoring
    // backend this slice.  Compiles all three read sites (`find ignoring <Cap>`,
    // `find ignoring *`, view bypass, inline `Repo.findAll(...) ignoring …`) so
    // the emitted `.IgnoreQueryFilters([...])` / parameterless overload + the
    // shared retrieval method's `ignoreAllFilters`/`ignoreFilters` params are
    // exercised under /warnaserror (EF Core 10's named-filter API).
    it("`ignoring` filter-bypass (dotnet) — IgnoreQueryFilters reads build under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dotnet-bypass-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/filter-bypass.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        const binDir = path.join(proj, "bin", "Debug", "net10.0");
        const builtDlls = fs.existsSync(binDir)
          ? fs.readdirSync(binDir).filter((f) => f.endsWith(".dll"))
          : [];
        expect(builtDlls.length, "expected at least one built .dll").toBeGreaterThan(0);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // DEBT-24 — a principal-referencing `criterion` used in a reified
    // `retrieval` query-face.  The retrieval's `Specification<T>` ctor is a
    // static position with no `currentUser` local, so `currentUser.<field>`
    // must resolve through the ambient accessor (`RequestContext.Current!.
    // CurrentUser!`) the capability filters already use — without it the
    // generated `MineRichSpec` names an unbound `currentUser` and fails to
    // compile (CS0103).  This cell is the regression guard for that bug.
    it("system principal `criterion` in a `retrieval` (dotnet) — spec binds the ambient principal under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dotnet-tenancy-retrieval-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/tenancy-retrieval.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        // The spec binds the ambient principal (not an unbound `currentUser`).
        const spec = fs.readFileSync(
          path.join(proj, "Domain", "Accounts", "MineRichSpec.cs"),
          "utf8",
        );
        expect(spec).toContain("RequestContext.Current!.CurrentUser!.TenantId");
        expect(spec).not.toMatch(/Where\(x => x\.TenantId == currentUser\./);
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        const binDir = path.join(proj, "bin", "Debug", "net10.0");
        const builtDlls = fs.existsSync(binDir)
          ? fs.readdirSync(binDir).filter((f) => f.endsWith(".dll"))
          : [];
        expect(builtDlls.length, "expected at least one built .dll").toBeGreaterThan(0);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // M-T5.10 handler-param rewrite — the SCAFFOLDED explicit handlers take a
    // single `command`/`query` record param; on .NET the Mediator record flattens
    // the request record's fields (`command.<Field>`) and a read declares
    // `<Agg>Response` (projected at the boundary; a find `.Select(...).ToList()`).
    // A Money-typed operation param exercises the value-object arg.  No corpus
    // `.ddd` compiled a scaffolded record-param handler on .NET before.
    it("system scaffolded explicit handlers (command/query record params, dotnet) — builds under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dn-handlers-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/scaffold-handlers.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        const controller = fs.readFileSync(
          path.join(proj, "Api", "SalesApiRoutesController.cs"),
          "utf8",
        );
        // The command record's fields flatten into the Mediator record + body;
        // a find projects the array to `<Agg>Response`.
        expect(controller).toContain("[FromBody] CreateOrderBody body");
        expect(controller).toMatch(/\.Select\(__e => new OrderResponse\(/);
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        const binDir = path.join(proj, "bin", "Debug", "net10.0");
        const builtDlls = fs.existsSync(binDir)
          ? fs.readdirSync(binDir).filter((f) => f.endsWith(".dll"))
          : [];
        expect(builtDlls.length, "expected at least one built .dll").toBeGreaterThan(0);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // The "tech showcase" system (`examples/showcase.ddd`) exercises the whole
    // language surface across multiple contexts, but it's multi-context — the
    // single-context `generate dotnet` cases above can't reach it, and no other
    // gate compiles its .NET backend.  Generate the SYSTEM and build the
    // `dotnet_api` deployable's project under /warnaserror so the showcase's
    // generated .NET code is actually compiled (the blind spot that hid the
    // value-object persistence bugs).
    it("system showcase (dotnet) — multi-context backend builds under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-showcase-dn-"));
      try {
        execSync(`node ${cli} generate system examples/showcase.ddd -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        const proj = path.join(outDir, "dotnet_api");
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        const binDir = path.join(proj, "bin", "Debug", "net10.0");
        const builtDlls = fs.existsSync(binDir)
          ? fs.readdirSync(binDir).filter((f) => f.endsWith(".dll"))
          : [];
        expect(builtDlls.length, "expected at least one built .dll").toBeGreaterThan(0);
        // The generated xUnit `Tests/` project is a SEPARATE csproj. Its
        // emission + compile-readiness (currentUser actor + no void→var) is
        // guarded by the fast generator test
        // (test/generator/dotnet/aggregate-test-currentuser.test.ts), which
        // needs no toolchain.  We assert it's emitted here, but do NOT
        // `dotnet build` it in CI: the Tests project pulls test-only packages
        // (AwesomeAssertions/xunit) that this runner's NuGet environment does
        // not have cached, and build-time restore of them isn't reliable here.
        // Actually compiling the Tests project is a Tier-1 follow-up (see
        // docs/old/plans/runtime-conformance-harness.md) once the CI NuGet feed
        // carries the test packages.
        const testProj = path.join(proj, "Tests", "DotnetApi.Tests", "DotnetApi.Tests.csproj");
        expect(fs.existsSync(testProj), "generated Tests project").toBe(true);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // D-REALIZATION-AXES Phase 5a/5b/5e: `directoryLayout: byFeature` is a
    // SYSTEM-MODE selection, so `generate dotnet` above never sees it.  Generate
    // the SYSTEM and build the byFeature deployable's project under /warnaserror
    // — proving the Features/<Plural>/ relocation + the namespace-by-feature
    // rewrite (namespace decls, usings, DI/DbContext qualified references)
    // produce a COMPILING project.  The fixture deliberately packs the
    // name-resolution hot spots: TPH inheritance (cross-feature `: Party`),
    // an extern handler (FQN startup verification), a join-table association,
    // an event-sourced aggregate, and a view that imports a relocated type.
    it("system `directoryLayout: byFeature` (dotnet) — relocated + renamespaced project builds under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-byfeature-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/byfeature.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        // Sanity: the slice moved AND its namespace mirrors the folder.
        const entity = fs.readFileSync(
          path.join(proj, "Features", "Customers", "Customer.cs"),
          "utf8",
        );
        expect(entity).toContain("namespace Api.Features.Customers;");
        expect(entity).toContain("using Api.Features.Parties;");
        expect(fs.existsSync(path.join(proj, "Domain", "Customers"))).toBe(false);
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        const binDir = path.join(proj, "bin", "Debug", "net10.0");
        const builtDlls = fs.existsSync(binDir)
          ? fs.readdirSync(binDir).filter((f) => f.endsWith(".dll"))
          : [];
        expect(builtDlls.length, "expected at least one built .dll").toBeGreaterThan(0);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // TPH (sharedTable) inheritance on EF Core (aggregate-inheritance.md I2):
    // the whole hierarchy maps to one table via `HasDiscriminator`.  This is a
    // SYSTEM-mode feature (the deployable host gates it), so generate the system
    // and build the dotnet project — proving the abstract base entity (owns the
    // shared Id), the `HasDiscriminator` base config, the derived concrete
    // entities (`: Base`, no own Id) + own-fields-only configs, and the
    // `DbSet<Base>` all compile under /warnaserror.
    it("system TPH (`inheritanceUsing: sharedTable`, dotnet) — EF HasDiscriminator hierarchy builds under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tph-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/tph.ddd -o ${outDir}`,
          {
            stdio: "inherit",
            cwd: repoRoot,
          },
        );
        const proj = path.join(outDir, "api");
        // Sanity: the base config maps the shared table + discriminator.
        const partyCfg = fs.readFileSync(
          path.join(
            proj,
            "Infrastructure",
            "Persistence",
            "Configurations",
            "PartyConfiguration.cs",
          ),
          "utf8",
        );
        expect(partyCfg).toContain('HasDiscriminator<string>("kind")');
        expect(partyCfg).toContain('.HasValue<Customer>("Customer")');
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        const binDir = path.join(proj, "bin", "Debug", "net10.0");
        const builtDlls = fs.existsSync(binDir)
          ? fs.readdirSync(binDir).filter((f) => f.endsWith(".dll"))
          : [];
        expect(builtDlls.length, "expected at least one built .dll").toBeGreaterThan(0);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // Dapper event sourcing (appliers, Dapper edition): a `persistence: dapper`
    // deployable hosting a `persistedAs: eventLog` aggregate emits the raw-Npgsql
    // event-store repository (read stream → fold, append on save) + the
    // `<agg>_events` table in DbSchema.cs, reusing the persistence-agnostic
    // domain fold + CQRS create chain.  Build under /warnaserror.
    it("system `persistence: dapper` + event sourcing — dapper event store builds under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dapper-es-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/dapper-es.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        expect(
          fs.readFileSync(path.join(proj, "Infrastructure", "Persistence", "DbSchema.cs"), "utf8"),
        ).toContain("accounts_events");
        expect(
          fs.readFileSync(
            path.join(proj, "Infrastructure", "Repositories", "AccountRepository.cs"),
            "utf8",
          ),
        ).toContain("_FromEvents");
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // M-T6.9 wave 4: an event-sourced aggregate that ALSO declares `contains`
    // parts.  The parts fold in-memory from the event stream (the `apply(...)`
    // bodies), so the ES Dapper event store emits NO state / child tables for
    // them — only the `<ctx>_events` log.  Pins that the combination builds.
    it("system `persistence: dapper` + event sourcing + contains parts — builds under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dapper-es-parts-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/dapper-es-parts.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        const schema = fs.readFileSync(
          path.join(proj, "Infrastructure", "Persistence", "DbSchema.cs"),
          "utf8",
        );
        // The contained part gets NO child table — it folds from the stream.
        expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS ledger_lines");
        expect(schema).toContain("accounts_events");
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // M-T6.9 wave 2: the Dapper adapter's NESTED ENTITY PARTS surface — a state
    // aggregate with a collection containment + a single optional containment.
    // Each persists as one flat child table (`id` PK + `<agg>_id` FK + the
    // part's own columns); reads reconstruct the root through `HydrateAsync`
    // (which loads each child table + slots them into `_Create(State)`), saves
    // full-list-replace, deletes cascade the children first.  Build under
    // /warnaserror — the part `_Create` State seam + VO/enum child columns are
    // the type-sensitive parts this gate compiles.
    it("system `persistence: dapper` + nested entity parts — child tables + hydrate build under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dapper-parts-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/dapper-parts.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        const schema = fs.readFileSync(
          path.join(proj, "Infrastructure", "Persistence", "DbSchema.cs"),
          "utf8",
        );
        expect(schema).toContain("CREATE TABLE IF NOT EXISTS line_items");
        expect(schema).toContain("references orders (id) on delete cascade");
        expect(
          fs.readFileSync(
            path.join(proj, "Infrastructure", "Repositories", "OrderRepository.cs"),
            "utf8",
          ),
        ).toContain("HydrateAsync");
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // M-T6.9 wave 4: a contained part carrying scalar / enum / value-object
    // COLLECTION fields (`tags: string[]`, `kinds: LineKind[]`, `charges:
    // Money[]`).  Each persists as one `jsonb` column on the child table
    // holding the System.Text.Json-serialised list — the List<T> deserialise
    // arms are the type-sensitive parts this gate compiles.
    it("system `persistence: dapper` + part collection fields — jsonb list columns build under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dapper-part-coll-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/dapper-part-collection.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        const schema = fs.readFileSync(
          path.join(proj, "Infrastructure", "Persistence", "DbSchema.cs"),
          "utf8",
        );
        expect(schema).toContain("tags jsonb not null");
        expect(schema).toContain("notes jsonb"); // optional list
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // M-T6.9 wave 4: nested entity parts + a reference collection on the SAME
    // aggregate.  Every read hydrates the child tables through `_Create(State)`
    // first, then LoadRefsAsync post-sets the ref-collection list — the two
    // hydrate passes compose in sequence.  Build under /warnaserror.
    it("system `persistence: dapper` + parts AND reference collection — composed hydrate builds under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dapper-parts-refs-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/dapper-parts-refs.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        const repo = fs.readFileSync(
          path.join(proj, "Infrastructure", "Repositories", "OrderRepository.cs"),
          "utf8",
        );
        expect(repo).toContain("await HydrateAsync(conn, rows.ToList(), cancellationToken)");
        expect(repo).toContain("await LoadRefsAsync(conn, __roots, cancellationToken)");
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // Event sourcing (appliers A2.2b): a `persistedAs: eventLog` aggregate on a
    // dotnet deployable emits the EF `<Agg>EventRecord` entity + config, the
    // `_Apply`/`_FromEvents` fold on the aggregate, the record-and-apply `emit`,
    // the event-store repository (fold on load / append on save), and the
    // event-sourced `Create(...)` factory.  Build the dotnet deployable under
    // /warnaserror — the discriminated-union switch + STJ round-trip are the
    // type-sensitive parts this gate compiles.
    it("system event sourcing (eventLog + appliers + create) — dotnet project builds under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dotnet-es-"));
      try {
        execSync(`node ${cli} generate system examples/event-sourcing.ddd -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        const proj = path.join(outDir, "dotnet_api");
        // Sanity: the per-context event-record entity + the fold
        // rehydrator made it out (per-context event log — event-log-architecture.md).
        // The entity is named for its OWNING context (Accounts), not a shared type.
        expect(
          fs.existsSync(
            path.join(proj, "Infrastructure", "Persistence", "Events", "AccountsEventRecord.cs"),
          ),
        ).toBe(true);
        expect(
          fs.readFileSync(path.join(proj, "Domain", "Accounts", "Account.cs"), "utf8"),
        ).toContain("_FromEvents");
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // Event-sourced WORKFLOW (workflow-and-applier.md A2-S5b): the saga folds
    // its own emitted events into state via apply(...) and persists as an
    // append-only `<wf>_events` stream — no mutable correlation-state row.
    // Compiles the `<Wf>State` fold class, the `<Wf>EventRecord` EF entity +
    // config + DbSet registration, and the fold-load / append-own-events
    // dispatch handlers.
    it("system event-sourced workflow (stream + fold + apply dispatch) — dotnet project builds under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dotnet-eswf-"));
      try {
        // Generated from the shared corpus fixture.
        const src = materializeCorpusFixture("eventsourced-workflow", "dotnet", outDir);
        execSync(`node ${cli} generate system ${src} -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        const proj = path.join(outDir, CORPUS_DEPLOYABLE);
        // Sanity: the fold class + the event-record entity made it out (and no
        // mutable saga-state POCO for the event-sourced workflow).
        expect(
          fs.readFileSync(
            path.join(proj, "Application", "Workflows", "OrderFulfillmentState.cs"),
            "utf8",
          ),
        ).toContain("_FromEvents");
        // The workflow's event-record entity is named for its OWNING context
        // (Fulfillment), not a shared type.
        expect(
          fs.existsSync(
            path.join(proj, "Infrastructure", "Persistence", "Events", "FulfillmentEventRecord.cs"),
          ),
        ).toBe(true);
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // Multi-context event log (event-log-architecture.md follow-up): ONE dotnet
    // deployable hosting TWO event-sourced contexts (an ES aggregate in each +
    // an ES workflow).  EF maps one CLR type to one table, so the shared
    // `<ctx>_events` log needs a distinct `<Ctx>EventRecord` entity + `<Ctx>Events`
    // DbSet per context — a single shared `EventRecord` collapses to one table
    // under EF's last-wins mapping and the model build fails.  The merged
    // BoundedContextIR (ctx.name = Alpha) must not mis-route Beta's streams.
    it("multi-context event log (two ES contexts, per-context EventRecord) — dotnet project builds under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dotnet-mces-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/multi-context-eventlog.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        // A distinct per-context event-record entity — NOT one shared `EventRecord.cs`.
        const events = path.join(proj, "Infrastructure", "Persistence", "Events");
        expect(fs.existsSync(path.join(events, "AlphaEventRecord.cs"))).toBe(true);
        expect(fs.existsSync(path.join(events, "BetaEventRecord.cs"))).toBe(true);
        expect(fs.existsSync(path.join(events, "EventRecord.cs"))).toBe(false);
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // M-T6.9 wave 3: the Dapper adapter's DOCUMENT SHAPE surface — a
    // `shape(document)` aggregate persists as one JSONB `data` blob (a `(id,
    // data, version)` table); contained parts + `X id[]` refs fold into the blob
    // (no child/join tables), reusing the persistence-agnostic ToSnapshot/
    // FromSnapshot round-trip.  Build under /warnaserror — the snapshot DTOs +
    // the raw-Npgsql JSONB round-trip + in-memory finds are what this compiles.
    it("system `persistence: dapper` + shape(document) — JSONB blob repository builds under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dapper-doc-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/dapper-document.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        const schema = fs.readFileSync(
          path.join(proj, "Infrastructure", "Persistence", "DbSchema.cs"),
          "utf8",
        );
        // Blob table, not a normalised per-field/child-table tree.
        expect(schema).toContain("data jsonb not null");
        expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS cart_lines");
        expect(
          fs.readFileSync(
            path.join(proj, "Infrastructure", "Repositories", "CartRepository.cs"),
            "utf8",
          ),
        ).toContain("FromSnapshot");
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        const binDir = path.join(proj, "bin", "Debug", "net10.0");
        const builtDlls = fs.existsSync(binDir)
          ? fs.readdirSync(binDir).filter((f) => f.endsWith(".dll"))
          : [];
        expect(builtDlls.length, "expected at least one built .dll").toBeGreaterThan(0);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // M-T6.9 wave 3: the Dapper adapter's EMBEDDED SHAPE surface — a
    // `shape(embedded)` aggregate keeps its own fields as FLAT columns but folds
    // each containment into ONE JSONB column (serialised part snapshots), no
    // child tables.  Build under /warnaserror — the flat-column + JSONB-column
    // mix + the snapshot round-trip on the flat `Map` are what this compiles.
    it("system `persistence: dapper` + shape(embedded) — containment JSONB columns build under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dapper-emb-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/dapper-embedded.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        const schema = fs.readFileSync(
          path.join(proj, "Infrastructure", "Persistence", "DbSchema.cs"),
          "utf8",
        );
        // Flat root columns + jsonb containment columns; no child tables.
        expect(schema).toContain("lines jsonb not null");
        expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS cart_lines");
        expect(
          fs.readFileSync(
            path.join(proj, "Infrastructure", "Repositories", "CartRepository.cs"),
            "utf8",
          ),
        ).toContain("CartLine.FromSnapshot");
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        const binDir = path.join(proj, "bin", "Debug", "net10.0");
        const builtDlls = fs.existsSync(binDir)
          ? fs.readdirSync(binDir).filter((f) => f.endsWith(".dll"))
          : [];
        expect(builtDlls.length, "expected at least one built .dll").toBeGreaterThan(0);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);

    // M-T6.9 wave 3: the Dapper adapter's TPC (`ownTable`) INHERITANCE surface —
    // each concrete is a standalone table carrying the merged base + own fields
    // (a normal Dapper repository); the abstract base owns no table; the
    // polymorphic base reader delegates to each concrete's `All()`.  Build under
    // /warnaserror — the merged-field `_Create(State)` hydration + the
    // persistence-agnostic base reader on Dapper concretes are what this compiles.
    it("system `persistence: dapper` + TPC inheritance — merged-field concrete tables build under /warnaserror", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dapper-tpc-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/dotnet-build/dapper-tpc.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        const schema = fs.readFileSync(
          path.join(proj, "Infrastructure", "Persistence", "DbSchema.cs"),
          "utf8",
        );
        // Concrete tables carry merged fields; no table for the abstract base.
        expect(schema).toContain("CREATE TABLE IF NOT EXISTS customers");
        expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS parties");
        expect(
          fs.readFileSync(
            path.join(proj, "Infrastructure", "Repositories", "PartyRepository.cs"),
            "utf8",
          ),
        ).toContain("_customerRepo.All(cancellationToken)");
        execSync(`dotnet restore --nologo`, { cwd: proj, stdio: "inherit", timeout: 240_000 });
        execSync(`dotnet build --no-restore --nologo /warnaserror`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        const binDir = path.join(proj, "bin", "Debug", "net10.0");
        const builtDlls = fs.existsSync(binDir)
          ? fs.readdirSync(binDir).filter((f) => f.endsWith(".dll"))
          : [];
        expect(builtDlls.length, "expected at least one built .dll").toBeGreaterThan(0);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);
  },
);
