// ---------------------------------------------------------------------------
// Targets drawer — the PURE half (M-T8.23 slice 1).
//
// The drawer lists the system's deployables and lets the user swap a target's
// platform / frontend framework / design pack, then regenerates.  This is the
// compiler playground's version selector applied to the whole stack (research
// §4 #21) — and, like every other structural edit in the playground, it goes
// through the node-addressed patch surface `ddd patch` uses
// (`applyPatches`, `src/language/model-patch.ts`) rather than a bespoke
// text mangler.
//
// Why `replace` and not a finer op: `platform:` / `design:` / `framework:` are
// CLAUSES, not addressable nodes — the smallest patch target that contains one
// is the enclosing `deployable` / `ui` declaration.  So the patch replaces the
// whole declaration, with a `source` built by rewriting ONE clause inside the
// declaration's own text.  Everything else in the block — comments, clause
// order, spacing — survives byte-for-byte, and the rest of the file is never
// even re-printed (the applier splices CST ranges).
//
// React-free on purpose: the root vitest suite (which has no
// `web/node_modules`) imports this directly.  `readTargets` reads a parsed
// `Model`; it never parses, so the module stays synchronous and testable with
// hand-built targets as well as real sources.
// ---------------------------------------------------------------------------

import type { AstNode } from "langium";
import type { ModelPatch } from "../../../src/diagnostics/contract.js";
import { isDeployable, isSystem, isUi, type Model } from "../../../src/language/generated/ast.js";
import type { Platform } from "../../../src/ir/types/loom-ir.js";
// The CLIENT-SAFE metadata half only — `platform/registry.ts` would drag every
// backend generator into the main bundle (see `web-bundle-boundary.test.ts`).
import {
  backendPlatformNames,
  descriptorFor,
  frontendPlatformNames,
} from "../../../src/platform/metadata.js";
import {
  BUILTIN_PACK_FORMATS,
  BUILTIN_PACK_LATEST,
  packFormatForBuiltin,
} from "../../../src/util/builtin-formats.js";

/** The three axes the drawer edits.  `platform` is the deployable's own
 *  `platform:` (which, for a frontend deployable, IS the frontend framework);
 *  `design` is its `design:` pack; `framework` is the bound `ui` declaration's
 *  `framework:` (D-PHOENIX-SURFACE — the ui owns it). */
export type TargetAxis = "platform" | "design" | "framework";

/** A deployable as the drawer sees it — read off the AST by `read-targets.ts`,
 *  or hand-built in a test.  `text` is the declaration's exact source slice;
 *  `address` is its canonical patch address (`deployable webApp`). */
export interface TargetDeployable {
  name: string;
  /** Canonical patch address of the `deployable` declaration. */
  address: string;
  /** The declaration's source slice, verbatim. */
  text: string;
  /** Raw `platform:` value (`react`, `node@v4`, …). */
  platform: string;
  /** Raw `design:` value, or null when the clause is absent. */
  design: string | null;
  /** True when the descriptor table says this platform is a frontend. */
  isFrontend: boolean;
  /** True when the deployable mounts a UI (`ui:` / `hosts:`). */
  mountsUi: boolean;
  /** The bound `ui` declaration, when the deployable binds one. */
  ui: TargetUi | null;
}

/** The `ui` declaration a deployable binds, as the drawer sees it. */
export interface TargetUi {
  name: string;
  /** Canonical patch address (`ui WebApp`). */
  address: string;
  text: string;
  /** Raw `framework:` value, or null when the clause is absent. */
  framework: string | null;
}

// ---------------------------------------------------------------------------
// Clause rewriting
// ---------------------------------------------------------------------------

/** Neutralise comments and string CONTENT so a clause scan can't match inside
 *  one.  Offsets are preserved (one character in, one out, newlines kept), so
 *  a hit in the mask indexes straight into the original.
 *
 *  Comments become spaces; a string's interior becomes `~` and its quotes are
 *  KEPT.  The quotes matter twice: `\s*` in a clause regex must not swallow a
 *  masked string value, and `mask[start] === '"'` is how the value scanner
 *  recognises a quoted value without re-lexing. */
export function maskInert(text: string): string {
  const out = text.split("");
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      while (i < text.length && text[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== "\n") out[i] = " ";
      i = stop;
      continue;
    }
    if (text[i] === '"') {
      i++; // keep the opening quote
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) out[i++] = "~";
        out[i++] = "~";
      }
      i++; // keep the closing quote
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Span of one clause's VALUE token inside `text`, or null when the clause is
 *  absent.  `keyword` is matched as a whole word outside comments/strings. */
export function findClauseValue(
  text: string,
  keyword: TargetAxis,
): { start: number; end: number; value: string } | null {
  const mask = maskInert(text);
  const re = new RegExp(`\\b${keyword}\\s*:\\s*`, "g");
  const m = re.exec(mask);
  if (!m) return null;
  const start = m.index + m[0].length;
  // The value is either a quoted string (`"node@v4"`) or a bare token
  // (`react`, `mantine@v9`).  `@`, `.`, `-`, `/` are in the bare set so a
  // pinned ref or a relative custom-pack path round-trips.
  if (mask[start] === '"') {
    let end = start + 1;
    while (end < text.length && !(text[end] === '"' && text[end - 1] !== "\\")) end++;
    if (end < text.length) end++;
    return { start, end, value: text.slice(start, end) };
  }
  let end = start;
  while (end < text.length && /[A-Za-z0-9_@.$/-]/.test(text[end] ?? "")) end++;
  if (end === start) return null;
  return { start, end, value: text.slice(start, end) };
}

/** Read a clause's value, unquoted.  `null` when the clause is absent. */
export function readClause(text: string, keyword: TargetAxis): string | null {
  const found = findClauseValue(text, keyword);
  if (!found) return null;
  return found.value.startsWith('"') ? found.value.slice(1, -1) : found.value;
}

/** A value that needs quoting in source — anything the grammar's bareword
 *  alternatives don't cover (a version pin, a custom-pack path). */
function renderValue(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : JSON.stringify(value);
}

/** Rewrite (or insert) one clause inside a declaration's source text.
 *  Returns the new text, or `null` when the edit is a no-op (the clause
 *  already reads `value`) — a no-op patch is never emitted, so the caller can
 *  distinguish "nothing to do" from "applied".
 *
 *  Insertion placement mirrors how a human writes the block: on a multi-line
 *  declaration the new clause becomes its own line right after `platform:`
 *  (or after the opening brace when there is none); on a one-line declaration
 *  it is appended before the closing brace with a separating comma. */
export function rewriteClause(text: string, keyword: TargetAxis, value: string): string | null {
  const rendered = renderValue(value);
  const found = findClauseValue(text, keyword);
  if (found) {
    if (found.value === rendered) return null;
    return text.slice(0, found.start) + rendered + text.slice(found.end);
  }
  const mask = maskInert(text);
  const open = mask.indexOf("{");
  const close = mask.lastIndexOf("}");
  if (open === -1 || close === -1 || close < open) return null;
  const clause = `${keyword}: ${rendered}`;
  const body = text.slice(open + 1, close);
  if (!body.includes("\n")) {
    // One-line block — `deployable webApp { platform: react, ui: WebApp }`.
    const trimmed = body.trimEnd();
    const sep = trimmed.trim() === "" ? "" : trimmed.endsWith(",") ? " " : ", ";
    return `${text.slice(0, open + 1)}${trimmed}${sep}${clause} ${text.slice(close)}`;
  }
  // Multi-line block — insert after the `platform:` line when there is one,
  // else on the line after the opening brace, at the body's indentation.
  const anchor = findClauseValue(text, "platform");
  const from = anchor ? anchor.end : open + 1;
  let lineEnd = from;
  while (lineEnd < close && text[lineEnd] !== "\n") lineEnd++;
  const indent = bodyIndent(text, open, close);
  return `${text.slice(0, lineEnd)}\n${indent}${clause}${text.slice(lineEnd)}`;
}

/** Indentation of the declaration body's first non-blank line, falling back to
 *  the closing brace's own indent plus two spaces. */
function bodyIndent(text: string, open: number, close: number): string {
  for (const line of text.slice(open + 1, close).split("\n")) {
    if (line.trim() === "") continue;
    return line.slice(0, line.length - line.trimStart().length);
  }
  let braceLine = close;
  while (braceLine > 0 && text[braceLine - 1] !== "\n") braceLine--;
  return `${text.slice(braceLine, close)}  `;
}

// ---------------------------------------------------------------------------
// Patch construction
// ---------------------------------------------------------------------------

/** Design-pack family every framework defaults to — the same table
 *  `src/ir/lower/lower-deployment.ts` uses when a deployable omits `design:`,
 *  mirrored here so a platform swap can carry the design with it. */
export const DEFAULT_PACK_BY_FRAMEWORK: Readonly<Record<string, string>> = {
  react: "mantine",
  static: "mantine",
  svelte: "shadcnSvelte",
  vue: "vuetify",
  angular: "angularMaterial",
  phoenixLiveView: "coreComponents",
  elixir: "coreComponents",
};

/** Build the patches for one axis change.  Returns `[]` when the change is a
 *  no-op, so a caller can refuse visibly rather than "apply" nothing.
 *
 *  A `platform` change can carry a SECOND patch: when the deployable pins a
 *  `design:` whose pack format no longer matches the new framework (React's
 *  `mantine` on a `vue` deployable is `loom.design-pack-format-mismatch`), the
 *  design is rewritten to the new framework's default pack in the same atomic
 *  patch set.  Otherwise the swap would hand the user a source that fails to
 *  validate through no choice of theirs. */
export function targetPatches(
  target: TargetDeployable,
  axis: TargetAxis,
  value: string,
  packFormat: (pack: string) => string | undefined = packFormatForBuiltin,
): ModelPatch[] {
  if (axis === "framework") {
    const ui = target.ui;
    // The scanner reads the FIRST `framework:` in the declaration.  For a `ui`
    // that is the framework clause (the grammar puts it before every member) —
    // unless the clause is absent and a page below declares a state field of
    // that name, in which case the scan and the AST disagree and we refuse
    // rather than rewrite the wrong line.
    if (!ui || readClause(ui.text, "framework") !== ui.framework) return [];
    const next = rewriteClause(ui.text, "framework", value);
    return next === null ? [] : [{ op: "replace", target: ui.address, source: next }];
  }

  // Same guard on the deployable's own clauses: what the text says must be what
  // the AST read, or the offsets describe something else.
  const seen = readClause(target.text, axis);
  if (seen !== (axis === "platform" ? target.platform : target.design)) return [];

  let text: string | null = rewriteClause(target.text, axis, value);
  if (text === null) return [];

  const out: ModelPatch[] = [];
  if (axis === "platform") {
    // "Switch this app from React to Vue" means the whole frontend, so a bound
    // `ui` that declares its own `framework:` follows the platform.  Leaving it
    // behind would either raise `loom.ui-framework-unhostable` or quietly keep
    // emitting the OLD framework's bundle from a host of the new name — the
    // exact silent no-op the drawer exists to avoid.
    const ui = target.ui;
    const nextFramework = target.isFrontend ? FRAMEWORK_BY_PLATFORM[value] : undefined;
    if (ui && nextFramework && ui.framework && ui.framework !== nextFramework) {
      if (readClause(ui.text, "framework") === ui.framework) {
        const uiText = rewriteClause(ui.text, "framework", nextFramework);
        if (uiText !== null) out.push({ op: "replace", target: ui.address, source: uiText });
      }
    }
    const framework = nextFramework ?? ui?.framework ?? value;
    const wanted = DEFAULT_PACK_BY_FRAMEWORK[framework];
    const current = readClause(text, "design");
    if (wanted && current && packFormat(current) !== packFormat(wanted)) {
      text = rewriteClause(text, "design", wanted) ?? text;
    }
  }
  out.push({ op: "replace", target: target.address, source: text });
  return out;
}

/** The `ui { framework: … }` value a frontend platform renders.  `static` is
 *  the React descriptor under another name; `feliz` / `flutter` self-host their
 *  own framework.  A platform absent here (every backend) carries no implied
 *  framework — the bound ui's own `framework:` stands. */
const FRAMEWORK_BY_PLATFORM: Readonly<Record<string, string>> = {
  react: "react",
  static: "react",
  vue: "vue",
  svelte: "svelte",
  angular: "angular",
  feliz: "feliz",
  flutter: "flutter",
};

// ---------------------------------------------------------------------------
// Reading the targets off a parsed model
// ---------------------------------------------------------------------------

/** Every deployable in the model, in source order, with the source slices the
 *  patch builder rewrites.  Deployables whose CST is missing (a recovered
 *  parse) are dropped — an offset taken from a recovered AST does not describe
 *  the user's source (`builder/pane-write.ts`'s READ gate, same rule). */
export function readTargets(ast: Model, source: string): TargetDeployable[] {
  const decls = topLevelDecls(ast);
  const uis = new Map<string, TargetUi>();
  for (const decl of decls) {
    if (!isUi(decl)) continue;
    const cst = decl.$cstNode;
    if (!cst) continue;
    uis.set(decl.name, {
      name: decl.name,
      address: `ui ${decl.name}`,
      text: source.slice(cst.offset, cst.end),
      framework: decl.framework ?? null,
    });
  }

  const out: TargetDeployable[] = [];
  for (const decl of decls) {
    if (!isDeployable(decl)) continue;
    const cst = decl.$cstNode;
    if (!cst) continue;
    const uiName =
      decl.uiSugar?.ref?.$refText ??
      decl.uiCompose?.ref?.$refText ??
      decl.hosts?.[0]?.$refText ??
      null;
    // An unknown / typo'd `platform:` throws in `descriptorFor` — the drawer
    // lists the deployable as unsupported rather than taking the page down.
    let descriptor: { isFrontend: boolean; mountsUi: boolean };
    try {
      descriptor = descriptorFor(decl.platform as Platform);
    } catch {
      continue;
    }
    out.push({
      name: decl.name,
      address: `deployable ${decl.name}`,
      text: source.slice(cst.offset, cst.end),
      platform: decl.platform,
      design: decl.design ?? null,
      isFrontend: descriptor.isFrontend,
      mountsUi: uiName !== null && descriptor.mountsUi,
      ui: uiName === null ? null : (uis.get(uiName) ?? null),
    });
  }
  return out;
}

/** Model members plus every `system { … }` member — deployables and uis are
 *  declarable at both levels. */
function topLevelDecls(ast: Model): AstNode[] {
  const out: AstNode[] = [];
  for (const m of ast.members ?? []) {
    out.push(m);
    if (isSystem(m)) out.push(...m.members);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The menus
// ---------------------------------------------------------------------------

/** Design-pack families whose format matches the framework this deployable
 *  renders against — the menu the drawer offers for `design:`.  Empty for a
 *  platform with no pack menu (flutter renders Material procedurally, feliz
 *  picks a daisyUI theme, a backend without a `ui:` mount carries no design). */
export function designPackMenu(target: TargetDeployable): string[] {
  const framework = target.ui?.framework ?? target.platform;
  const wanted = packFormatForBuiltin(DEFAULT_PACK_BY_FRAMEWORK[framework] ?? "");
  if (!wanted) return [];
  const families = new Set<string>();
  for (const qualified of Object.keys(BUILTIN_PACK_FORMATS)) {
    const family = qualified.slice(0, qualified.indexOf("@"));
    if (!(family in BUILTIN_PACK_LATEST)) continue;
    if (packFormatForBuiltin(family) === wanted) families.add(family);
  }
  return [...families].sort();
}

/** The platform menu for one deployable.  A frontend deployable may only
 *  become another frontend and a backend another backend — the `targets:` /
 *  `contexts:` clauses a deployable already carries are only legal on one side
 *  of that line, so offering the cross swap would hand the user a source the
 *  validator rejects for a reason the drawer caused. */
export function platformMenu(target: TargetDeployable): string[] {
  return (target.isFrontend ? frontendPlatformNames() : backendPlatformNames()).sort();
}
