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
import { lines } from "../../util/code-builder.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import { tryDetectApiHook } from "../_walker/api-hook-detector.js";

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

/** Every `QueryView(of: <expr>)` `of:` argument in a page body, in tree order. */
function queryViewOfArgs(body: ExprIR): ExprIR[] {
  const out: ExprIR[] = [];
  const walk = (e: ExprIR): void => {
    if (e.kind === "call" && e.name === "QueryView") {
      const names = e.argNames ?? [];
      const idx = names.indexOf("of");
      if (idx >= 0 && e.args[idx]) out.push(e.args[idx]!);
    }
    for (const c of exprChildren(e)) walk(c);
  };
  walk(body);
  return out;
}

/** Collect the `.all` / `.byId` reads a ui's pages issue — deduped by `varName`
 *  across the whole ui.  Only aggregate-rooted reads (`<handle>.<Agg>.all` /
 *  `.byId(id)`) project a provider; view / workflow-instance reads are skipped
 *  (a follow-up), so the caller's hoist over the same detector stays consistent
 *  (an un-emitted provider would just be an unresolved var, never silent). */
export function collectFlutterReads(
  ui: UiIR | undefined,
  contexts: readonly EnrichedBoundedContextIR[],
): FlutterRead[] {
  if (!ui) return [];
  const apiParamNames = new Set((ui.apiParams ?? []).map((p) => p.name));
  const aggregatesByName = new Set(contexts.flatMap((c) => c.aggregates.map((a) => a.name)));
  const detCtx = { apiParamNames, aggregatesByName };
  const out: FlutterRead[] = [];
  const seen = new Set<string>();
  for (const page of ui.pages ?? []) {
    if (!page.body) continue;
    for (const ofArg of queryViewOfArgs(page.body)) {
      const detected = tryDetectApiHook(ofArg, detCtx);
      if (detected?.kind !== "aggregate") continue;
      if (detected.operation !== "all" && detected.operation !== "byId") continue;
      const varName = readVarName(detected.aggregateName, detected.operation);
      if (seen.has(varName)) continue;
      seen.add(varName);
      out.push({
        varName,
        aggregate: upperFirst(detected.aggregateName),
        single: detected.operation === "byId",
        routePath: `/${snake(plural(detected.aggregateName))}`,
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

/** Emit `lib/reads.dart` — every read provider a ui's pages issue, over
 *  `package:http` + the Track A `fromJson` models.  Returns "" when the ui has
 *  no reads (the caller then emits neither this file nor `lib/config.dart`). */
export function renderReadProviders(reads: readonly FlutterRead[]): string {
  if (reads.length === 0) return "";
  const blocks = reads.map(renderReadProvider);
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
    ...blocks.flatMap((b, i) => (i === 0 ? [b] : ["", b])),
  )}\n`;
}
