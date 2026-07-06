// Deployable-composition checks: platform validity, design-pack
// compatibility, ui-compose bindings, serves list, per-module
// storage map.

import type { ValidationAcceptor } from "langium";
import type { Platform } from "../../ir/types/loom-ir.js";
import {
  backendPlatformNames,
  backendVersionsForFamily,
  descriptorFor,
  frontendPlatformNames,
  isRegisteredBackendRef,
  parseBuiltinPlatformRef,
} from "../../platform/metadata.js";
import {
  builtinVersionsForFamily,
  packFormatForBuiltin,
  parseBuiltinDesignRef,
} from "../../util/builtin-formats.js";
import type { Deployable, Ui, UiComposeBinding } from "../generated/ast.js";
import {
  builtinPackNamesForFormat,
  expectedFrameworkFor,
  expectedPackFormatFor,
  FRONTEND_KEYWORDS,
  hostableFrameworksFor,
  isReservedStub,
  platformMountsUi,
  platformOwnsBackend,
  type RealizationAxis,
  realizationAxisMenu,
  resolveStyleLayoutCompat,
} from "./data/platform-rules.js";

/** True iff this platform is a frontend-only deployable.  Consults the
 *  `PlatformDescriptor.isFrontend` flag via the client-safe metadata
 *  table.  Returns `false` for unknown / typo'd platforms —
 *  `checkDeployablePlatform` surfaces those as a separate
 *  unknown-platform diagnostic. */
function isFrontendPlatform(platform: string | undefined): boolean {
  if (platform == null) return false;
  try {
    return descriptorFor(platform as Platform).isFrontend;
  } catch {
    return false;
  }
}

export function checkDeployable(
  d: Deployable,
  siblings: Deployable[],
  accept: ValidationAcceptor,
): void {
  // Page-metamodel UI binding rules (3, 4, 4b).
  // Rule 3:  only platforms that mount a UI admit `ui:` — `react`,
  //          `static`, and `elixir` (fullstack Phoenix LiveView).
  // Rule 4:  every `static` deployable must declare `ui:` (otherwise
  //          it has nothing to serve).
  // Rule 4b: every `react` deployable must declare `ui:`.  The
  //          legacy "no ui → fall back to per-aggregate scaffolded
  //          pages" path was removed in favour of the explicit page
  //          metamodel — every React project's pages now flow through
  //          `ui.pages`, which the `scaffold` stdlib macro populates
  //          for the bulk-CRUD case.  Diagnostic code
  //          `loom.react-deployable-missing-ui`.
  checkDeployablePlatform(d, accept);
  checkDeployableRealizationAxes(d, accept);
  // D-PHOENIX-SURFACE: `hosts:` is a UI mount on equal footing with the
  // legacy `ui:` bindings — it satisfies the "must declare a UI" rules
  // (4/4b) and is subject to the same platform-mounts-UI check (3).
  const hasHosts = (d.hosts ?? []).length > 0;
  const hasUiBinding = !!(d.uiSugar || d.uiCompose || d.uiBlock) || hasHosts;
  if (hasUiBinding && !platformMountsUi(d.platform)) {
    accept(
      "error",
      `'ui:'/'hosts:' binding is only valid on platforms that mount a UI ('react', 'svelte', 'vue', 'static', 'elixir', 'dotnet', 'java'); got '${d.platform}'.`,
      {
        node: d,
        property: d.uiSugar
          ? "uiSugar"
          : d.uiCompose
            ? "uiCompose"
            : d.uiBlock
              ? "uiBlock"
              : "hosts",
      },
    );
  }
  if (d.platform === "static" && !hasUiBinding) {
    accept(
      "error",
      `Static deployable '${d.name}' must declare a 'ui:' binding — there is nothing to serve without one.`,
      { node: d, property: "name" },
    );
  }
  // Rule 4b generalises to every frontend SPA platform (`react`,
  // `svelte`, `vue`, `angular`) — a frontend deployable without a `ui:`
  // has no pages to render.  `static` keeps its own wording above.  The
  // diagnostic code stays per-platform
  // (`loom.react-deployable-missing-ui`,
  // `loom.svelte-deployable-missing-ui`,
  // `loom.vue-deployable-missing-ui`,
  // `loom.angular-deployable-missing-ui`) so quick-fixes can dispatch.
  const SPA_FRONTEND_LABELS: Record<string, string> = {
    react: "React",
    svelte: "Svelte",
    vue: "Vue",
    angular: "Angular",
  };
  if (d.platform in SPA_FRONTEND_LABELS && !hasUiBinding) {
    const label = SPA_FRONTEND_LABELS[d.platform];
    accept(
      "error",
      `${label} deployable '${d.name}' must declare a 'ui:' binding — every page now flows through the page metamodel. Add 'ui: <UiName>' (use 'ui <UiName> { with scaffold(subdomains: [...]) }' for the bulk-CRUD case).`,
      { node: d, property: "name", code: `loom.${d.platform}-deployable-missing-ui` },
    );
  }
  // Rule 13: framework values must match the deployable's platform.
  // `react`/`static` mount the `react` framework; `phoenixLiveView`
  // mounts the `phoenixLiveView` framework.  The grammar enum admits
  // both values; this rule rejects cross-pairing
  // (e.g. `platform: react` + `framework: phoenixLiveView`).
  // Membership in the platform's hostable set (D-PHOENIX-SURFACE) —
  // the host serves a framework iff it provides its runtime.  Replaces
  // the old single-expected-value check so a dotnet host can declare
  // `framework: svelte` (any static bundle on a static root) while a
  // LiveView override on a react host still errors.
  const framework = d.uiBlock?.framework;
  if (framework && d.uiBlock) {
    const expected = expectedFrameworkFor(d.platform, hasUiBinding);
    const hostable = hostableFrameworksFor(d.platform);
    const canonical = framework;
    if (canonical && hostable.size > 0 && !hostable.has(canonical)) {
      accept(
        "error",
        `Framework '${framework}' does not match platform '${d.platform}' (expected '${expected ?? [...hostable].sort().join("' | '")}'). Drop the framework override or align it with the platform.`,
        {
          node: d.uiBlock,
          property: "framework",
          code: "loom.framework-mismatch",
          data: { expected },
        },
      );
    }
  }

  // Rule 13b (D-PHOENIX-SURFACE): when the referenced `ui { framework: … }`
  // declaration carries its own framework, the hosting deployable's
  // platform must be able to serve it — `framework ∈ host.hostableFrameworks`.
  // This is the host-capability direction (the `ui` owns its framework,
  // the host declares what it can host) that supersedes Rule 13's
  // derive-from-platform model.  Backward-compatible: only fires when the
  // `ui` declaration opts in by declaring `framework:` (existing sources
  // omit it and are unaffected).  The principled rule means LiveView is
  // rejected on every non-Phoenix host, while React is accepted on any
  // static-asset host.
  // Every `ui` the deployable mounts — the legacy single binding plus
  // each `hosts:` entry (phase 4) — checked uniformly.
  const mountedUis = [
    (d.uiSugar ?? d.uiCompose ?? d.uiBlock)?.ref?.ref,
    ...(d.hosts ?? []).map((r) => r.ref),
  ];
  if (hasUiBinding && platformMountsUi(d.platform)) {
    const hostable = hostableFrameworksFor(d.platform);
    for (const ui of mountedUis) {
      const uiFramework = ui?.framework;
      if (!uiFramework || hostable.has(uiFramework)) continue;
      const menu = [...hostable].sort().join(", ") || "none";
      accept(
        "error",
        `Deployable '${d.name}' (platform '${d.platform}') cannot host ui '${ui?.name}' framework '${uiFramework}'. This platform hosts: ${menu}. A runtime-coupled framework (e.g. 'phoenixLiveView'/LiveView) can only run on its own runtime; a static-bundle framework (e.g. 'react') runs on any static-asset host.`,
        {
          node: d,
          property:
            d.hosts && d.hosts.length > 0
              ? "hosts"
              : d.uiSugar
                ? "uiSugar"
                : d.uiCompose
                  ? "uiCompose"
                  : "uiBlock",
          code: "loom.ui-framework-unhostable",
        },
      );
    }
  }

  // Rule 14: design-pack format must match the framework the deployable
  // renders against.  TSX packs (mantine/shadcn/mui/chakra) need a
  // `react` framework; HEEx packs (coreComponents) need `phoenixLiveView`.
  // Without this rule, a mismatched pair (e.g. `platform: react,
  // design: coreComponents`) lowers cleanly and explodes at generation
  // time with a confusing "template not registered" error.  Custom
  // packs (any name not in BUILTIN_PACK_FORMATS) get a warning
  // instead — the validator can't read their `pack.json` to know the
  // format, but a typo should still surface loudly.
  // The framework the design pack must match: prefer a hosted/referenced
  // `ui` declaration's own `framework:` (D-PHOENIX-SURFACE — the ui owns
  // it; e.g. a phoenix host embedding `framework: react` needs a tsx
  // pack, not coreComponents), then the legacy block-binding framework.
  // Mirrors the lowering precedence in `lower.ts`.
  const uiDeclaredFramework = mountedUis.find((u) => u?.framework)?.framework;
  checkDeployableDesignPack(d, hasUiBinding, uiDeclaredFramework ?? framework, accept);

  // Existing rules — react/static both behave like frontends.
  if (isFrontendPlatform(d.platform)) {
    const target = d.targets?.ref;
    if (!target) {
      accept(
        "error",
        `Frontend deployable '${d.name}' must declare 'targets: <backend-deployable>'.`,
        { node: d, property: "name" },
      );
      return;
    }
    if (isFrontendPlatform(target.platform)) {
      accept(
        "error",
        `Frontend deployable '${d.name}' cannot target another frontend ('${target.name}'). Pick a backend deployable (${backendPlatformNames()
          .map((n) => `'${n}'`)
          .join(", ")}).`,
        { node: d, property: "targets" },
      );
    }
    // `auth: ui` mounts the login redirect + route guard; it needs its
    // target backend to enforce auth (so /auth/me exists and gates).
    if (d.auth === "ui" && target.auth !== "required") {
      accept(
        "error",
        `Frontend deployable '${d.name}' declares 'auth: ui' but its target '${target.name}' is not 'auth: required'; the guard has no session endpoint to probe.`,
        { node: d, property: "auth", code: "loom.auth-ui-target-open" },
      );
    }
    if ((d.contextRefs ?? []).length > 0) {
      accept(
        "warning",
        `Frontend deployable '${d.name}' inherits contexts from its target '${target.name}'; the explicit 'contexts:' list is ignored.`,
        { node: d, property: "contextRefs" },
      );
    }
    void siblings;
  } else {
    if (d.targets) {
      accept(
        "error",
        `'targets:' is only valid on a frontend deployable (${frontendPlatformNames()
          .map((n) => `'${n}'`)
          .join(", ")}).`,
        { node: d, property: "targets" },
      );
    }
    // `auth: ui` is the frontend guard; a backend enforces auth via
    // `auth: required` instead.
    if (d.auth === "ui") {
      accept(
        "error",
        `Deployable '${d.name}' declares 'auth: ui', which is only valid on a frontend deployable; backends use 'auth: required'.`,
        { node: d, property: "auth", code: "loom.auth-ui-on-backend" },
      );
    }
  }

  // Explicit api composition checks.
  checkDeployableServes(d, accept);
  checkDeployableUiCompose(d, accept);
  checkDeployableDataSources(d, accept);
}

/** Validate the `platform:` value now that the grammar admits an
 *  arbitrary STRING (for `family@version` pins).  Mirrors
 *  `checkDeployableDesignPack`'s version error:
 *
 *    - backend bareword (`node`) / frontend keyword
 *      (`react`/`static`) → always fine.
 *    - backend pin (`"node@v4"`) → the version must be a
 *      registered surface, else error listing the available pins.
 *    - anything else (`"frobnicator"`, a typo'd quoted platform)
 *      → unknown-platform error (the grammar enum used to reject
 *      these; the STRING alternative no longer does). */
export function checkDeployablePlatform(d: Deployable, accept: ValidationAcceptor): void {
  const raw = d.platform;
  if (raw == null) return;
  const parsed = parseBuiltinPlatformRef(raw);
  if (parsed == null) {
    // Not a backend family — only the frontend keywords remain
    // valid.  (Bareword `react`/`static` and their quoted forms.)
    if (!FRONTEND_KEYWORDS.has(raw)) {
      accept(
        "error",
        `Unknown platform '${raw}' on deployable '${d.name}'. Valid: 'dotnet', 'node', 'java', 'react', 'svelte', 'vue', 'static', 'elixir', 'python' (backends also accept a pinned form, e.g. 'node@v4').`,
        { node: d, property: "platform" },
      );
    }
    return;
  }
  // Backend.  A pin (`@version` in the source) must resolve to a
  // registered surface; a bareword always resolves (latest).
  const isPinned = raw.includes("@");
  if (isPinned && !isRegisteredBackendRef(parsed.qualified)) {
    const available = backendVersionsForFamily(parsed.family);
    accept(
      "error",
      `Platform '${raw}' on deployable '${d.name}' — no version '${parsed.version}' of backend '${parsed.family}'. Available: ${available.map((v) => `'${parsed.family}@${v}'`).join(", ")}.`,
      { node: d, property: "platform" },
    );
  }
}

/** Resolve a `platform:` value to its canonical family (`node@v4` →
 *  `node`), falling back to the raw value for frontends
 *  (`react`/`static`).  Mirrors how lowering qualifies the platform.
 *  (No alias desugaring — every platform alias was retired.) */
function resolveAxisFamily(platform: string): Platform {
  return (parseBuiltinPlatformRef(platform)?.family ?? platform) as Platform;
}

/** D-REALIZATION-AXES gating.  Ships **R1** (out-of-menu, incl. reserved
 *  stubs) and **R3** (application style ↔ directoryLayout compatibility).
 *  R2/R7 still have no reachable trigger and are deferred (see
 *  `docs/proposals/platform-realization-axes.md` §7). */
export function checkDeployableRealizationAxes(d: Deployable, accept: ValidationAcceptor): void {
  if (d.platform == null) return;
  const family = resolveAxisFamily(d.platform);
  const axes: { name: RealizationAxis; value: string | undefined }[] = [
    { name: "persistence", value: d.persistence },
    { name: "directoryLayout", value: d.directoryLayout },
  ];

  // R1 — every set axis value must be in its platform menu.
  for (const { name, value } of axes) {
    if (value == null) continue;
    const menu = realizationAxisMenu(family, name);
    if (menu.includes(value)) continue;
    const reason = isReservedStub(family, name, value)
      ? `is reserved on platform '${family}' but not yet implemented`
      : `is not available on platform '${family}'`;
    const avail = menu.length
      ? `Available: ${menu.map((v) => `'${v}'`).join(", ")}.`
      : `Platform '${family}' exposes no '${name}:' choices (realization axes apply to backend deployables).`;
    accept("error", `'${name}: ${value}' on deployable '${d.name}' ${reason}. ${avail}`, {
      node: d,
      property: name,
      code: "loom.platform-knob-out-of-menu",
    });
  }

  // R3 — the backend's fixed emission STYLE must support the resolved
  // directoryLayout (StyleAdapter.supportedLayouts).  Uses the platform's
  // default style + the effective layout (explicit knob or platform default);
  // only fires for a REAL layout — an unknown value already errored under R1.
  // Reachable via elixir (`layered`, byFeature-only) + `directoryLayout: byLayer`.
  const styleLayout = resolveStyleLayoutCompat(family, d.directoryLayout ?? undefined);
  if (styleLayout && !styleLayout.ok) {
    accept(
      "error",
      `'directoryLayout: ${styleLayout.layout}' on deployable '${d.name}' is not supported by the '${styleLayout.style}' emission style. Supported: ${styleLayout.supported.map((v) => `'${v}'`).join(", ")}.`,
      {
        node: d,
        property: "directoryLayout",
        code: "loom.platform-knob-style-layout-mismatch",
      },
    );
  }
}

/** Rule 14 — design-pack format must match the deployable's
 *  framework.  Three cases:
 *    1. `design:` set to a built-in name (mantine/shadcn/mui/chakra/
 *       coreComponents) whose format doesn't match the deployable's
 *       framework → error.  Suggests the valid built-ins for the
 *       framework's format so the fix is one rename away.
 *    2. `design:` set to a custom path (anything not in the
 *       built-in map) → warning.  The validator is sync + IO-free,
 *       so it can't read the custom pack's `pack.json` to check the
 *       format; the warning surfaces the unchecked surface so a
 *       typo still gets attention.
 *    3. `design:` set on a deployable with no UI mount and on a
 *       platform that doesn't render UI either → warning that the
 *       value is dropped at lowering and has no effect. */
export function checkDeployableDesignPack(
  d: Deployable,
  hasUiBinding: boolean,
  explicitFramework: string | undefined,
  accept: ValidationAcceptor,
): void {
  if (d.design == null) return;
  // Case 3 — design set on a non-UI deployable.  Lowering in
  // `src/ir/lower/lower.ts` (the `qualifyDesign` call ~line 762)
  // silently drops `design` for non-react/static/phoenixLiveView
  // platforms, so a hono+design or dotnet+design (no `ui:`)
  // combination silently does nothing today.  Warn before the
  // silent drop costs the user a debugging session.
  if (!hasUiBinding && !platformMountsUi(d.platform)) {
    accept(
      "warning",
      `Design pack '${d.design}' set on deployable '${d.name}' (platform '${d.platform}' has no UI mount) — value is ignored at generation.`,
      { node: d, property: "design" },
    );
    return;
  }
  const framework = explicitFramework ?? expectedFrameworkFor(d.platform, hasUiBinding);
  const expectedFormat = expectedPackFormatFor(framework);
  // Parse the slot value into {family, version, qualified}.
  // Bareword (`mantine`) and pinned
  // (`mantine@v7`) forms both produce a parsed ref pointing at a
  // built-in family; custom paths (`./design/foo`) parse to null and
  // fall through to Case 2.  Distinguishing "known family, unknown
  // version" from "custom path" lets us emit a distinctive error
  // listing available versions instead of a generic warning.
  const parsedRef = parseBuiltinDesignRef(d.design);
  if (parsedRef == null) {
    // Case 2 — custom pack path.  Skip the strict check but warn
    // loudly so a misspelt built-in name (or a custom pack that
    // ships the wrong format) doesn't slip through silently.
    accept(
      "warning",
      `Custom design pack '${d.design}' on deployable '${d.name}' — format compatibility with framework '${framework ?? "(none)"}' is not checked at parse time; ensure its pack.json declares format '${expectedFormat ?? "tsx"}'.`,
      { node: d, property: "design" },
    );
    return;
  }
  const actualFormat = packFormatForBuiltin(d.design);
  if (actualFormat == null) {
    // Case 1b — built-in family known but the pinned version isn't
    // registered (e.g. user wrote `design: "mantine@v999"`).  List
    // the available versions so the fix is a one-character edit.
    const available = builtinVersionsForFamily(parsedRef.family);
    accept(
      "error",
      `Design pack '${d.design}' on deployable '${d.name}' — no version '${parsedRef.version}' of pack family '${parsedRef.family}'. Available: ${available.map((v) => `'${parsedRef.family}@${v}'`).join(", ")}.`,
      { node: d, property: "design" },
    );
    return;
  }
  // Case 1a — built-in pack version exists but its format doesn't
  // match the deployable's framework.
  if (expectedFormat && actualFormat !== expectedFormat) {
    accept(
      "error",
      `Design pack '${d.design}' is a ${actualFormat} pack but framework '${framework}' renders ${expectedFormat}. Use one of: ${builtinPackNamesForFormat(expectedFormat)}.`,
      { node: d, property: "design" },
    );
  }
}

/** D-STORAGE-SPLIT: deployable `dataSources:` list validations.
 *    - Every listed dataSource's `for:` context must be in `contexts:`.
 *    - Per (`for:`, `kind:`) uniqueness within one deployable.
 *  Per-aggregate-strategy / kind coverage checks ("state-based
 *  aggregate's context needs `kind: state` listed") live in the
 *  IR-layer validator (`src/ir/validate/validate.ts`) — that pass
 *  sees the resolved aggregate persistenceStrategy. */
export function checkDeployableDataSources(d: Deployable, accept: ValidationAcceptor): void {
  const contextNames = new Set((d.contextRefs ?? []).map((r) => r.ref?.name ?? "").filter(Boolean));
  const seenKey = new Map<string, string>(); // "<ctx>:<kind>" → dataSource name
  for (const r of d.dataSourceRefs ?? []) {
    const ds = r.ref;
    if (!ds) continue;
    const ctxName = ds.context?.ref?.name;
    if (!ctxName) continue;
    if (!contextNames.has(ctxName)) {
      accept(
        "error",
        `Deployable '${d.name}' lists resource '${ds.name}' whose 'for: ${ctxName}' is not in 'contexts:'.  Add ${ctxName} to 'contexts:' or remove the resource.`,
        { node: d, property: "dataSourceRefs" },
      );
      continue;
    }
    const key = `${ctxName}:${ds.kind ?? "<unknown>"}`;
    const prior = seenKey.get(key);
    if (prior) {
      accept(
        "error",
        `Deployable '${d.name}' has two dataSources for (${ctxName}, kind: ${ds.kind}): '${prior}' and '${ds.name}'.  Pick exactly one per (context, kind).`,
        { node: d, property: "dataSourceRefs" },
      );
    } else {
      seenKey.set(key, ds.name);
    }
  }
}

/** `serves:` validations.
 *    - Only valid on platforms that own a backend (dotnet, node,
 *      java, elixir, python).  Frontend-only platforms (react, static)
 *      have no api surface to serve.
 *    - Each api ref must resolve.
 *    - No duplicate api names within one deployable's serves list. */
export function checkDeployableServes(d: Deployable, accept: ValidationAcceptor): void {
  if (!d.serves || d.serves.length === 0) return;
  if (!platformOwnsBackend(d.platform)) {
    accept(
      "error",
      `'serves:' is only valid on a backend deployable (${backendPlatformNames()
        .map((n) => `'${n}'`)
        .join(", ")}).  Got platform '${d.platform}'.`,
      { node: d, property: "serves" },
    );
    return;
  }
  const seen = new Set<string>();
  for (const ref of d.serves) {
    const name = ref?.$refText ?? "";
    if (!ref?.ref) {
      accept(
        "error",
        `Deployable '${d.name}' serves undeclared api '${name}'.  Declare 'api ${name} from <Module>' at system scope.`,
        { node: d, property: "serves" },
      );
      continue;
    }
    if (seen.has(name)) {
      accept(
        "error",
        `Deployable '${d.name}' lists api '${name}' more than once in its 'serves:' list.`,
        { node: d, property: "serves" },
      );
    } else {
      seen.add(name);
    }
  }
}

/** `ui: WebApp { Sales: salesApi, ... }` compose-block
 *  validations.  Each binding maps a UI api parameter (declared as
 *  `api Sales: SalesApi` in the ui block) to a backend deployable
 *  that supplies its contract.  The rule applies to any deployable
 *  that mounts a UI (`platformMountsUi`) — split frontends (react /
 *  static) AND fullstack backends (elixir, fullstack dotnet);
 *  in the fullstack case the deployable can be both source and
 *  target of its own bindings (it serves the api it consumes).
 *    - Each binding's `name` must match a UiApiParam in the ui.
 *    - Each binding's `source` must resolve AND `serves:` the
 *      param's declared api.
 *    - No duplicate param bindings.
 *    - Every UI api param must have a matching binding (no
 *      param left unbound). */
export function checkDeployableUiCompose(d: Deployable, accept: ValidationAcceptor): void {
  // Legacy single-ui mount (`ui:` sugar / `compose` / block) carries its
  // bindings in `d.uiCompose`.
  const legacyUi = d.uiSugar?.ref?.ref ?? d.uiCompose?.ref?.ref ?? d.uiBlock?.ref?.ref;
  if (legacyUi) checkUiApiBindings(d, legacyUi, d.uiCompose, accept);
  // `hosts:`-mounted uis (D-PHOENIX-SURFACE) get the SAME api-binding
  // validation (C7) — previously they escaped it entirely.  A `hosts:` mount
  // carries no compose bindings, so a hosted ui that declares `api X: <Api>`
  // params has nothing to fill them and is told to switch to the `ui: X {…}`
  // compose form; a hosted ui with no api params validates clean.
  for (const r of d.hosts ?? []) {
    const ui = r.ref;
    if (ui) checkUiApiBindings(d, ui, undefined, accept);
  }
}

function checkUiApiBindings(
  d: Deployable,
  ui: Ui,
  compose: UiComposeBinding | undefined,
  accept: ValidationAcceptor,
): void {
  // Collect declared UI api params (param name → required api name).
  const requiredParams = new Map<string, string>();
  for (const m of ui.members) {
    if (m.$type !== "UiApiParam") continue;
    const apiName = m.apiRef?.$refText ?? "";
    if (apiName) requiredParams.set(m.name, apiName);
  }

  if (requiredParams.size === 0) {
    // UI has no api params — extra ui-compose bindings are pointless.
    const bindings = compose?.bindings ?? [];
    for (const b of bindings) {
      accept(
        "error",
        `Deployable '${d.name}' binds parameter '${b.name}' on ui '${ui.name}' but the ui declares no 'api ${b.name}: <Api>' parameter.`,
        { node: b, property: "name" },
      );
    }
    return;
  }

  // UI has api params → must use the compose-block form.
  if (!compose) {
    const paramList = [...requiredParams.entries()]
      .map(([n, a]) => `${n}: <backend serving ${a}>`)
      .join(", ");
    accept(
      "error",
      `Deployable '${d.name}' deploys ui '${ui.name}' which declares api parameters; supply bindings via 'ui: ${ui.name} { ${paramList} }'.`,
      { node: d, property: "name" },
    );
    return;
  }

  const bindings = compose.bindings ?? [];
  const seenNames = new Set<string>();
  const boundNames = new Set<string>();
  for (const b of bindings) {
    const paramName = b.name;
    const sourceName = b.source?.$refText ?? "";
    if (seenNames.has(paramName)) {
      accept("error", `Deployable '${d.name}' binds ui parameter '${paramName}' more than once.`, {
        node: b,
        property: "name",
      });
      continue;
    }
    seenNames.add(paramName);

    const requiredApi = requiredParams.get(paramName);
    if (!requiredApi) {
      accept(
        "error",
        `Deployable '${d.name}' binds parameter '${paramName}' on ui '${ui.name}' but the ui declares no 'api ${paramName}: <Api>' parameter.`,
        { node: b, property: "name" },
      );
      continue;
    }
    boundNames.add(paramName);

    if (!b.source?.ref) {
      accept(
        "error",
        `Deployable '${d.name}' references undeclared source deployable '${sourceName}' in 'ui: ${ui.name} { ${paramName}: ${sourceName} }'.`,
        { node: b, property: "source" },
      );
      continue;
    }
    const source = b.source.ref;
    const sourceServes = (source.serves ?? []).some((r) => r?.$refText === requiredApi);
    if (!sourceServes) {
      accept(
        "error",
        `Deployable '${sourceName}' does not 'serves: ${requiredApi}' — required to fill ui parameter '${paramName}: ${requiredApi}' on '${ui.name}'.`,
        { node: b, property: "source" },
      );
    }
  }

  // Every UI api param must be bound.
  for (const [name, apiName] of requiredParams) {
    if (!boundNames.has(name)) {
      accept(
        "error",
        `Deployable '${d.name}' is missing a binding for ui parameter '${name}: ${apiName}' on ui '${ui.name}'.`,
        { node: d, property: "name" },
      );
    }
  }
}
