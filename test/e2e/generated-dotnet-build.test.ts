import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
// Requires the .NET SDK on PATH (8.0 — matches the generated
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
        // A `.dll` lands in `bin/Debug/net8.0/` on a successful build —
        // assert one exists so a silent no-op build can't pass.
        const binDir = path.join(outDir, "bin", "Debug", "net8.0");
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
        const binDir = path.join(proj, "bin", "Debug", "net8.0");
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
        const binDir = path.join(proj, "bin", "Debug", "net8.0");
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
    it("system TPH (`inheritanceUsing(sharedTable)`, dotnet) — EF HasDiscriminator hierarchy builds under /warnaserror", () => {
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
        const binDir = path.join(proj, "bin", "Debug", "net8.0");
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
    // deployable hosting a `persistedAs(eventLog)` aggregate emits the raw-Npgsql
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
        ).toContain("account_events");
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

    // Event sourcing (appliers A2.2b): a `persistedAs(eventLog)` aggregate on a
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
        // Sanity: the EF event-record entity + the fold rehydrator made it out.
        expect(
          fs.existsSync(
            path.join(proj, "Infrastructure", "Persistence", "Events", "AccountEventRecord.cs"),
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
  },
);
