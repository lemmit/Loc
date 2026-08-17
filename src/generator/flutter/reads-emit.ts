// Riverpod READ-provider projector — the Flutter analogue of Feliz's
// `wire.ts` read collection (`collectPageReads`) + api-module emission.
//
// The view seam (`flutter-target.ts`) names the read a page issues
// (`ref.watch(<var>Provider)` yielding an `AsyncValue<…>`) and dispatches on it
// via the QueryView pack's `.when`.  This module emits the PROVIDER that
// binding resolves to: one Riverpod `FutureProvider` per distinct
// `QueryView { of: … }` read a ui's pages issue —
//
//   - a LIST read (`<handle>.<Agg>.all`) → `FutureProvider<List<Agg>>` that
//     GETs `${apiBase}/<plural>`, pulls `items` out of the paged envelope, and
//     maps each element through `Agg.fromJson` (Track A models).
//   - a byId read (`<handle>.<Agg>.byId(id)`) → `FutureProvider.family<Agg?,
//     String>` that GETs `${apiBase}/<plural>/$id` (404 → `null`).
//
// Fetch is over `package:http`; the API base URL comes from `AppConfig`
// (`lib/config.dart` — a compile-time `String.fromEnvironment('API_BASE_URL')`
// matching how `platform/flutter.ts` `composeService` injects it, defaulting to
// the same-origin `/api` proxy prefix).  Detection reuses the shared
// `tryDetectApiHook`, so the reads collected here name the same aggregates +
// vars the walker's `buildHookUse` seam resolves through — the page's hoisted
// `ref.watch(<var>Provider)` and the emitted `<var>Provider` always agree.

import type { EnrichedBoundedContextIR, ExprIR, UiIR } from "../../ir/types/loom-ir.js";
import { groupedProjectionNames, readableProjectionNames } from "../../ir/util/projection-read.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import { tryDetectApiHook } from "../_walker/api-hook-detector.js";
import { isOfReadCall } from "../_walker/of-reads.js";
import { bcByAggregateOf, isPagedQuery } from "../_walker/paged-query.js";
import { dartType } from "./dart-types.js";

/** One distinct read a ui issues, projected to everything the provider emitter
 *  needs.  Deduped by `varName` across every page of the ui. */
export interface FlutterRead {
  /** Provider-local var the page hoists + the body reads (`productAll`). */
  varName: string;
  /** Aggregate PascalCase model class (`Product`) — the `fromJson` target. */
  aggregate: string;
  /** True for a byId (single-record) read → a `.family<T?, String>` provider. */
  single: boolean;
  /** Collection route path RELATIVE to the api base (`/products`); a byId read
   *  appends `/$id`. */
  routePath: string;
  /** True when the backend's find returns the `Paged<T>` envelope (the
   *  paged-by-default auto-`findAll`, M-T2.6).  Such a read becomes a `.family`
   *  keyed by the query record, returns a `LoomPage<T>` (items + totalPages),
   *  and is what makes a SERVER-DRIVEN `Table` possible: a sort or page tap
   *  writes page state, the family key changes, and Riverpod refetches. */
  paged: boolean;
  /** A PARAMETERIZED repository find (`find named(n: string): Product[]`) — the
   *  declared params, in order, with the Dart type each lowers to.
   *
   *  Present only for a named find; `.all` / `.byId` leave it undefined and
   *  emit exactly as before.  The provider becomes a `.family` keyed by a Dart
   *  RECORD of these params, which is what the page walker already calls
   *  (`ref.watch(productNamedProvider((n: 'x')))`) — before this, the walker
   *  emitted that call and the import for a provider the collector never
   *  produced, so the generated project had a dangling `import '../reads.dart'`
   *  and would not pass `flutter analyze`. */
  params?: ReadonlyArray<{ name: string; dartType: string }>;
  /** A query-time PROJECTION read (M-T1.3 Phase 1) rather than an aggregate
   *  read.  Deliberately its own flag rather than a reuse of `single`: a
   *  SINGLETON projection is single-SHAPED (one object, no envelope) yet
   *  paramless, while `single` here means "a byId `.family` keyed by a route
   *  id" — a projection has no id to key by.  `aggregate` carries the
   *  `<Proj>Row` class name, so the `fromJson` call site needs no new branch.
   *
   *  A GROUPED (`group by`) projection is the LIST shape — one row per group
   *  (M-T1.3 Phase 4) — and is carried by `single: false` on the same flag. */
  projection?: boolean;
}

/** Resolve a repository find by name on the aggregate that owns it.  Returns
 *  undefined when no repository declares it — the caller then skips the read
 *  rather than emitting a provider it cannot type. */
function findOnAggregate(
  contexts: readonly EnrichedBoundedContextIR[],
  aggregateName: string,
  findName: string,
) {
  for (const c of contexts) {
    for (const repo of c.repositories) {
      if (repo.aggregateName !== aggregateName) continue;
      const hit = repo.finds.find((f) => f.name === findName);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** The provider-local var a detected api read resolves to (`Product` + `all` →
 *  `productAll`) — identical to the view seam's `apiVarName`, so the hoisted
 *  `ref.watch(<var>Provider)` and this emitter's `<var>Provider` line up. */
function readVarName(aggregate: string, operation: string): string {
  return `${lowerFirst(aggregate)}${upperFirst(operation)}`;
}

/** Direct child expressions of `e` (expression positions only). */
function exprChildren(e: ExprIR): ExprIR[] {
  switch (e.kind) {
    case "member":
      return [e.receiver];
    case "method-call":
      return [e.receiver, ...e.args];
    case "call":
      return e.args;
    case "lambda":
      return e.body ? [e.body] : [];
    case "object":
    case "new":
      return e.fields.map((f) => f.value);
    case "list":
      return e.elements;
    case "paren":
      return [e.inner];
    case "unary":
      return [e.operand];
    case "binary":
      return [e.left, e.right];
    case "ternary":
      return [e.cond, e.then, e.otherwise];
    case "convert":
      return [e.value];
    default:
      return [];
  }
}

/** Every READ-BEARING `of:` argument in a page body, in tree order.
 *
 *  Which primitives those are is the REGISTRY's answer (`readsOf`), not a list
 *  kept here — see `_walker/of-reads.ts`.  Miss one and a page whose only read
 *  is that primitive imports `reads.dart` while watching a provider the emitter
 *  never wrote: two `flutter analyze` errors (`uri_does_not_exist`,
 *  `undefined_identifier`), not a silent degradation. */
function queryViewOfArgs(body: ExprIR): ExprIR[] {
  const out: ExprIR[] = [];
  const walk = (e: ExprIR): void => {
    if (isOfReadCall(e)) {
      const names = e.argNames ?? [];
      const idx = names.indexOf("of");
      if (idx >= 0 && e.args[idx]) out.push(e.args[idx]!);
    }
    for (const c of exprChildren(e)) walk(c);
  };
  walk(body);
  return out;
}

/** Collect the reads a ui issues — deduped by `varName` across the whole ui.
 *  Aggregate-rooted reads (`<handle>.<Agg>.all` / `.byId(id)` / a named find)
 *  and query-time PROJECTION reads (`<handle>.<Proj>`, M-T1.3 Phase 1) project a
 *  provider; workflow-instance reads are still skipped (a follow-up), so the
 *  caller's hoist over the same detector stays consistent (an un-emitted
 *  provider would just be an unresolved var, never silent).
 *
 *  Both PAGE and user-COMPONENT bodies are scanned: a `component X() { body:
 *  QueryView { of: Api.Order.all, … } }` hosts its read exactly as a page does
 *  (`component-emit.ts` emits it as a `ConsumerWidget` whose `build` hoists the
 *  same `ref.watch(<var>Provider)`), so the provider it watches has to be in
 *  `reads.dart`.  Before this, a read-bearing component was dropped whole —
 *  declaration AND every call site — and the page fell back to the "unknown
 *  layout component" comment. */
export function collectFlutterReads(
  ui: UiIR | undefined,
  contexts: readonly EnrichedBoundedContextIR[],
): FlutterRead[] {
  if (!ui) return [];
  const apiParamNames = new Set((ui.apiParams ?? []).map((p) => p.name));
  const aggregatesByName = new Set(contexts.flatMap((c) => c.aggregates.map((a) => a.name)));
  // The SHARED readability predicate — the same set the walker's detector and
  // the IR-level gate use, so a page that resolves a projection read and this
  // collector cannot disagree about which projections are readable.
  const projectionsByName = readableProjectionNames(contexts);
  const groupedProjections = groupedProjectionNames(contexts);
  const detCtx = { apiParamNames, aggregatesByName, projectionsByName };
  const pagedCtx = { ...detCtx, bcByAggregate: bcByAggregateOf(contexts) };
  const out: FlutterRead[] = [];
  const seen = new Set<string>();
  const bodies = [
    ...(ui.pages ?? []).map((p) => p.body),
    ...(ui.components ?? []).map((c) => c.body),
  ];
  for (const body of bodies) {
    if (!body) continue;
    for (const ofArg of queryViewOfArgs(body)) {
      const detected = tryDetectApiHook(ofArg, detCtx);
      if (detected?.kind === "projection") {
        // Paramless by construction — the projection IS the row, so there is
        // no id and no query key, and the provider is the bare
        // `FutureProvider` rather than any `.family`.
        const varName = readVarName(detected.aggregateName, detected.operation);
        if (seen.has(varName)) continue;
        seen.add(varName);
        out.push({
          varName,
          aggregate: `${upperFirst(detected.aggregateName)}Row`,
          single: !groupedProjections.has(detected.aggregateName),
          routePath: `/projections/${snake(detected.aggregateName)}`,
          paged: false,
          projection: true,
        });
        continue;
      }
      if (detected?.kind !== "aggregate") continue;
      const isLifecycle = detected.operation === "all" || detected.operation === "byId";
      // A PARAMETERIZED repository find (anything that is not `.all` / `.byId`)
      // resolves against the aggregate's repository.  Skipping it here is what
      // left the page walker calling `<agg><Find>Provider(...)` — and importing
      // `reads.dart` — for a provider that was never emitted.
      const find = isLifecycle
        ? undefined
        : findOnAggregate(contexts, detected.aggregateName, detected.operation);
      if (!isLifecycle && !find) continue;
      const varName = readVarName(detected.aggregateName, detected.operation);
      if (seen.has(varName)) continue;
      seen.add(varName);
      if (find) {
        out.push({
          varName,
          aggregate: upperFirst(detected.aggregateName),
          // A find returning `T?` is a single-record read; `T[]` is a list.
          single: find.returnType.kind !== "array",
          // Matches the backend route the other frontends already call:
          // `GET /<plural(agg)>/<snake(findName)>?<params>` (cf. the React
          // `useNamedProduct` client — the contract is read off that, not
          // invented here).
          routePath: `/${snake(plural(detected.aggregateName))}/${snake(detected.operation)}`,
          paged: false,
          params: find.params.map((p) => ({ name: p.name, dartType: dartType(p.type) })),
        });
        continue;
      }
      // Paged-ness comes from the SHARED derivation the walker also calls, so
      // the provider's shape, the call site's args and the body's member reads
      // cannot disagree about whether this read is paged.
      out.push({
        varName,
        aggregate: upperFirst(detected.aggregateName),
        single: detected.operation === "byId",
        routePath: `/${snake(plural(detected.aggregateName))}`,
        paged: detected.operation !== "byId" && isPagedQuery(ofArg, pagedCtx),
      });
    }
  }
  return out;
}

/** `lib/config.dart` — the API-base config + a `Uri` builder.  `apiBaseUrl` is
 *  a compile-time `String.fromEnvironment('API_BASE_URL')` (settable via
 *  `--dart-define`), defaulting to the same-origin `/api` proxy prefix the
 *  other Loom frontends fetch relative.  `apiUri` joins a route path onto it:
 *  an absolute base (`http://host/api`) parses straight; a relative base
 *  (`/api`) resolves against `Uri.base` (the document origin on web). */
export function renderAppConfig(): string {
  return `${lines(
    "// API-base configuration for the generated Flutter app (Loom).  Do not edit.",
    "",
    "class AppConfig {",
    "  const AppConfig._();",
    "",
    "  static const String apiBaseUrl =",
    "      String.fromEnvironment('API_BASE_URL', defaultValue: '/api');",
    "}",
    "",
    "/// Build the request [Uri] for an API [path] (leading-slash, e.g. `/products`).",
    "Uri apiUri(String path) {",
    "  const base = AppConfig.apiBaseUrl;",
    "  final rel = path.startsWith('/') ? path.substring(1) : path;",
    "  final joined = base.endsWith('/') ? '$base$rel' : '$base/$rel';",
    "  if (joined.startsWith('http://') || joined.startsWith('https://')) {",
    "    return Uri.parse(joined);",
    "  }",
    "  return Uri.base.resolve(joined.startsWith('/') ? joined.substring(1) : joined);",
    "}",
  )}\n`;
}

/** Emit one Riverpod read provider — a list `FutureProvider<List<T>>` (GET the
 *  collection, unwrap the paged `items` envelope, map `T.fromJson`), or a byId
 *  `FutureProvider.family<T?, String>` (GET `/<coll>/$id`, 404 → `null`). */
function renderReadProvider(read: FlutterRead): string {
  const { aggregate, varName, routePath } = read;
  // A projection, or a named find that declares NO parameters.  Both fetch one
  // fixed URL with nothing to key on, so both are a PLAIN `FutureProvider` —
  // which is also what the call site already emits for them (`renderApiHoisting`
  // watches the bare `<var>Provider` when a read renders no args).  A zero-param
  // find used to fall into the `.family` branch below, whose key type is a Dart
  // RECORD of the params: with none, that spells `({})`, and the empty record
  // type in Dart is `()`.  The result did not analyze at all — 19 errors from
  // one line, cascading into every page that watched the provider.
  if (read.projection || read.params?.length === 0) {
    // A SINGLETON projection returns ONE object and a GROUPED one a bare array
    // — neither is the paged `{items: […]}` envelope a `.all` read unwraps, and
    // neither takes an argument.  A parameterless find is the same shape: the
    // backend emits `c.json(result.map(toWire))`, a BARE array, so it decodes
    // like the grouped projection rather than like `.all`.  Tested BEFORE the
    // `single` branch below, which means "byId `.family` keyed by a route id":
    // neither a projection nor a named find has one.
    //
    // The singleton yields `Row?`, not `Row`, for the same reason Feliz lifts
    // it into `Row option`: the walker renders a `QueryView`'s authored
    // `empty:` slot as a `== null` guard on the bound value, and against a
    // NON-nullable Dart type that comparison is a dead-code warning
    // (`unnecessary_null_comparison`) — `flutter analyze` fails on it, and
    // dropping the guard instead would silently discard markup the author
    // wrote.  404 → null keeps the branch genuinely reachable, exactly as the
    // byId provider below does.
    const returnType = read.single ? `${aggregate}?` : `List<${aggregate}>`;
    return lines(
      `final ${varName}Provider = FutureProvider<${returnType}>((ref) async {`,
      `  final res = await http.get(apiUri('${routePath}'));`,
      read.single ? "  if (res.statusCode == 404) return null;" : null,
      "  if (res.statusCode != 200) {",
      `    throw Exception('GET ${routePath} failed (\${res.statusCode})');`,
      "  }",
      ...(read.single
        ? [`  return ${aggregate}.fromJson(jsonDecode(res.body) as Map<String, dynamic>);`]
        : [
            "  final rows = jsonDecode(res.body) as List<dynamic>;",
            "  return rows",
            `      .map((e) => ${aggregate}.fromJson(e as Map<String, dynamic>))`,
            "      .toList();",
          ]),
      "});",
    );
  }
  if (read.params && read.params.length > 0) {
    // A parameterized find → a `.family` keyed by a Dart RECORD of the declared
    // params, matching the call the page walker already emits.  A record (not a
    // class) for the same reason the paged `LoomQuery` is one: `.family`
    // compares keys with `==`, and records have structural equality for free —
    // a key type without it would miss the cache and refetch on every rebuild.
    const recordType = `({${read.params.map((p) => `${p.dartType} ${p.name}`).join(", ")}})`;
    const returnType = read.single ? `${aggregate}?` : `List<${aggregate}>`;
    const queryEntries = read.params.map((p) => `    '${p.name}': '\${q.${p.name}}',`);
    return lines(
      `final ${varName}Provider =`,
      `    FutureProvider.family<${returnType}, ${recordType}>((ref, q) async {`,
      `  final res = await http.get(apiUri('${routePath}').replace(queryParameters: {`,
      ...queryEntries,
      "  }));",
      read.single ? "  if (res.statusCode == 404) return null;" : null,
      "  if (res.statusCode != 200) {",
      `    throw Exception('GET ${routePath} failed (\${res.statusCode})');`,
      "  }",
      ...(read.single
        ? [`  return ${aggregate}.fromJson(jsonDecode(res.body) as Map<String, dynamic>);`]
        : [
            // A named find returns a BARE ARRAY, not the paged `{items: […]}`
            // envelope — `.all` is paged-by-default (M-T2.6) and a find is not
            // (the backend emits `c.json(result.map(toWire))`).  Decoding this
            // as a Map would throw at runtime, and `flutter analyze` cannot see
            // a wrong JSON shape, so it is read off the emitted route rather
            // than assumed to match `.all`.
            "  final items = jsonDecode(res.body) as List<dynamic>;",
            "  return items",
            `      .map((e) => ${aggregate}.fromJson(e as Map<String, dynamic>))`,
            "      .toList();",
          ]),
      "});",
    );
  }
  if (read.single) {
    return lines(
      `final ${varName}Provider = FutureProvider.family<${aggregate}?, String>((ref, id) async {`,
      `  final res = await http.get(apiUri('${routePath}/$id'));`,
      "  if (res.statusCode == 404) return null;",
      "  if (res.statusCode != 200) {",
      `    throw Exception('GET ${routePath}/$id failed (\${res.statusCode})');`,
      "  }",
      `  return ${aggregate}.fromJson(jsonDecode(res.body) as Map<String, dynamic>);`,
      "});",
    );
  }
  if (read.paged) {
    // SERVER-DRIVEN list: a `.family` keyed by the query record.  Riverpod
    // caches per key and refetches when it changes, so a sort or page tap is
    // just a state write — the same "let the server do it" shape the Phoenix
    // LiveView leg uses, expressed in Riverpod instead of assigns.
    //
    // The key is a Dart RECORD, which matters: `.family` compares keys by
    // `==`, and records have structural equality for free.  A class without a
    // hand-written `==` would miss the cache on every rebuild and refetch
    // forever.
    return lines(
      `final ${varName}Provider =`,
      `    FutureProvider.family<LoomPage<${aggregate}>, LoomQuery>((ref, q) async {`,
      `  final res = await http.get(apiUri('${routePath}').replace(queryParameters: {`,
      "    'page': '${q.page}',",
      "    'pageSize': '${q.pageSize}',",
      "    if (q.sort.isNotEmpty) 'sort': q.sort,",
      "    if (q.dir.isNotEmpty) 'dir': q.dir,",
      "  }));",
      "  if (res.statusCode != 200) {",
      `    throw Exception('GET ${routePath} failed (\${res.statusCode})');`,
      "  }",
      `  return LoomPage.fromJson(res.body, ${aggregate}.fromJson);`,
      "});",
    );
  }
  return lines(
    `final ${varName}Provider = FutureProvider<List<${aggregate}>>((ref) async {`,
    `  final res = await http.get(apiUri('${routePath}'));`,
    "  if (res.statusCode != 200) {",
    `    throw Exception('GET ${routePath} failed (\${res.statusCode})');`,
    "  }",
    "  final body = jsonDecode(res.body) as Map<String, dynamic>;",
    "  final items = body['items'] as List<dynamic>;",
    "  return items",
    `      .map((e) => ${aggregate}.fromJson(e as Map<String, dynamic>))`,
    "      .toList();",
    "});",
  );
}

/** The paged-read vocabulary: the query key and the decoded envelope.
 *
 *  `LoomQuery` is a named RECORD, not a class — `.family` keys are compared by
 *  `==`, and records give structural equality for free.  `LoomPage` carries the
 *  page COUNT alongside the rows, which is what a server-driven pager needs to
 *  know whether "Next" is live; the unpaged provider shape (a bare `List<T>`)
 *  cannot express that, which is why `Table`'s pager was unreachable on Flutter
 *  however the seam behaved. */
const PAGED_PREAMBLE = lines(
  "/// Query key for a server-paged read.  A record so Riverpod's `.family`",
  "/// caches by VALUE — a class without a hand-written `==` would miss the",
  "/// cache on every rebuild and refetch forever.",
  "typedef LoomQuery = ({int page, int pageSize, String sort, String dir});",
  "",
  "/// One page of a server-paged read: the rows plus the WHOLE page-metadata",
  "/// half of the `paged` wire envelope.  The pager only needs `totalPages`,",
  "/// but a page body can read any of them off its `QueryView` binding",
  '/// (`rows.total` — a "N results" label), and a member that is not decoded',
  "/// here is a member the DSL cannot reach (M-T1.3 Defect B).",
  "/// `totalPages` is clamped to at least 1 so an empty collection still reads",
  '/// "Page 1 of 1" rather than "of 0".',
  "class LoomPage<T> {",
  "  const LoomPage({",
  "    required this.items,",
  "    required this.page,",
  "    required this.pageSize,",
  "    required this.total,",
  "    required this.totalPages,",
  "  });",
  "",
  "  final List<T> items;",
  "  final int page;",
  "  final int pageSize;",
  "  final int total;",
  "  final int totalPages;",
  "",
  "  static LoomPage<T> fromJson<T>(",
  "    String body,",
  "    T Function(Map<String, dynamic>) fromItem,",
  "  ) {",
  "    final map = jsonDecode(body) as Map<String, dynamic>;",
  "    final items = (map['items'] as List<dynamic>)",
  "        .map((e) => fromItem(e as Map<String, dynamic>))",
  "        .toList();",
  "    final pages = (map['totalPages'] as num?)?.toInt() ?? 1;",
  "    return LoomPage<T>(",
  "      items: items,",
  "      page: (map['page'] as num?)?.toInt() ?? 1,",
  "      pageSize: (map['pageSize'] as num?)?.toInt() ?? items.length,",
  "      total: (map['total'] as num?)?.toInt() ?? items.length,",
  "      totalPages: pages < 1 ? 1 : pages,",
  "    );",
  "  }",
  "}",
);

/** Emit `lib/reads.dart` — every read provider a ui's pages issue, over
 *  `package:http` + the Track A `fromJson` models.  Returns "" when the ui has
 *  no reads (the caller then emits neither this file nor `lib/config.dart`). */
export function renderReadProviders(reads: readonly FlutterRead[]): string {
  if (reads.length === 0) return "";
  const blocks = reads.map(renderReadProvider);
  const pagedPreamble = reads.some((r) => r.paged) ? [PAGED_PREAMBLE, ""] : [];
  return `${lines(
    "// Riverpod read providers — one FutureProvider per QueryView read, fetching",
    "// over package:http and mapping the Track A wire models. Generated by the",
    "// Loom Flutter target; do not edit.",
    "",
    "import 'dart:convert';",
    "",
    "import 'package:flutter_riverpod/flutter_riverpod.dart';",
    "import 'package:http/http.dart' as http;",
    "",
    "import 'config.dart';",
    "import 'models.dart';",
    "",
    ...pagedPreamble,
    ...blocks.flatMap((b, i) => (i === 0 ? [b] : ["", b])),
  )}\n`;
}
