import type { Deployable, Ui } from "../../language/generated/ast.js";
import { defaultsFor } from "../../platform/adapter-metadata.js";
import { descriptorFor } from "../../platform/metadata.js";
import type { DeployableIR, Platform, UiParamBindingIR } from "../types/loom-ir.js";
import { qualifyDesign, qualifyPlatform } from "./lower-platform.js";

export function lowerDeployable(d: Deployable): DeployableIR {
  const { family: platform, ref: platformRef } = qualifyPlatform(d.platform);
  // `auth: required` opts a backend into token middleware; `auth: ui`
  // mounts the login redirect + guard on a frontend under the system
  // `auth { ... }` block.  Future modes (`optional` / `forbidden`)
  // would extend this branch.
  const auth =
    d.auth === "required"
      ? { required: true, ui: false }
      : d.auth === "ui"
        ? { required: false, ui: true }
        : undefined;
  // `design` defaults only on platforms that actually render UI in
  // this deployable — keeping the IR honest about which deployables
  // mount a frontend.  `react`/`static` always render React (TSX
  // packs).  `phoenixLiveView` is fullstack and always renders HEEx
  // against the `coreComponents` pack.  `dotnet` is dual-mode: it renders
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
    d.uiSugar?.ref?.ref?.name ?? d.uiCompose?.ref?.ref?.name ?? firstHostedUi?.name ?? undefined;
  // Page-metamodel UI binding.  The grammar accepts two surface forms —
  // `ui: WebApp` (sugar) and `ui: WebApp { Sales: salesApi }` (compose).
  // Both lower to the same `uiName` + optional `uiFramework` here.
  // `uiName` is computed above so the `design` default can branch on it
  // for dual-mode platforms (fullstack dotnet).  Validator enforces that
  // the referenced ui exists, the platform supports a UI mount, and the
  // framework value is one of the v0-allowed alternatives.
  // Precedence: the framework declared on the bound `ui` itself — whether
  // bound via `ui:` sugar / `compose` or via `hosts:` (D-PHOENIX-SURFACE
  // phase 2 — the ui owns its framework) — then the legacy platform-derived
  // default.  The bound-ui hop matters: the validator's rules 13b/14 read
  // the ui's declared framework through every binding spelling, so lowering
  // must agree or a validation-clean `ui X { framework: svelte }` + `ui: X`
  // would silently lower as the platform default.  Computed before `design`
  // so the pack default can branch on it (a phoenix host embedding react
  // needs a tsx pack, not coreComponents).
  const boundUi = d.uiSugar?.ref?.ref ?? d.uiCompose?.ref?.ref;
  const uiFramework =
    boundUi?.framework ??
    firstHostedUi?.framework ??
    (uiName
      ? platform === "elixir"
        ? "phoenixLiveView"
        : platform === "svelte"
          ? "svelte"
          : platform === "vue"
            ? "vue"
            : platform === "angular"
              ? "angular"
              : descriptorFor(platform).isFrontend || platform === "dotnet" || platform === "java"
                ? "react"
                : undefined
      : undefined);
  // Design pack default depends on what actually RENDERS — the ui's
  // `framework:`, not the host platform keyword.  A static-asset host serves
  // any static bundle (`STATIC_BUNDLE_FRAMEWORKS`), so a `platform: react` host
  // of a `framework: svelte` ui must default to a svelte pack, not mantine —
  // otherwise the svelte generator resolves a react pack and crashes.  This
  // mirrors the elixir / dotnet-java branches below, which already key on
  // `uiFramework`:
  //  - react/static render React → `mantine`;
  //  - svelte render Svelte → `shadcnSvelte`;
  //  - vue render Vue → `vuetify`;
  //  - angular render Angular → `angularMaterial`;
  //  - phoenixLiveView renders HEEx → `coreComponents`, UNLESS it embeds a
  //    `framework: react` ui (D-PHOENIX-SURFACE), in which case the SPA
  //    needs a tsx pack → `mantine`;
  //  - backends without a `ui:` mount carry no design.
  const design = descriptorFor(platform).isFrontend
    ? qualifyDesign(
        d.design,
        uiFramework === "svelte"
          ? "shadcnSvelte"
          : uiFramework === "vue"
            ? "vuetify"
            : uiFramework === "angular"
              ? "angularMaterial"
              : "mantine",
      )
    : platform === "elixir"
      ? qualifyDesign(
          d.design,
          uiFramework === "react"
            ? "mantine"
            : uiFramework === "vue"
              ? "vuetify"
              : uiFramework === "svelte"
                ? "shadcnSvelte"
                : uiFramework === "angular"
                  ? "angularMaterial"
                  : "coreComponents",
        )
      : (platform === "dotnet" || platform === "java") && uiName
        ? qualifyDesign(
            d.design,
            uiFramework === "svelte"
              ? "shadcnSvelte"
              : uiFramework === "vue"
                ? "vuetify"
                : uiFramework === "angular"
                  ? "angularMaterial"
                  : "mantine",
          )
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
  const channelSourceNames = (d.channelRefs ?? []).map((r) => r.ref?.name ?? "").filter(Boolean);
  // D-REALIZATION-AXES: normalize the three realization axes.  Backends fill
  // every axis with a concrete value (an absent knob → the platform default);
  // frontends (`react`/`static`) carry none — `defaultsFor` is undefined for
  // them, the validator rejects any axis written on a frontend.  Each sources
  // its default from the live adapter menu (`adapterDefaults`).
  // `application`↔adapter `style`, `directoryLayout`↔`layout`.
  const adapterDefaults = defaultsFor(platform);
  const axes =
    adapterDefaults !== undefined
      ? {
          persistence: d.persistence ?? adapterDefaults.persistence.state,
          directoryLayout: d.directoryLayout ?? adapterDefaults.layout,
        }
      : {
          persistence: undefined,
          directoryLayout: undefined,
        };
  return {
    name: d.name,
    platform,
    platformRef,
    contextNames,
    dataSourceNames,
    channelSourceNames,
    port: d.port ?? defaultPortFor(platform),
    targetName: d.targets?.ref?.name,
    auth,
    design,
    persistence: axes.persistence,
    directoryLayout: axes.directoryLayout,
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
    return descriptorFor(platform).defaultPort;
  } catch {
    return 3000;
  }
}
