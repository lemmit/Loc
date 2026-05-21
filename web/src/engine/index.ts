// Engine seam barrel.  P0 scaffolding — interfaces + registry only;
// no implementation is wired into the app yet, so importing this has
// no runtime effect.
export type {
  DependencyResolution,
  DependencySpec,
  VendoredPackage,
  DependencySet,
  ResolvedTarball,
  RegistryResolver,
} from "./dependencies.js";
export { emptyDependencySet } from "./dependencies.js";

export type {
  EngineCapabilities,
  PrepareInput,
  PreparedBuild,
  RuntimeDispatcher,
  PreviewMaterial,
  EngineSnapshot,
  RuntimeEngineOptions,
  RuntimeEngine,
  RuntimeEngineFactory,
} from "./runtime-engine.js";
export { NpmInstallBundleEngine } from "./npm-install-bundle-engine.js";

export type { RestorableVfs } from "./vfs.js";

export { EngineRegistry, engineRegistry } from "./registry.js";
export { selectedEngineId } from "./select.js";
