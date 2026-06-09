import type { Deployable, Ui } from "../../language/generated/ast.js";
import { platformFor } from "../../platform/registry.js";
import { defaultsFor } from "../../platform/resolve-adapters.js";
import { applicationDslToAdapter } from "../../util/platform-axes.js";
import type { DeployableIR, Platform, UiParamBindingIR } from "../types/loom-ir.js";
import {
  canonicalFramework,
  foundationAdapterOverride,
  greenfieldAxisDefaults,
  qualifyDesign,
  qualifyPlatform,
} from "./lower-platform.js";

export function lowerDeployable(d: Deployable): DeployableIR {
  const { family: platform, ref: platformRef } = qualifyPlatform(d.platform);
  // `auth: required` is currently the only AuthMode.  Future modes
  // (`optional` / `forbidden`) would extend this branch.
  const auth = d.auth === "required" ? { required: true } : undefined;
  // `design` defaults only on platforms that actually render UI in
  // this deployable — keeping the IR honest about which deployables
  // mount a frontend.  `react`/`static` always render React (TSX
  // packs).  `phoenixLiveView` is fullstack and always renders HEEx
  // against the `ashPhoenix` pack.  `dotnet` is dual-mode: it renders
  // an embedded React SPA when (and only when) the deployable declares
  // `ui:`; backend-only dotnet drops the field.  Other platforms
  // (`hono`) silently drop `design:` and the validator already warns.
  // D-PHOENIX-SURFACE: `hosts:` declarations the deployable serves.
  // Resolve the first hosted `Ui` node so `uiName`/`uiFramework` can
  // fall back to it (and read its own declared framework) when the
  // legacy `ui:` binding is absent.
  const hostedUis = (d.hosts ?? []).map((r) => r.ref).filter((u): u is Ui => !!u);
  const hostedUiNames = hostedUis.map((u) => u.name);
  const firstHostedUi = hostedUis[0];
  const uiName =
    d.uiSugar?.ref?.ref?.name ??
    d.uiCompose?.ref?.ref?.name ??
    d.uiBlock?.ref?.ref?.name ??
    firstHostedUi?.name ??
    undefined;
  // Page-metamodel UI binding.  The grammar accepts two
  // surface forms — `ui: WebApp` (sugar) and `ui WebApp { framework: react }`
  // (full block).  Both lower to the same `uiName` + optional
  // `uiFramework` here.  `uiName` is computed above so the `design`
  // default can branch on it for dual-mode platforms (fullstack
  // dotnet).  Validator enforces that the referenced ui
  // exists, the platform supports a UI mount, and the framework value
  // is one of the v0-allowed alternatives.
  // Explicit `framework: …` in the full block wins; otherwise default
  // from the platform.  Fullstack dotnet renders React; phoenixLiveView
  // renders LiveView; react/static render React.  Backends without a
  // `ui:` binding leave this undefined.
  // Precedence: explicit `framework:` on the legacy block binding, then
  // the framework declared on the `hosts:`-ed `ui` itself (D-PHOENIX-SURFACE
  // phase 2 — the ui owns its framework), then the legacy platform-derived
  // default.  Computed before `design` so the pack default can branch on
  // it (a phoenix host embedding react needs a tsx pack, not ashPhoenix).
  const uiFramework =
    canonicalFramework(d.uiBlock?.framework) ??
    canonicalFramework(firstHostedUi?.framework) ??
    (uiName
      ? platform === "elixir"
        ? "phoenixLiveView"
        : platformFor(platform).isFrontend || platform === "dotnet"
          ? "react"
          : undefined
      : undefined);
  // Design pack default depends on what actually renders:
  //  - frontend platforms + fullstack-dotnet render React → `mantine`;
  //  - phoenixLiveView renders HEEx → `ashPhoenix`, UNLESS it embeds a
  //    `framework: react` ui (D-PHOENIX-SURFACE), in which case the SPA
  //    needs a tsx pack → `mantine`;
  //  - backends without a `ui:` mount carry no design.
  const design = platformFor(platform).isFrontend
    ? qualifyDesign(d.design, "mantine")
    : platform === "elixir"
      ? qualifyDesign(d.design, uiFramework === "react" ? "mantine" : "ashPhoenix")
      : platform === "dotnet" && uiName
        ? qualifyDesign(d.design, "mantine")
        : undefined;
  // Explicit api composition.
  const serves = (d.serves ?? []).map((r) => r.ref?.name ?? "").filter(Boolean);
  const uiBindings = (d.uiCompose?.bindings ?? []).map(
    (b): UiParamBindingIR => ({
      paramName: b.name,
      sourceDeployableName: b.source?.ref?.name ?? "",
    }),
  );
  // D-STORAGE-SPLIT: `contexts:` clause references bounded contexts
  // directly; `dataSources:` clause references the (context, kind)
  // bindings the deployable hosts.
  const contextNames = (d.contextRefs ?? []).map((r) => r.ref?.name ?? "").filter(Boolean);
  const dataSourceNames = (d.dataSourceRefs ?? []).map((r) => r.ref?.name ?? "").filter(Boolean);
  // D-REALIZATION-AXES: normalize the six axes.  Backends fill every axis
  // with a concrete value (an absent knob → the platform default);
  // frontends (`react`/`static`) carry none — `defaultsFor` is undefined
  // for them, the validator rejects any axis written on a frontend.  The
  // three adapter-backed axes source their default from the live adapter
  // menu (`adapterDefaults`); the three greenfield axes from the table
  // above.  `application`↔adapter `style`, `directoryLayout`↔`layout`.
  const adapterDefaults = defaultsFor(platform);
  const axes =
    adapterDefaults !== undefined
      ? (() => {
          const gf = greenfieldAxisDefaults(platform);
          // The foundation selects which adapter-axis defaults apply: the
          // platform `adapterDefaults` describe its DEFAULT foundation (elixir
          // → ash), so a non-default foundation (`vanilla`) overrides the
          // omitted-knob default for the axes it implies (D-REALIZATION-AXES;
          // realization-axes-alignment.md).
          const foundation = d.foundation ?? gf.foundation;
          const fdn = foundationAdapterOverride(platform, foundation);
          return {
            foundation,
            // Store the resolved adapter key (`serviceLayer` → `layered`)
            // so the future codegen passes it straight to `resolveStyle`.
            application: d.application
              ? applicationDslToAdapter(d.application)
              : (fdn.style ?? adapterDefaults.style),
            persistence: d.persistence ?? fdn.persistence ?? adapterDefaults.persistence.state,
            directoryLayout: d.directoryLayout ?? adapterDefaults.layout,
            transport: d.transport ?? adapterDefaults.transport,
            runtime: d.runtime ?? gf.runtime,
          };
        })()
      : {
          foundation: undefined,
          application: undefined,
          persistence: undefined,
          directoryLayout: undefined,
          transport: undefined,
          runtime: undefined,
        };
  return {
    name: d.name,
    platform,
    platformRef,
    contextNames,
    dataSourceNames,
    port: d.port ?? defaultPortFor(platform),
    targetName: d.targets?.ref?.name,
    auth,
    design,
    foundation: axes.foundation,
    application: axes.application,
    persistence: axes.persistence,
    directoryLayout: axes.directoryLayout,
    transport: axes.transport,
    runtime: axes.runtime,
    uiName,
    uiFramework,
    hostedUiNames,
    serves,
    uiBindings,
    favicon: d.favicon,
  };
}

/** Look up a platform's default deployable port via `PlatformSurface.defaultPort`.
 *  Falls back to 3000 for an unknown / undefined platform (lowering may
 *  still be running before validation surfaces the bad value). */
function defaultPortFor(platform: Platform | undefined): number {
  if (!platform) return 3000;
  try {
    return platformFor(platform).defaultPort;
  } catch {
    return 3000;
  }
}
