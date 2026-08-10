// The generated Flutter app's Dart PACKAGE NAME.
//
// It is `snake(deployable.name)` — except when that collides with a package the
// generated app already depends on, which makes the app unbuildable before a
// line of its code is read:
//
//     $ flutter pub get
//     Because http >=1.2.2 depends on web >=0.5.0 <2.0.0 and web is 0.1.0,
//     version solving failed.
//
// `web` is a real pub.dev package and a transitive dependency of `http`, which
// every generated Flutter app uses.  Name the deployable `web` — the single
// most natural name for a frontend, and the one every other frontend example in
// this repo uses — and pub resolves that dependency to the LOCAL root package
// instead, finds version 0.1.0 where `^0.5.0` was required, and gives up.  The
// failure names neither the deployable nor the collision.
//
// SO THE RULE IS A DENYLIST, NOT A BLANKET SUFFIX.  Always appending `_app`
// would guarantee no collision with these names at the cost of renaming every
// existing generated app's package (and its `package:<pkg>/main.dart` test
// imports) for a problem almost none of them have.  Renaming only on collision
// keeps every non-colliding name byte-identical.
//
// A name that is missing from the list below degrades to exactly today's
// behaviour — a loud `pub get` failure, not a silent mis-build — so an
// incomplete list is a gap, never a corruption.  The set is the resolved
// dependency graph of a generated app (`pubspec.lock`), plus the packages the
// optional `file_picker` dependency pulls in, plus the Dart reserved words a
// pubspec `name:` may not be.

import { snake } from "../../util/naming.js";

/** Package names a generated app must not take: everything in its own resolved
 *  dependency graph (taking one of these shadows the real package), plus the
 *  Dart reserved words that are not legal package names at all. */
const RESERVED_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  // --- the resolved graph of a generated app (from its own pubspec.lock) ----
  "async",
  "boolean_selector",
  "characters",
  "clock",
  "collection",
  "fake_async",
  "flutter",
  "flutter_lints",
  "flutter_riverpod",
  "flutter_test",
  "http",
  "http_parser",
  "intl",
  "leak_tracker",
  "leak_tracker_flutter_testing",
  "leak_tracker_testing",
  "lints",
  "matcher",
  "material_color_utilities",
  "meta",
  "path",
  "riverpod",
  "sky_engine",
  "source_span",
  "stack_trace",
  "state_notifier",
  "stream_channel",
  "string_scanner",
  "term_glyph",
  "test_api",
  "typed_data",
  "vector_math",
  "vm_service",
  "web",
  // --- pulled in only by the optional `file_picker` dependency --------------
  "cross_file",
  "cupertino_icons",
  "ffi",
  "file_picker",
  "flutter_plugin_android_lifecycle",
  "plugin_platform_interface",
  "win32",
  // --- Dart reserved words: a pubspec `name:` must be a valid identifier ----
  "abstract",
  "assert",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "else",
  "enum",
  "extends",
  "false",
  "final",
  "finally",
  "for",
  "if",
  "in",
  "is",
  "new",
  "null",
  "rethrow",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "var",
  "void",
  "while",
  "with",
]);

/** The Dart package name for a Flutter deployable — `snake(name)`, suffixed
 *  `_app` when that would collide with a dependency or a reserved word.
 *
 *  One derivation for all three consumers: the pubspec `name:`, and the
 *  `package:<pkg>/main.dart` imports in the two emitted test files.  They must
 *  agree, so they read this rather than each snake-casing the deployable. */
export function dartPackageName(deployableName: string): string {
  const base = snake(deployableName) || "loom_app";
  return RESERVED_PACKAGE_NAMES.has(base) ? `${base}_app` : base;
}
