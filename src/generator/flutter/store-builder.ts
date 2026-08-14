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
function renderStore(store: StoreIR, contexts: readonly EnrichedBoundedContextIR[]): string[] {
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
  const buildReturn =
    fields.length > 0
      ? `${constEligible ? "const " : ""}${stateClass}(${entries.join(", ")})`
      : `const ${stateClass}()`;

  // The lifetime ladder (frontend-state-management.md §3.1) is NOT ported: Dart
  // has no `localStorage`/query-string equivalent in the core SDK, so
  // `persist: local|session|url` would need `shared_preferences` + a router
  // rewrite.  Downgrading to memory silently is the failure mode this whole
  // pass exists to remove, so the divergence rides in the emitted source where
  // a reader (and a grep) will find it.
  const lifetimeNote =
    store.lifetime === "memory"
      ? []
      : [
          `// TODO(flutter full-parity): \`persist: ${store.lifetime}\` is not implemented —`,
          "// this store is IN-MEMORY (state is lost on restart / not shareable by URL).",
        ];
  const out: string[] = [
    ...lifetimeNote,
    ...renderStateDataClass(stateClass, fields),
    "",
    `class ${notifierClass} extends Notifier<${stateClass}> {`,
    "  @override",
    `  ${stateClass} build() {`,
    `    return ${buildReturn};`,
    "  }",
  ];
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
): string | undefined {
  if (stores.length === 0) return undefined;
  const header = [
    "// Riverpod store modules — one `<Store>State` / `<Store>Notifier` /",
    "// `<store>Provider` per `store <Name> { … }`.  Generated by the Loom Flutter",
    "// target; do not edit.",
    "",
    "import 'package:flutter_riverpod/flutter_riverpod.dart';",
  ];
  if (needsModels(stores)) header.push("", "import 'models.dart';");
  const bodies = stores.map((s) => renderStore(s, contexts).join("\n"));
  return `${[...header, "", bodies.join("\n\n")].join("\n")}\n`;
}
