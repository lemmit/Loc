// ---------------------------------------------------------------------------
// Elixir / Phoenix — in-process boot migrator + migration-lifecycle log events
// (PR-D of the observability Tier-1 stack; sibling of #1509 which lit these up
// at the Hono / .NET / Python in-process boot runners and deferred Elixir).
//
// Both foundations (Ash 3.x and vanilla Ecto/Phoenix) share the
// `renderRelease` / `renderApplication` shell renderers, so the migrator + the
// four catalog events (`migrations_starting` / `migration_applied` /
// `migrations_complete` / `migration_failed`) must surface identically on each.
//   - `Application.start/2` runs the migrator BEFORE the supervision tree (so
//     before the Endpoint serves traffic),
//   - `Release.migrate/0` brackets `Ecto.Migrator.run` with the lifecycle
//     events, re-raising on failure (fail-fast boot),
//   - the redundant `bin/server` `eval "...Release.migrate()"` is dropped (the
//     in-process run replaces it).
// Event names/levels are asserted against the catalog in
// `src/generator/_obs/log-events.ts` (info / info / info / error).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { LogEvents } from "../../../src/generator/_obs/log-events.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

const ASH = `system Shop {
  subdomain D {
    context Catalog {
      aggregate Product with crudish {
        name: string
        price: int
      }
      repository Products for Product { }
    }
  }
  api CatalogApi from D
  storage primary { type: postgres }
  resource st { for: Catalog, kind: state, use: primary }
  deployable api {
    platform: elixir { foundation: ash }
    contexts: [Catalog]
    dataSources: [st]
    serves: CatalogApi
    port: 4000
  }
}`;

const VANILLA = `system Shop {
  subdomain D {
    context Catalog {
      aggregate Product with crudish {
        name: string
        price: int
      }
      repository Products for Product { }
    }
  }
  api CatalogApi from D
  storage primary { type: postgres }
  resource st { for: Catalog, kind: state, use: primary }
  deployable api {
    platform: elixir { foundation: vanilla }
    contexts: [Catalog]
    dataSources: [st]
    serves: CatalogApi
    port: 4000
  }
}`;

function findFile(files: Map<string, string>, suffix: string): string {
  const hit = [...files.keys()].find((p) => p.endsWith(suffix));
  expect(hit, `expected an emitted file ending in ${suffix}`).toBeDefined();
  return files.get(hit as string) as string;
}

describe.each([
  ["ash", ASH],
  ["vanilla", VANILLA],
])("elixir %s — in-process boot migrator + lifecycle events", (_foundation, source) => {
  it("runs the migrator in-process at boot, before the Endpoint", async () => {
    const files = await generateSystemFiles(source);
    const application = findFile(files, "/application.ex");

    // Migrator is invoked from Application.start/2 (in-process), not solely
    // from a separate `bin/server` eval process.
    expect(application).toContain(".Release.migrate()");
    // …and it runs BEFORE the Endpoint child is supervised, so the schema
    // exists before traffic is served.  The Endpoint child appears as a bare
    // `<App>Web.Endpoint` entry on its own line in the `children` list.
    const migrateIdx = application.indexOf(".Release.migrate()");
    const endpointChildIdx = application.search(/^\s*\w+Web\.Endpoint\s*$/m);
    expect(migrateIdx).toBeGreaterThan(-1);
    expect(endpointChildIdx).toBeGreaterThan(migrateIdx);
  });

  it("emits the four migration-lifecycle events with catalog names + levels", async () => {
    const files = await generateSystemFiles(source);
    const release = findFile(files, "/release.ex");

    // Bracketed around the actual Ecto.Migrator.run call.
    expect(release).toContain("Ecto.Migrator.run(repo, :up, all: true)");

    // migrations_starting {count} — info → Logger.info
    expect(release).toContain(
      `Logger.info("${LogEvents.migrationsStarting.event}", event: "${LogEvents.migrationsStarting.event}", count:`,
    );
    // migration_applied {id, name} — info, emitted per applied version
    expect(release).toContain(
      `Logger.info("${LogEvents.migrationApplied.event}", event: "${LogEvents.migrationApplied.event}", id:`,
    );
    expect(release).toMatch(/for version <- applied do/);
    // migrations_complete {applied} — info
    expect(release).toContain(
      `Logger.info("${LogEvents.migrationsComplete.event}", event: "${LogEvents.migrationsComplete.event}", applied:`,
    );
    // migration_failed {id, name, error} — error → Logger.error, in the
    // rescue path, then re-raised (fail-fast boot).
    expect(release).toContain(
      `Logger.error("${LogEvents.migrationFailed.event}", event: "${LogEvents.migrationFailed.event}", id:`,
    );
    expect(release).toContain("reraise error, __STACKTRACE__");

    // Catalog levels are exactly info/info/info/error.
    expect(LogEvents.migrationsStarting.level).toBe("info");
    expect(LogEvents.migrationApplied.level).toBe("info");
    expect(LogEvents.migrationsComplete.level).toBe("info");
    expect(LogEvents.migrationFailed.level).toBe("error");
  });

  it("drops the redundant bin/server migrate eval (the in-process run replaces it)", async () => {
    const files = await generateSystemFiles(source);
    const server = findFile(files, "rel/overlays/bin/server");
    expect(server).not.toContain("Release.migrate()");
    expect(server).toContain('exec "./bin/');
  });
});
