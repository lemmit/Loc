// ---------------------------------------------------------------------------
// Engine registry — the single place that knows which RuntimeEngine
// implementations exist and which is the default.
//
// Today `npm-install-bundle` (real npm tarballs in-browser) is the
// only registered engine.  The seam stays so a future runtime
// (nodepod / WebContainer / …) can register behind a flag for A/B at
// e2e parity — selection is config, never hard-wired at call sites.
// ---------------------------------------------------------------------------

import type {
  RuntimeEngine,
  RuntimeEngineFactory,
  RuntimeEngineOptions,
} from "./runtime-engine.js";

export class EngineRegistry {
  private factories = new Map<string, RuntimeEngineFactory>();
  private defaultId: string | null = null;

  /** Register a factory.  The first registered engine becomes the
   *  default unless `asDefault` is set explicitly later. */
  register(
    id: string,
    factory: RuntimeEngineFactory,
    asDefault = false,
  ): void {
    this.factories.set(id, factory);
    if (asDefault || this.defaultId === null) this.defaultId = id;
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }

  list(): string[] {
    return [...this.factories.keys()];
  }

  /** Instantiate a registered engine by id (or the default when
   *  omitted).  Throws on unknown id so a bad config fails loudly
   *  at startup rather than silently degrading the preview. */
  create(
    id: string | undefined,
    opts?: RuntimeEngineOptions,
  ): RuntimeEngine {
    const key = id ?? this.defaultId;
    if (key === null) {
      throw new Error("EngineRegistry: no engines registered");
    }
    const factory = this.factories.get(key);
    if (!factory) {
      throw new Error(`EngineRegistry: unknown engine "${key}"`);
    }
    return factory(opts);
  }
}

/** Process-wide registry.  P1's engine module self-registers here on
 *  import; `App.tsx` will `create(undefined)` to get the default. */
export const engineRegistry = new EngineRegistry();
