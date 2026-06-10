// ---------------------------------------------------------------------------
// Java naming helpers — package segments, base-package derivation, and
// package → directory mapping.  Casing/pluralisation of identifiers flows
// through `src/util/naming.ts` like every other backend; this module only
// owns the Java-specific package rules (lowercase segments, reserved-word
// escaping, dir = package path).
// ---------------------------------------------------------------------------

/** Java language keywords + literals that can't be used as a package
 *  segment (or any identifier).  A colliding segment gets a `_` suffix. */
const JAVA_RESERVED = new Set([
  "abstract",
  "assert",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extends",
  "final",
  "finally",
  "float",
  "for",
  "goto",
  "if",
  "implements",
  "import",
  "instanceof",
  "int",
  "interface",
  "long",
  "native",
  "new",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "short",
  "static",
  "strictfp",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "transient",
  "try",
  "void",
  "volatile",
  "while",
  "true",
  "false",
  "null",
  "var",
  "record",
  "yield",
  "sealed",
  "permits",
]);

/** Sanitise one name into a legal lowercase Java package segment:
 *  lowercase, strip everything outside `[a-z0-9_]`, prefix `_` when the
 *  result starts with a digit, suffix `_` when it hits a reserved word. */
export function javaPackageSegment(name: string): string {
  let s = name.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (s.length === 0) s = "app";
  if (/^[0-9]/.test(s)) s = `_${s}`;
  if (JAVA_RESERVED.has(s)) s = `${s}_`;
  return s;
}

/** The generated project's base package for a deployable / context
 *  namespace — `com.loom.<segment>`.  Mirrors the role of the dotnet
 *  generator's `ns` (the PascalCase root namespace). */
export function basePackageFor(ns: string): string {
  return `com.loom.${javaPackageSegment(ns)}`;
}

/** `com.loom.shop.domain` → `com/loom/shop/domain` (the
 *  `src/main/java/...` directory for a package). */
export function packagePath(pkg: string): string {
  return pkg.replace(/\./g, "/");
}

/** Deployable-relative path of a main-source file in `pkg`. */
export function mainSourcePath(pkg: string, file: string): string {
  return `src/main/java/${packagePath(pkg)}/${file}`;
}

/** Deployable-relative path of a test-source file in `pkg`. */
export function testSourcePath(pkg: string, file: string): string {
  return `src/test/java/${packagePath(pkg)}/${file}`;
}
