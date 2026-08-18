import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Direct-caller ratchet (M-T9.35).
//
// `test/_helpers/generate.ts` is where a fixture is checked before anything
// asserts on what it emits — phase ① (syntax), ④ (AST validation) and ⑦
// (`validateLoomModel`).  A test that imports `generateSystems` /
// `generateSystemsFromLoom` straight from `src/system/index.js` bypasses all
// three, so no assertion added to the helper can ever reach it.  That is how
// 166 error-carrying generations survived M-T9.34's flip: they were never on
// the helper's path in the first place.
//
// This pins the remaining set so it can only SHRINK.  Two directions, both
// ratcheting:
//
//   NEW      — a file that imports the orchestrator directly and is not pinned
//              fails.  Reach for `generateSystemFiles(source, options?)` /
//              `generateSystemResult(source, options?)` instead; if the fixture
//              must stay one the product refuses, that is
//              `generateSystemFilesUnchecked(source, why)`.
//   STALE    — a pinned file that no longer imports it fails, so a migration
//              deletes its pin in the same commit.
//
// Only the IMPORT is matched, not usage: a file that imports the symbol has
// the capability, and re-export laundering (`export { generateSystems }` from
// a helper) is caught because the helper barrel is scanned too.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const testRoot = path.join(repoRoot, "test");

/** The orchestrator entry points a test must not import directly. */
const GATED = new Set(["generateSystems", "generateSystemsFromLoom"]);

/**
 * Files still importing the orchestrator directly, as of M-T9.35.
 *
 * This list is a BACKLOG, not an allowance.  Every entry is a fixture whose
 * pipeline-phase coverage is whatever its own `parseValid` / manual
 * diagnostics-check happens to do — `parseValid` covers ① + ④, a bare
 * `parseString` covers neither, and nothing here covers ⑦.
 *
 * `test/_helpers/generate.ts` is the one legitimate importer — it IS the
 * gated wrapper — and is exempted below rather than pinned.
 */
const PINNED: readonly string[] = [
  "test/adapters/cqrs-style-per-op.test.ts",
  "test/adapters/dotnet-dapper.test.ts",
  "test/adapters/dotnet-orchestrator-rewire.test.ts",
  "test/adapters/hono-orchestrator-rewire.test.ts",
  "test/adapters/node-mikroorm-channels.test.ts",
  "test/adapters/node-mikroorm-outbox.test.ts",
  "test/adapters/node-mikroorm-projection.test.ts",
  "test/adapters/node-mikroorm-query-projections.test.ts",
  "test/adapters/node-mikroorm-realtime.test.ts",
  "test/adapters/node-mikroorm-timers.test.ts",
  "test/adapters/node-mikroorm.test.ts",
  "test/conformance/audit-records-consistency.test.ts",
  "test/conformance/corpus-mutation.test.ts",
  "test/dap/breakpoints.test.ts",
  "test/dap/session.test.ts",
  "test/dap/set-breakpoints.test.ts",
  "test/dap/stack-trace.test.ts",
  "test/e2e/schema-load.test.ts",
  "test/generator/_packs/money-emission.test.ts",
  "test/generator/_packs/order-explicit-equivalence.test.ts",
  "test/generator/_walker/page-emitter-equivalence.test.ts",
  "test/generator/angular/sourcemap.test.ts",
  "test/generator/audit-history-node.test.ts",
  "test/generator/dotnet/api-client.test.ts",
  "test/generator/dotnet/audit-history-dotnet.test.ts",
  "test/generator/dotnet/dapper-audit-shape-drain.test.ts",
  "test/generator/dotnet/dapper-enum-find-param.test.ts",
  "test/generator/dotnet/dapper-projection-emission.test.ts",
  "test/generator/dotnet/dapper-query-projection-emission.test.ts",
  "test/generator/dotnet/dapper-save-transaction.test.ts",
  "test/generator/dotnet/dotnet-datasource-schema.test.ts",
  "test/generator/dotnet/dotnet-migrations-emit.test.ts",
  "test/generator/dotnet/dotnet-provenance-audit.test.ts",
  "test/generator/dotnet/dotnet-resource-ops.test.ts",
  "test/generator/dotnet/dotnet-saga-starter-guard.test.ts",
  "test/generator/dotnet/dotnet-stamping.test.ts",
  "test/generator/dotnet/dotnet-timer-scheduler.test.ts",
  "test/generator/dotnet/dotnet-wire-conformance.test.ts",
  "test/generator/dotnet/dotnet-workflow-event-sourced.test.ts",
  "test/generator/dotnet/dotnet-workflow-vo-param-ns.test.ts",
  "test/generator/dotnet/file-upload.test.ts",
  "test/generator/dotnet/line-directives.test.ts",
  "test/generator/dotnet/paged-emit.test.ts",
  "test/generator/dotnet/realtime-emission.test.ts",
  "test/generator/dotnet/vo-invariant-422.test.ts",
  "test/generator/elixir/api-client.test.ts",
  "test/generator/elixir/audit-history-elixir.test.ts",
  "test/generator/elixir/auth-oidc-emit.test.ts",
  "test/generator/elixir/file-upload.test.ts",
  "test/generator/elixir/phoenix-action.test.ts",
  "test/generator/elixir/phoenix-e2e-dispatch.test.ts",
  "test/generator/elixir/phoenix-extern-component.test.ts",
  "test/generator/elixir/phoenix-extern-function.test.ts",
  "test/generator/elixir/phoenix-resource-ops.test.ts",
  "test/generator/elixir/phoenix-user-components.test.ts",
  "test/generator/elixir/store.test.ts",
  "test/generator/elixir/vanilla-mailer-config.test.ts",
  "test/generator/elixir/vanilla-outbox-marker.test.ts",
  "test/generator/elixir/vanilla-standalone-outbox.test.ts",
  "test/generator/elixir/vanilla-timer-scheduler.test.ts",
  "test/generator/elixir/vanilla-workflow-instances.test.ts",
  "test/generator/flutter/param-find-reads.test.ts",
  "test/generator/hono/hono-seed.test.ts",
  "test/generator/hono/hono-stamping.test.ts",
  "test/generator/hono/hono-wire-conformance.test.ts",
  "test/generator/hono/validation-error-extension.test.ts",
  "test/generator/java/api-client.test.ts",
  "test/generator/java/audit-history-java.test.ts",
  "test/generator/java/file-upload.test.ts",
  "test/generator/java/java-provenance.test.ts",
  "test/generator/java/java-timer-scheduler.test.ts",
  "test/generator/java/java-workflow-command-surface.test.ts",
  "test/generator/java/java-workflow-state.test.ts",
  "test/generator/java/realtime-emission.test.ts",
  "test/generator/java/vo-invariant-422.test.ts",
  "test/generator/java/when-emit.test.ts",
  "test/generator/mailer-resource.test.ts",
  "test/generator/operation-self-call.test.ts",
  "test/generator/operation-workflow-requires-gate.test.ts",
  "test/generator/projection-aggregate-money-scale.test.ts",
  "test/generator/projection-groupby-datekey-backends.test.ts",
  "test/generator/projection-shorthand-backends.test.ts",
  "test/generator/projection-source-backends.test.ts",
  "test/generator/projection-workflow-source-backends.test.ts",
  "test/generator/python/api-client.test.ts",
  "test/generator/python/audit-history-python.test.ts",
  "test/generator/python/audited-operation.test.ts",
  "test/generator/python/context-filter-emit.test.ts",
  "test/generator/python/context-integration-test.test.ts",
  "test/generator/python/domain-service-emit.test.ts",
  "test/generator/python/domain-service-mutating.test.ts",
  "test/generator/python/domain-service-reading.test.ts",
  "test/generator/python/file-upload.test.ts",
  "test/generator/python/generator-python-tenancy-filter.test.ts",
  "test/generator/python/intrinsic-trim.test.ts",
  "test/generator/python/python-aggregate.test.ts",
  "test/generator/python/python-auth-oidc.test.ts",
  "test/generator/python/python-dispatch.test.ts",
  "test/generator/python/python-document-capability-filter.test.ts",
  "test/generator/python/python-document.test.ts",
  "test/generator/python/python-domain.test.ts",
  "test/generator/python/python-embedded.test.ts",
  "test/generator/python/python-eventlog.test.ts",
  "test/generator/python/python-extern.test.ts",
  "test/generator/python/python-filter-bypass.test.ts",
  "test/generator/python/python-find-gate.test.ts",
  "test/generator/python/python-finds.test.ts",
  "test/generator/python/python-fullstack.test.ts",
  "test/generator/python/python-inheritance.test.ts",
  "test/generator/python/python-migrations.test.ts",
  "test/generator/python/python-obs.test.ts",
  "test/generator/python/python-outbox.test.ts",
  "test/generator/python/python-persistence.test.ts",
  "test/generator/python/python-resources.test.ts",
  "test/generator/python/python-ruff-clean.test.ts",
  "test/generator/python/python-saga-starter-guard.test.ts",
  "test/generator/python/python-seed.test.ts",
  "test/generator/python/python-shell.test.ts",
  "test/generator/python/python-tests-emit.test.ts",
  "test/generator/python/python-timer-scheduler.test.ts",
  "test/generator/python/python-trace.test.ts",
  "test/generator/python/python-transaction.test.ts",
  "test/generator/python/python-views.test.ts",
  "test/generator/python/python-when.test.ts",
  "test/generator/python/python-workflow-event-sourced.test.ts",
  "test/generator/python/python-workflow-instances.test.ts",
  "test/generator/python/python-workflows.test.ts",
  "test/generator/python/realtime-emission.test.ts",
  "test/generator/python/repository-port-id-vo.test.ts",
  "test/generator/python/repository-port.test.ts",
  "test/generator/python/routes-create-default.test.ts",
  "test/generator/python/routes-cross-aggregate-id-import.test.ts",
  "test/generator/python/temporal.test.ts",
  "test/generator/python/trunc-mod.test.ts",
  "test/generator/python/value-objects-utc-import.test.ts",
  "test/generator/python/vo-invariant-422.test.ts",
  "test/generator/react/frontend-acl-emit.test.ts",
  "test/generator/react/generator-react.test.ts",
  "test/generator/react/money-form-generics.test.ts",
  "test/generator/react/sourcemap.test.ts",
  "test/generator/react/walker-anchor.test.ts",
  "test/generator/react/walker-style-attr.test.ts",
  "test/generator/react/walker-text-emphasis.test.ts",
  "test/generator/svelte/sourcemap.test.ts",
  "test/generator/typescript/api-client.test.ts",
  "test/generator/typescript/filter-bypass.test.ts",
  "test/generator/typescript/hono-datasource-schema.test.ts",
  "test/generator/typescript/hono-find-gate.test.ts",
  "test/generator/typescript/hono-resource-clients.test.ts",
  "test/generator/typescript/hono-resource-ops-4b.test.ts",
  "test/generator/typescript/hono-resource-ops.test.ts",
  "test/generator/typescript/hono-workflow-instances.test.ts",
  "test/generator/typescript/projection-gate.test.ts",
  "test/generator/typescript/projection-workflow-source.test.ts",
  "test/generator/typescript/realtime-emission.test.ts",
  "test/generator/typescript/strip-erasable-constructors.test.ts",
  "test/generator/vue/sourcemap.test.ts",
  "test/generator/vue/vue-embedding.test.ts",
  "test/generator/walker-match-expression.test.ts",
  "test/ir/audited.test.ts",
  "test/ir/provenance.test.ts",
  "test/language/lsp/lsp-implementation.test.ts",
  "test/language/parsing/aggregate-inheritance.test.ts",
  "test/language/parsing/top-level-subdomain.test.ts",
  "test/macro/version-field-collision.test.ts",
  "test/pairwise/harness.ts",
  "test/platform/backend-parity-gates.test.ts",
  "test/platform/dotnet-fullstack.test.ts",
  "test/platform/dotnet-multi-context-eventlog-naming.test.ts",
  "test/platform/frontend-dispatch.test.ts",
  "test/platform/hono-multi-context-eventlog-naming.test.ts",
  "test/platform/hono-timer-scheduler.test.ts",
  "test/platform/python-multi-context-eventlog-naming.test.ts",
  "test/playground/build-worker-sourcemap.test.ts",
  "test/playground/multifile-vfs-loader.test.ts",
  "test/playground/playground-mobile-ux.test.ts",
  "test/playground/strip-sourcemap.test.ts",
  "test/system/api-resource-compose.test.ts",
  "test/system/architecture-integration.test.ts",
  "test/system/cors-origin.test.ts",
  "test/system/datasource-isolation.test.ts",
  "test/system/k8s-smoke-example.test.ts",
  "test/system/keycloak-compose.test.ts",
  "test/system/kubernetes-helm.test.ts",
  "test/system/launch-config.test.ts",
  "test/system/migration-artifacts.test.ts",
  "test/system/multifile-regression.test.ts",
  "test/system/node-debug.test.ts",
  "test/system/playground-feature-examples.test.ts",
  "test/system/playground-remaining-examples.test.ts",
  "test/system/playground-storybook-examples.test.ts",
  "test/system/prometheus-collector.test.ts",
  "test/system/sourcemap.test.ts",
  "test/system/storage-sidecars.test.ts",
  "test/system/system.test.ts",
  "test/system/trace-roundtrip.test.ts",
  "test/system/traceability.test.ts",
];

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "fixtures") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, out);
    else if (entry.isFile() && /\.[cm]?tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** `true` when the module specifier resolves to `src/system/index.js`. */
const isOrchestratorModule = (spec: string): boolean => /(^|\/)src\/system\/index\.js$/.test(spec);

/**
 * Every test-tree file importing a gated symbol from the orchestrator, plus
 * the number of files scanned (the vacuous-pass guard).
 */
function census(): { importers: string[]; scanned: number } {
  const importers: string[] = [];
  let scanned = 0;

  for (const file of testFiles(testRoot)) {
    scanned++;
    const text = fs.readFileSync(file, "utf8");
    // Cheap prefilter — the AST parse below is the authority.
    if (!text.includes("src/system/index.js")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const rel = path.relative(repoRoot, file);
    let hit = false;

    const named = (bindings: ts.NamedImportBindings | undefined): boolean =>
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((e) => GATED.has((e.propertyName ?? e.name).text));

    const visit = (node: ts.Node): void => {
      if (hit) return;
      // `import { generateSystems } from ".../src/system/index.js"`
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        isOrchestratorModule(node.moduleSpecifier.text) &&
        named(node.importClause?.namedBindings)
      ) {
        hit = true;
        return;
      }
      // `const { generateSystems } = await import(".../src/system/index.js")`
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0]!) &&
        isOrchestratorModule((node.arguments[0] as ts.StringLiteral).text)
      ) {
        // The binding is on the enclosing declaration / await expression.
        let owner: ts.Node | undefined = node.parent;
        while (owner && !ts.isVariableDeclaration(owner) && !ts.isSourceFile(owner)) {
          owner = owner.parent;
        }
        if (
          owner &&
          ts.isVariableDeclaration(owner) &&
          ts.isObjectBindingPattern(owner.name) &&
          owner.name.elements.some((e) =>
            GATED.has(((e.propertyName ?? e.name) as ts.Identifier).text ?? ""),
          )
        ) {
          hit = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    // The gated wrapper itself is the one legitimate importer.
    if (hit && rel !== "test/_helpers/generate.ts") importers.push(rel);
  }
  return { importers: importers.sort(), scanned };
}

describe("direct `generateSystems` importers under test/ (M-T9.35)", () => {
  const { importers, scanned } = census();

  it("scans the whole test tree (guard against a vacuous pass)", () => {
    // If the walker silently stopped finding files, every assertion below
    // would pass on an empty set.
    expect(scanned).toBeGreaterThan(1_000);
  });

  it("no NEW direct importer", () => {
    const pinned = new Set(PINNED);
    const added = importers.filter((f) => !pinned.has(f));
    expect(
      added,
      `${added.length} test file(s) import the system orchestrator directly, bypassing the ` +
        `phase ①/④/⑦ assertions in test/_helpers/generate.ts.  Use ` +
        `generateSystemFiles(source, options?) or generateSystemResult(source, options?) — ` +
        `or generateSystemFilesUnchecked(source, why) if the fixture must stay one the ` +
        `product refuses.`,
    ).toEqual([]);
  });

  it("no STALE pin (the list ratchets down)", () => {
    const live = new Set(importers);
    const gone = PINNED.filter((f) => !live.has(f));
    expect(
      gone,
      `${gone.length} pinned file(s) no longer import the orchestrator directly — delete ` +
        `their entries from PINNED in the same change that migrated them.`,
    ).toEqual([]);
  });
});
