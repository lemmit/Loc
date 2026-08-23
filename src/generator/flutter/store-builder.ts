// Flutter store modules — the `store Cart { state {…} action …}` half of
// named-actions-and-stores.md §3 (Stage 5), emitted as one `lib/stores.dart`.
//
// A store is structurally a PAGE's `state {}` + `action`s with no route, no
// reads and no derived bindings, so it projects onto exactly the Riverpod triad
// `riverpod-emit.ts` already builds for a stateful page — `<Store>State`
// (immutable data class + `copyWith`), `<Store>Notifier extends
// Notifier<<Store>State>`, and a `<store>Provider`.  The helpers are shared with
// that module rather than re-derived, so a store cell and a page cell can never
// disagree about how a Dart field / setter / `copyWith` is spelled.
//
// The `persist: local|session|url` lifetime ladder rides that same triad —
// `build()` seeds each cell from its backing store and a `ref.listenSelf` mirror
// writes the whole state back — and lives next door in `store-persist.ts`.
//
// The USE side lives in `flutter-target.ts` (`renderStoreFieldRead` /
// `renderStoreActionCall`) and `index.ts` (the page shell binds one local per
// used member).  Components stay excluded: a `StatelessWidget`/`StatefulWidget`
// has no `WidgetRef`, so a component body that touches a store is dropped from
// the emittable set (`component-emit.ts`) instead of emitting an unbound name.

import type { EnrichedBoundedContextIR, StoreIR } from "../../ir/types/loom-ir.js";
import { upperFirst } from "../../util/naming.js";
import { dartType } from "./dart-types.js";
import {
  buildStateFields,
  buildStateInits,
  renderNotifierStmt,
  renderStateDataClass,
  stateCtx,
  stateSetterMethods,
} from "./riverpod-emit.js";
import { storeProviderName } from "./store-names.js";
import {
  type FlutterPersistedStore,
  persistBuildPrologue,
  persistInitOverrides,
  persistNotifierMembers,
  renderUrlStoreSync,
} from "./store-persist.js";

/** The state data class for a store (`Cart` → `CartState`). */
function storeStateClass(storeName: string): string {
  return `${upperFirst(storeName)}State`;
}

/** The notifier class for a store (`Cart` → `CartNotifier`). */
function storeNotifierClass(storeName: string): string {
  return `${upperFirst(storeName)}Notifier`;
}

/** True when any store field is a domain (wire-model) type, so `stores.dart`
 *  must import `models.dart`.  Same primitive set the component emitter uses. */
function needsModels(stores: readonly StoreIR[]): boolean {
  const prim = new Set(["String", "int", "double", "bool", "DateTime"]);
  return stores.some((s) =>
    s.state.some((f) => {
      const dt = dartType(f.type).replace(/\?$/, "");
      return !prim.has(dt) && !dt.startsWith("List<") && dt !== "dynamic";
    }),
  );
}

/** Project one store into its `<Store>State` / `<Store>Notifier` / `<store>Provider`
 *  Dart source lines. */
function renderStore(
  store: StoreIR,
  contexts: readonly EnrichedBoundedContextIR[],
  persisted: FlutterPersistedStore | undefined,
): string[] {
  const stateClass = storeStateClass(store.name);
  const notifierClass = storeNotifierClass(store.name);
  const aggregatesByName = new Map(
    contexts.flatMap((c) => c.aggregates.map((a) => [a.name, a] as const)),
  );
  const stateNames = new Set(store.state.map((s) => s.name));
  const fields = buildStateFields(store.state);

  const initCtx = stateCtx({
    stateNames,
    derivedNames: new Set(),
    aggregatesByName,
    locals: new Map(),
  });
  const { entries, constEligible } = buildStateInits(fields, initCtx);
  // The lifetime ladder (frontend-state-management.md §3.1): a persisted cell's
  // declared initializer becomes its FALLBACK and the seed comes from the
  // backing store instead (`store-persist.ts`), so turning `memory` into `local`
  // never changes the first-run value.  A `const` construction is off the table
  // once any seed is a runtime call.
  const overrides = persisted ? persistInitOverrides(persisted) : new Map<string, string>();
  // `buildStateInits` builds each entry as exactly `<name>: <expr>`, so the
  // declared-default EXPRESSION is the tail past the known-length prefix (never
  // a `split(": ")`, which a map/record literal in the initializer would break).
  const defaults = new Map(fields.map((f, i) => [f.name, entries[i]!.slice(f.name.length + 2)]));
  const seeded = fields.map((f, i) =>
    overrides.has(f.name) ? `${f.name}: ${overrides.get(f.name)}` : entries[i]!,
  );
  const isConst = constEligible && overrides.size === 0;
  const buildReturn =
    fields.length > 0
      ? `${isConst ? "const " : ""}${stateClass}(${seeded.join(", ")})`
      : `const ${stateClass}()`;

  const out: string[] = [
    ...renderStateDataClass(stateClass, fields),
    "",
    `class ${notifierClass} extends Notifier<${stateClass}> {`,
    "  @override",
    `  ${stateClass} build() {`,
    ...(persisted ? persistBuildPrologue(persisted) : []),
    `    return ${buildReturn};`,
    "  }",
  ];
  if (persisted) out.push(...persistNotifierMembers(persisted, defaults, stateClass));
  for (const action of store.actions) {
    const param = action.params[0];
    const locals = new Map<string, string>();
    if (param) locals.set(param.name, param.name);
    const ctx = stateCtx({ stateNames, derivedNames: new Set(), aggregatesByName, locals });
    // `selfStore` keeps a same-store action call a plain in-class invocation: a
    // provider that reads its OWN notifier is what Riverpod reports as a
    // circular dependency, and the method is right here anyway.
    const body = action.body.map((s) => renderNotifierStmt(s, ctx, store.name));
    const sig = param ? `${dartType(param.type)} ${param.name}` : "";
    out.push("", `  void ${action.name}(${sig}) {`);
    for (const b of body) out.push(`    ${b}`);
    out.push("  }");
  }
  // Per-cell setters, exactly as a page Notifier carries them — a store field is
  // as bindable from a controlled input as a page field is.
  out.push(
    ...stateSetterMethods(
      fields,
      (assign) => [`    ${assign}`],
      new Set(store.actions.map((a) => a.name)),
    ),
  );
  out.push("}");
  out.push("");
  out.push(
    `final ${storeProviderName(store.name)} = ` +
      `NotifierProvider<${notifierClass}, ${stateClass}>(${notifierClass}.new);`,
  );
  return out;
}

/** The whole `lib/stores.dart` file for a ui's stores, or undefined when it
 *  declares none (no empty file, no unused import). */
export function renderFlutterStores(
  stores: readonly StoreIR[],
  contexts: readonly EnrichedBoundedContextIR[],
  /** The `persist:` classification for this ui's stores (`store-persist.ts`) —
   *  empty when every store is `memory`, which keeps the emitted file
   *  byte-identical to the pre-persistence output. */
  persisted: readonly FlutterPersistedStore[] = [],
): string | undefined {
  if (stores.length === 0) return undefined;
  const byName = new Map(persisted.map((p) => [p.store.name, p]));
  const urlSync = renderUrlStoreSync(persisted);
  const header = [
    "// Riverpod store modules — one `<Store>State` / `<Store>Notifier` /",
    "// `<store>Provider` per `store <Name> { … }`.  Generated by the Loom Flutter",
    "// target; do not edit.",
    "",
    // `LoomUrlStoreSync` is a widget (`WidgetsBindingObserver`/`RouteInformation`),
    // so the url tier — and only it — pulls the Material/widgets library in.
    ...(urlSync.length > 0 ? ["import 'package:flutter/material.dart';"] : []),
    "import 'package:flutter_riverpod/flutter_riverpod.dart';",
  ];
  if (persisted.length > 0) header.push("", "import 'store_persist.dart';");
  if (needsModels(stores)) header.push("", "import 'models.dart';");
  const bodies = stores.map((s) => renderStore(s, contexts, byName.get(s.name)).join("\n"));
  return `${[...header, "", bodies.join("\n\n"), ...urlSync].join("\n")}\n`;
}
