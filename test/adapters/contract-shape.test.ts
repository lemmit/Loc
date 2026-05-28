// Contract-shape tests — these are type-level only.  Each `_` assignment
// would fail to compile if the contract's signature drifted from what the
// micro-plan promises (and that drift would in turn break the F5 / F6 /
// F7 seam refactors).  No runtime expectations beyond "code loads".

import { describe, it } from "vitest";
import type {
  EmitCtx,
  LayoutAdapter,
  LayoutShape,
  Lines,
  PersistenceAdapter,
  StyleAdapter,
} from "../../src/generator/_adapters/index.js";

describe("adapter contract shape (type-level)", () => {
  it("PersistenceAdapter exposes the seven F3-spec methods", () => {
    // Inhabit the contract with an explicit lambda per method so any
    // signature mismatch surfaces at `tsc`, not at runtime.
    const _: PersistenceAdapter = {
      name: "x",
      supportedStrategies: ["stateBased"],
      supports: (_t, _k, _s) => true,
      emitProjectDeps: (_ctx: EmitCtx): Lines => [],
      emitConnectionSetup: (_stores, _ctx: EmitCtx): Lines => [],
      emitRepository: (_agg, _logical, _ctx: EmitCtx): Lines => [],
      emitMigrations: (_aggs, _stores, _ctx: EmitCtx): Lines | null => null,
      emitOutbox: (_phys, _aggs, _ctx: EmitCtx): Lines | null => null,
    };
    void _;
  });

  it("StyleAdapter exposes endpoint / handler / DI", () => {
    const _: StyleAdapter = {
      name: "x",
      supportedStrategies: ["stateBased"],
      supportedLayouts: ["byLayer"] as readonly LayoutShape[],
      emitEndpoint: (_op, _ctx: EmitCtx): Lines => [],
      emitHandlerOrService: (_op, _ctx: EmitCtx) => [],
      emitDi: (_ctx: EmitCtx): Lines => [],
    };
    void _;
  });

  it("LayoutAdapter is name + pathFor", () => {
    const _: LayoutAdapter = {
      name: "x",
      pathFor: (artifact, _ctx: EmitCtx): string => artifact.name,
    };
    void _;
  });
});
