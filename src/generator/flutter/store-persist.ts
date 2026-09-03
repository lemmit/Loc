// ---------------------------------------------------------------------------
// Flutter store persistence — the `persist: local|session|url` lifetime ladder
// (frontend-state-management.md §3.1), the Dart sibling of the four JS
// `store-builder.ts` modules and of `feliz/store-persist.ts`.
//
// A Flutter store is the Riverpod triad `<Store>State` / `<Store>Notifier` /
// `<store>Provider` (`store-builder.ts`), so persistence rides the Notifier:
//
//   * `build()`        seeds each persisted cell from its backing store — the
//                      `_load<Field>(…)` helpers below replace the declared
//                      initializers.
//   * `ref.listenSelf` mirrors the WHOLE state back after every transition.
//                      Riverpod has no per-cell hook and the write is
//                      idempotent, so "after every transition" is the honest
//                      equivalent of Zustand's `subscribe`.
//   * `url`            additionally re-reads the query string on browser
//                      back/forward, through a `WidgetsBindingObserver`
//                      (`LoomUrlStoreSync`) that calls each url store's
//                      `hydrateFromUrl()`.
//
// BACKING STORES.  Dart's core SDK has no key/value store and no query-string
// API, so:
//
//   local / session → `shared_preferences` (the one pub package this pulls in),
//                     with `SharedPreferences.setPrefix('')` so the key on web
//                     is the bare `loom.store.<Name>` the JS frontends write —
//                     not the plugin's default `flutter.`-prefixed one.
//   url             → `Uri.base.queryParameters` to read and
//                     `SystemNavigator.routeInformationUpdated` to write (the
//                     portable Flutter route-URL seam; a no-op off the web, so
//                     a native build degrades to the declared defaults rather
//                     than failing).
//
// WIRE COMPATIBILITY.  The key (`loom.store.<Name>`), the `{state, version}`
// ENVELOPE the value is wrapped in (zustand `persist`'s on-disk shape), and the
// decoded state shape (an object keyed by the BARE field name; `money` a JSON
// string — which is also what the Dart cell holds since M-T1.21 — plain
// `decimal` a JSON number) match the React / Vue / Svelte /
// Angular builders — the flat, envelope-less blob this wrote before was the half
// that made the shared key a LIE (each side read the other's value, found none
// of its own fields, fell back to defaults, then overwrote it).  The reader
// still accepts a bare object, so a blob an older Flutter build wrote survives
// the upgrade.  And
// the query-param encoding matches `encodeFieldToParam` in
// `react/store-builder.ts` field-for-field (a string/id param DROPPED when
// empty, a bool set only when true, a number always written — `0` is a real
// value).  One caveat stated in the emitted header too: on web the
// `shared_preferences` backend applies its own value encoding around the string
// it is handed, so `LoomStorePersist.read` accepts BOTH the bare JSON object a
// JS frontend writes and the wrapped form the plugin writes back.
//
// `session` is not `sessionStorage`: there is no per-tab store reachable from
// Dart on every surface.  It is the same `shared_preferences` backing, CLEARED
// at start-up — so the state survives navigation within a run and never
// survives a restart, which is the semantic difference from `local` that
// matters.  Said in the emitted comment as well as here.
// ---------------------------------------------------------------------------

import type { StateFieldIR, StoreIR, UiIR } from "../../ir/types/loom-ir.js";
import {
  type FlutterPersistCodec,
  type FlutterPersistScalar,
  flutterPersistCodec,
} from "../../ir/util/flutter-persist-codec.js";
import { lines } from "../../util/code-builder.js";
import { upperFirst } from "../../util/naming.js";
import { MONEY_WIRE_ZERO } from "../money-scale.js";
import { storeProviderName } from "./store-names.js";

/** A store whose lifetime asks for persistence AND whose fields have a codec —
 *  the emit unit.  A field WITHOUT one is refused at the validator
 *  (`loom.store-lifetime-target-unsupported`, its `#flutter-field` variant), so
 *  by the time codegen runs this filter is a total classification rather than a
 *  silent drop. */
export interface FlutterPersistedStore {
  store: StoreIR;
  /** `"local" | "session"` (shared_preferences) or `"url"` (query string). */
  tier: "local" | "session" | "url";
  fields: { field: StateFieldIR; codec: FlutterPersistCodec }[];
}

/** The ui's stores that carry a non-`memory` lifetime and at least one
 *  persistable field. */
export function flutterPersistedStores(ui: UiIR | undefined): FlutterPersistedStore[] {
  const out: FlutterPersistedStore[] = [];
  for (const store of ui?.stores ?? []) {
    const tier =
      store.lifetime === "persistLocal"
        ? "local"
        : store.lifetime === "persistSession"
          ? "session"
          : store.lifetime === "url"
            ? "url"
            : undefined;
    if (tier === undefined) continue;
    const fields: FlutterPersistedStore["fields"] = [];
    for (const field of store.state) {
      const codec = flutterPersistCodec(field.type);
      if (codec) fields.push({ field, codec });
    }
    if (fields.length > 0) out.push({ store, tier, fields });
  }
  return out;
}

/** True when any persisted store rides `shared_preferences` (local/session) —
 *  the pubspec dependency + the `main()` `await LoomStorePersist.init()` gate. */
export function usesSharedPreferences(stores: readonly FlutterPersistedStore[]): boolean {
  return stores.some((p) => p.tier !== "url");
}

/** True when any persisted store rides the query string — the gate for the
 *  `LoomUrlStoreSync` back/forward observer around `MaterialApp`. */
export function usesUrlStores(stores: readonly FlutterPersistedStore[]): boolean {
  return stores.some((p) => p.tier === "url");
}

/** The `shared_preferences` key — the SAME key the four JS builders write. */
function storageKey(store: StoreIR): string {
  return `loom.store.${store.name}`;
}

/** A Dart single-quoted string literal (field names / keys are identifiers or
 *  dotted identifiers, so no escaping is reachable here). */
function lit(s: string): string {
  return `'${s}'`;
}

// ---------------------------------------------------------------------------
// Per-field conversions.
// ---------------------------------------------------------------------------

/** Read one scalar out of a decoded JSON blob value named `raw` (a `dynamic`
 *  that may be null or junk) — TOTAL, defaulting to `dflt`. */
function fromBlobScalar(scalar: FlutterPersistScalar, raw: string, dflt: string): string {
  switch (scalar) {
    case "int":
      return `${raw} is int ? ${raw} : int.tryParse(${raw}.toString()) ?? ${dflt}`;
    case "double":
      return `${raw} is num ? ${raw}.toDouble() : double.tryParse(${raw}.toString()) ?? ${dflt}`;
    case "money":
      // A JSON STRING both here and in the Dart cell (M-T1.21) — the JS side
      // holds a `Decimal`, whose `toJSON` is a string, and Flutter now holds
      // that same string.  A number in the blob (a hand edit, or an older
      // writer) still reads rather than wiping the cell.
      return `${raw} is String ? ${raw} : ${raw}.toString()`;
    case "bool":
      return `${raw} is bool ? ${raw} : ${raw}.toString() == 'true'`;
    case "datetime":
      return `DateTime.tryParse(${raw}.toString()) ?? ${dflt}`;
    default:
      return `${raw} is String ? ${raw} : ${raw}.toString()`;
  }
}

/** Read one scalar out of a raw query param named `raw` (a non-null `String`) —
 *  TOTAL, defaulting to `dflt`.  The Dart twin of `decodeFieldFromParam`. */
function fromParamScalar(scalar: FlutterPersistScalar, raw: string, dflt: string): string {
  switch (scalar) {
    case "int":
      return `int.tryParse(${raw}) ?? ${dflt}`;
    case "double":
      return `double.tryParse(${raw}) ?? ${dflt}`;
    case "money":
      // The query param IS the money string — no parse, nothing to lose.
      return raw;
    case "bool":
      return `${raw} == 'true'`;
    case "datetime":
      return `DateTime.tryParse(${raw}) ?? ${dflt}`;
    default:
      return raw;
  }
}

/** The JSON value one persisted cell writes into the blob. */
function toBlobScalar(scalar: FlutterPersistScalar, access: string): string {
  switch (scalar) {
    case "money":
      // A JSON STRING — the JS side holds a `Decimal`, whose `toJSON` is one,
      // and the Dart cell already IS that string, so this is identity.
      return access;
    case "datetime":
      return `${access}.toIso8601String()`;
    default:
      // int / double / bool / String are all JSON-native in Dart.
      return access;
  }
}

/** The query-param value one persisted cell writes, or `null` to DROP the param
 *  — the Dart twin of `encodeFieldToParam`. */
function toParamScalar(scalar: FlutterPersistScalar, access: string): string {
  switch (scalar) {
    case "bool":
      // Set only when true (an absent param decodes to false).
      return `${access} ? 'true' : null`;
    case "int":
    case "double":
      // A number always serialises — `0` is a real value, not "empty".
      return `${access}.toString()`;
    case "money":
      // Already the wire string; always written, for the same reason a number
      // is — `'0.0000'` is a real value.
      return access;
    case "datetime":
      return `${access}.toIso8601String()`;
    default:
      // string / id / enum — drop the param when empty so the URL stays clean.
      return `${access}.isEmpty ? null : ${access}`;
  }
}

/** The Dart type one persisted cell holds (the same spelling
 *  `buildStateFields` gives it, re-derived from the codec so this module never
 *  has to be handed the field descriptors). */
function cellType(codec: FlutterPersistCodec): string {
  const scalar = (s: FlutterPersistScalar): string => {
    switch (s) {
      case "int":
        return "int";
      case "double":
        return "double";
      case "money":
        // The wire STRING, not a `double` — `dart-types.ts` (M-T1.21).
        return "String";
      case "bool":
        return "bool";
      case "datetime":
        return "DateTime";
      default:
        return "String";
    }
  };
  return codec.kind === "list" ? `List<${scalar(codec.element)}>` : scalar(codec.scalar);
}

// ---------------------------------------------------------------------------
// Per-store emission — the loaders + the mirror, spliced into the Notifier.
// ---------------------------------------------------------------------------

/** Field name → the `build()` initializer that seeds that cell from its backing
 *  store.  These REPLACE the declared initializers for a persisted cell (an
 *  unpersistable one keeps its own). */
export function persistInitOverrides(p: FlutterPersistedStore): Map<string, string> {
  const out = new Map<string, string>();
  for (const { field } of p.fields) {
    out.set(field.name, `_load${upperFirst(field.name)}(${p.tier === "url" ? "" : "blob"})`);
  }
  return out;
}

/** One persisted cell's `static` loader method. */
function loaderMethod(
  p: FlutterPersistedStore,
  field: StateFieldIR,
  codec: FlutterPersistCodec,
  dflt: string,
): string[] {
  const name = `_load${upperFirst(field.name)}`;
  const type = cellType(codec);
  const key = lit(field.name);

  if (p.tier === "url") {
    if (codec.kind === "list") {
      // Unreachable: `loom.store-url-field-invalid` refuses an array under
      // `url`.  Defaulting keeps the emitter total anyway.
      return [`  static ${type} ${name}() => ${dflt};`];
    }
    return [
      `  static ${type} ${name}() {`,
      `    final raw = LoomStorePersist.param(${key});`,
      `    if (raw == null) return ${dflt};`,
      `    return ${fromParamScalar(codec.scalar, "raw", dflt)};`,
      "  }",
    ];
  }

  if (codec.kind === "list") {
    const el = cellType({ kind: "scalar", scalar: codec.element });
    return [
      `  static ${type} ${name}(Map<String, dynamic> blob) {`,
      `    final raw = blob[${key}];`,
      `    if (raw is! List) return ${dflt};`,
      `    return raw`,
      `        .map<${el}>((e) => ${fromBlobScalar(codec.element, "e", dartElementZero(codec.element))})`,
      "        .toList();",
      "  }",
    ];
  }
  return [
    `  static ${type} ${name}(Map<String, dynamic> blob) {`,
    `    final raw = blob[${key}];`,
    `    if (raw == null) return ${dflt};`,
    `    return ${fromBlobScalar(codec.scalar, "raw", dflt)};`,
    "  }",
  ];
}

/** The persisted-cell fallback when a declared default is unusable.
 *
 *  Two callers.  (1) A LIST ELEMENT: the per-entry fallback when one cell of a
 *  stored array is junk (the array keeps its length).  (2) A cell whose declared
 *  default is the literal `null` — which `dartZeroValue` gives an initless
 *  `datetime`, because a `const` state construction admits no other constant.  A
 *  persisted store's construction is never `const` (its seeds are runtime
 *  calls), so it can hold the real zero rather than a `null` the non-nullable
 *  cell would reject. */
function dartElementZero(scalar: FlutterPersistScalar): string {
  switch (scalar) {
    case "int":
      return "0";
    case "double":
      return "0";
    case "money":
      return `'${MONEY_WIRE_ZERO}'`;
    case "bool":
      return "false";
    case "datetime":
      return "DateTime.fromMillisecondsSinceEpoch(0)";
    default:
      return "''";
  }
}

/** The fallback a persisted cell defaults to — its declared `= init` (so
 *  turning `memory` into `local` never changes the first-run value), unless that
 *  is the un-storable literal `null`. */
function cellDefault(codec: FlutterPersistCodec, declared: string | undefined): string {
  if (declared !== undefined && declared !== "null") return declared;
  return codec.kind === "list" ? "const []" : dartElementZero(codec.scalar);
}

/** The whole persisted-store member block spliced into a `<Store>Notifier`:
 *  the storage key, one `_load<Field>` per cell, the `_persist` mirror, and —
 *  for the `url` tier — the `hydrateFromUrl()` the back/forward observer calls.
 *  `defaults` maps a field name to the Dart expression its declared `= init`
 *  (or the type's zero) renders to, so turning `memory` into `local` never
 *  changes the first-run value. */
export function persistNotifierMembers(
  p: FlutterPersistedStore,
  defaults: ReadonlyMap<string, string>,
  stateClass: string,
): string[] {
  const out: string[] = [];
  if (p.tier !== "url") {
    out.push("", `  static const String _persistKey = ${lit(storageKey(p.store))};`);
  }
  for (const { field, codec } of p.fields) {
    out.push("", ...loaderMethod(p, field, codec, cellDefault(codec, defaults.get(field.name))));
  }

  out.push("", `  void _persist(${stateClass} s) {`);
  if (p.tier === "url") {
    out.push("    LoomStorePersist.writeParams(<String, String?>{");
    for (const { field, codec } of p.fields) {
      const value =
        codec.kind === "list"
          ? "null" // unreachable — `loom.store-url-field-invalid`
          : toParamScalar(codec.scalar, `s.${field.name}`);
      out.push(`      ${lit(field.name)}: ${value},`);
    }
    out.push("    });");
  } else {
    out.push("    LoomStorePersist.write(_persistKey, <String, dynamic>{");
    for (const { field, codec } of p.fields) {
      // A list whose element needs no conversion writes the cell itself — a
      // `.map((e) => e).toList()` identity hop is noise in the emitted Dart.
      const elementJson = codec.kind === "list" ? toBlobScalar(codec.element, "e") : "";
      const value =
        codec.kind !== "list"
          ? toBlobScalar(codec.scalar, `s.${field.name}`)
          : elementJson === "e"
            ? `s.${field.name}`
            : `s.${field.name}.map((e) => ${elementJson}).toList()`;
      out.push(`      ${lit(field.name)}: ${value},`);
    }
    out.push("    });");
  }
  out.push("  }");

  if (p.tier === "url") {
    // `copyWith`, not a full construction: it re-seeds exactly the PERSISTED
    // cells and leaves any other at its current value, so the method stays
    // correct if a store ever mixes persisted and unpersistable fields.
    out.push(
      "",
      "  /// Re-read the query string — the browser back/forward half of the `url`",
      "  /// tier, driven by `LoomUrlStoreSync`.",
      "  void hydrateFromUrl() {",
      "    state = state.copyWith(",
      ...p.fields.map(({ field }) => `      ${field.name}: _load${upperFirst(field.name)}(),`),
      "    );",
      "  }",
    );
  }
  return out;
}

/** The `build()` prologue for a persisted store — the self-listener that
 *  mirrors every transition back, plus the decoded blob the loaders read. */
export function persistBuildPrologue(p: FlutterPersistedStore): string[] {
  const out = [
    "    // Mirror the state back after every transition.  Riverpod has no",
    "    // per-cell hook and the write is idempotent, so this is the honest",
    "    // equivalent of the JS frontends' store `subscribe`.",
    "    ref.listenSelf((_, next) => _persist(next));",
  ];
  if (p.tier !== "url") out.push("    final blob = LoomStorePersist.read(_persistKey);");
  return out;
}

// ---------------------------------------------------------------------------
// `lib/store_persist.dart` — the shared runtime.
// ---------------------------------------------------------------------------

/** The `LoomStorePersist` runtime — the only place the app touches
 *  `shared_preferences` / the route URL.  Emitted only when the ui declares a
 *  persisted store. */
export function renderStorePersistRuntime(stores: readonly FlutterPersistedStore[]): string {
  const web = usesSharedPreferences(stores);
  const url = usesUrlStores(stores);
  const sessionKeys = stores
    .filter((p) => p.tier === "session")
    .map((p) => `    ${lit(storageKey(p.store))},`);

  const imports = ["import 'dart:convert';", ""];
  if (url) imports.push("import 'package:flutter/services.dart';");
  if (web) imports.push("import 'package:shared_preferences/shared_preferences.dart';");

  const body: string[] = ["class LoomStorePersist {"];
  if (web) {
    body.push(
      "  static SharedPreferences? _prefs;",
      "",
      "  /// Session-tier keys, cleared at start-up.  There is no per-tab store",
      "  /// reachable from Dart on every surface, so `persist: session` is the same",
      "  /// backing as `persist: local` WIPED on boot: the state survives navigation",
      "  /// within a run and never survives a restart.",
      "  static const List<String> _sessionKeys = <String>[",
      ...(sessionKeys.length > 0 ? sessionKeys : []),
      "  ];",
      "",
      "  /// Awaited by `main()` before `runApp`, so every Notifier's `build()` can",
      "  /// read synchronously.  The empty prefix makes the web key the bare",
      "  /// `loom.store.<Name>` the JS frontends write, not the plugin's default",
      "  /// `flutter.`-prefixed one.",
      "  static Future<void> init() async {",
      "    SharedPreferences.setPrefix('');",
      "    final prefs = await SharedPreferences.getInstance();",
      "    for (final key in _sessionKeys) {",
      "      await prefs.remove(key);",
      "    }",
      "    _prefs = prefs;",
      "  }",
      "",
      "  /// The stored blob for one store, or an empty map — TOTAL, so a disabled",
      "  /// or corrupted store degrades to the declared defaults instead of",
      "  /// throwing at first build.  Accepts BOTH the bare JSON object and the",
      "  /// string-wrapped form the web `shared_preferences` backend hands back,",
      "  /// and unwraps the `{state, version}` ENVELOPE the JS frontends' zustand",
      "  /// `persist` middleware writes under this very key (a flat blob written",
      "  /// by an older build still reads, so an upgrade keeps its state).",
      "  static Map<String, dynamic> read(String key) {",
      "    final raw = _prefs?.getString(key);",
      "    if (raw == null) return const <String, dynamic>{};",
      "    try {",
      "      dynamic decoded = jsonDecode(raw);",
      "      if (decoded is String) decoded = jsonDecode(decoded);",
      "      if (decoded is Map<String, dynamic> && decoded['state'] is Map<String, dynamic>) {",
      "        decoded = decoded['state'];",
      "      }",
      "      return decoded is Map<String, dynamic> ? decoded : const <String, dynamic>{};",
      "    } catch (_) {",
      "      return const <String, dynamic>{};",
      "    }",
      "  }",
      "",
      "  /// Written in the SAME `{state, version}` envelope zustand's `persist`",
      "  /// writes, so a Flutter-web build and a JS build served from one origin",
      "  /// read each other's blob instead of each silently falling back to",
      "  /// defaults and then overwriting the other.",
      "  static void write(String key, Map<String, dynamic> value) {",
      "    _prefs?.setString(",
      "      key,",
      "      jsonEncode(<String, dynamic>{'state': value, 'version': 0}),",
      "    );",
      "  }",
    );
  }
  if (url) {
    if (web) body.push("");
    body.push(
      "  /// One query param, raw (`null` when absent).  Off the web `Uri.base` is",
      "  /// the executable URI and carries no query, so a native build simply",
      "  /// starts from the declared defaults.",
      "  static String? param(String name) => Uri.base.queryParameters[name];",
      "",
      "  /// Mirror the persisted cells into the query string.  A `null` value DROPS",
      "  /// its param (the JS builders' `p.delete`).  `routeInformationUpdated` is",
      "  /// the portable route-URL seam — a `replaceState` on the web, a no-op",
      "  /// elsewhere.",
      "  static void writeParams(Map<String, String?> params) {",
      "    final next = Map<String, String>.from(Uri.base.queryParameters);",
      "    params.forEach((key, value) {",
      "      if (value == null) {",
      "        next.remove(key);",
      "      } else {",
      "        next[key] = value;",
      "      }",
      "    });",
      "    SystemNavigator.routeInformationUpdated(",
      "      uri: Uri(path: Uri.base.path, queryParameters: next.isEmpty ? null : next),",
      "      replace: true,",
      "    );",
      "  }",
    );
  }
  body.push("}");

  return `${lines(
    "// Store persistence runtime (`persist:` — frontend-state-management.md §3.1).",
    "// The one place the app touches shared_preferences / the route URL; the",
    "// per-store loaders and the write-back mirror live on each `<Store>Notifier`",
    "// in `stores.dart`.  The key (`loom.store.<Name>`), the `{state, version}`",
    "// envelope and the decoded state shape match the React / Vue / Svelte /",
    "// Angular store builders, so the same blob and the same URL round-trip",
    "// across frontends.",
    "// Generated by the Loom Flutter target; do not edit.",
    "",
    ...imports,
    "",
    ...body,
  )}\n`;
}

/** The `LoomUrlStoreSync` observer — re-hydrates every `url` store when the
 *  browser's back/forward buttons change the route.  Lives in `stores.dart`
 *  (it references the store providers), wrapped around `MaterialApp` by
 *  `main.dart`. */
export function renderUrlStoreSync(stores: readonly FlutterPersistedStore[]): string[] {
  const url = stores.filter((p) => p.tier === "url");
  if (url.length === 0) return [];
  return [
    "",
    "/// URL → store: re-decode the query string on browser back/forward (and on a",
    "/// manual address edit).  A `WidgetsBindingObserver` rather than a bare",
    "/// listener, so the hook is removed with the widget.",
    "class LoomUrlStoreSync extends ConsumerStatefulWidget {",
    "  const LoomUrlStoreSync({super.key, required this.child});",
    "",
    "  final Widget child;",
    "",
    "  @override",
    "  ConsumerState<LoomUrlStoreSync> createState() => _LoomUrlStoreSyncState();",
    "}",
    "",
    "class _LoomUrlStoreSyncState extends ConsumerState<LoomUrlStoreSync>",
    "    with WidgetsBindingObserver {",
    "  @override",
    "  void initState() {",
    "    super.initState();",
    "    WidgetsBinding.instance.addObserver(this);",
    "  }",
    "",
    "  @override",
    "  void dispose() {",
    "    WidgetsBinding.instance.removeObserver(this);",
    "    super.dispose();",
    "  }",
    "",
    "  @override",
    "  Future<bool> didPushRouteInformation(RouteInformation routeInformation) async {",
    ...url.map(
      (p) => `    ref.read(${storeProviderName(p.store.name)}.notifier).hydrateFromUrl();`,
    ),
    "    // `false` = not consumed, so the app's own route handling still runs.",
    "    return false;",
    "  }",
    "",
    "  @override",
    "  Widget build(BuildContext context) => widget.child;",
    "}",
  ];
}
