import type { EnrichedBoundedContextIR } from "../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../util/naming.js";
import { voHasConstraints } from "./vanilla/changeset-validators.js";
import { renderVanillaContextIntegrationTest } from "./vanilla/integration-tests-emit.js";
import {
  renderVanillaAggregateTestModule,
  renderVanillaServiceTestModule,
  renderVanillaVoTestModule,
} from "./vanilla/tests-emit.js";

// ---------------------------------------------------------------------------
// `test "..." { ... }` DSL → ExUnit test module (the vitest/xUnit/pytest/JUnit
// sibling).  This closes the Phoenix half of the domain-test parity gap
// (docs/audits/test-parity-generated-backends.md, F1).
//
// The aggregate carries a PURE domain core (`vanilla/domain-core-emit.ts`):
// `create/1` validates via `apply_action` and each op runs precondition +
// in-memory mutation, both Repo-free.  `vanilla/tests-emit.ts` ports the full
// Loom idiom (create / op / toThrow / field reads) onto it.
// ---------------------------------------------------------------------------

/** Emit one `test/<ctx>/<agg>_test.exs` per aggregate that declares `test`
 *  blocks.  Returns true if any file was emitted (so the orchestrator knows to
 *  emit the once-per-project `test/test_helper.exs`). */
export function emitAggregateTests(
  ctx: EnrichedBoundedContextIR,
  appModule: string,
  _foundation: "vanilla",
  out: Map<string, string>,
): boolean {
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  // Value objects with a validating constructor (F5) — the emitter lowers
  // `expect(VO{bad}).toThrow()` against these.
  const validatableVos = new Set(
    ctx.valueObjects.filter((vo) => voHasConstraints(vo)).map((vo) => vo.name),
  );
  let emitted = false;
  for (const agg of ctx.aggregates) {
    if (agg.tests.length === 0) continue;
    // Vanilla ports the full idiom onto the aggregate's pure domain core
    // (vanilla/tests-emit.ts + domain-core-emit.ts).
    const content = renderVanillaAggregateTestModule(agg, contextModule, appModule, validatableVos);
    out.set(`test/${snake(ctx.name)}/${snake(agg.name)}_test.exs`, content);
    emitted = true;
  }
  // Value-object / domain-service unit tests (test-placement.md, Phase 2) —
  // colocated ExUnit modules; a VO test exercises its `<VO>.new/1` invariant,
  // a service test its pure ops.  Shapes the vanilla renderer can't lower
  // degrade to a `@tag :skip`, never broken Elixir.
  for (const vo of ctx.valueObjects) {
    if (vo.tests.length === 0) continue;
    out.set(
      `test/${snake(ctx.name)}/${snake(vo.name)}_test.exs`,
      renderVanillaVoTestModule(vo, contextModule, appModule, validatableVos),
    );
    emitted = true;
  }
  for (const svc of ctx.domainServices) {
    if (svc.tests.length === 0) continue;
    out.set(
      `test/${snake(ctx.name)}/${snake(svc.name)}_test.exs`,
      renderVanillaServiceTestModule(svc, contextModule, appModule, validatableVos),
    );
    emitted = true;
  }
  // Context INTEGRATION test (test-placement.md, Phase 3b) — an ExUnit module
  // that persists→reads through the context module against the live Ecto repo
  // (Sandbox-isolated).  Emitted only when the context declares integration tests.
  const integration = renderVanillaContextIntegrationTest(ctx, appModule);
  if (integration) {
    out.set(`test/${snake(ctx.name)}_integration_test.exs`, integration);
    emitted = true;
  }
  return emitted;
}

/** The once-per-project `test/test_helper.exs` (`ExUnit.start()`); the shells
 *  don't emit one, and `mix test` requires it. */
export function emitTestHelper(out: Map<string, string>): void {
  out.set("test/test_helper.exs", "ExUnit.start()\n");
}
