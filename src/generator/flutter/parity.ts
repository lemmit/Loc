// Flutter parity lint — a post-generation static pass that tells you, for a given
// `.ddd`, where the Flutter target falls back to a diagnostic comment instead of
// rendering the real widget.  It is the playground's "will my app FULLY lower to
// Flutter, or hit a gap?" check (Tier A of the playground-flutter-web-preview
// proposal), and the cheap complement to actually compiling the Dart.
//
// DESIGN: the generator is the single source of truth — this scans the EMITTED
// Dart VFS for the diagnostic markers the emitters already produce, rather than
// re-deriving the fallback conditions (which would rot the moment an emitter
// grows a case).  A Flutter fallback is a `/* … */` block comment
// (`flutterTarget.renderComment`), a `// TODO(flutter …)` line, or the pack's
// `// flutter pack: no renderer for "X"` line — a deferred user component
// (`unknown layout component: <name>`), a mis-shaped `Modal`/`Action`/
// `WorkflowForm`, an unsupported action statement, a store-action call, a dropped
// form field (M-A), or an unrendered standalone primitive (M-D).  Generated Dart
// otherwise uses only `//` line comments for its file banners, so a `/* … */` in
// a `.dart` file is always a diagnostic.
//
// COVERAGE: this catches the LOUD fallbacks — three marker families:
//   1. a `/* … */` block comment (`flutterTarget.renderComment` diagnostics),
//   2. a `// TODO(flutter …): …` line (Notifier-projection deferrals AND, since
//      M-A, every form-field drop `prepareFields` couldn't render), and
//   3. the pack's `// flutter pack: no renderer for "X"` fallback (M-D) — the
//      standalone input family (`Field`/`Toggle`/… → `primitive-field`, etc.)
//      the walking-skeleton pack doesn't yet render.
// After M-A + M-D the earlier "silently dropped form field" limitation is closed:
// the drop sites now emit markers this pass reads, so `fullyRenders` no longer
// reports `true` while content vanishes.

/** One place the Flutter target fell back from a real widget to a diagnostic. */
export interface FlutterParityFinding {
  /** Emitted file the marker sits in, e.g. `lib/pages/edit_page.dart`. */
  file: string;
  /** 1-based line of the marker in that file. */
  line: number;
  /** Coarse classification for grouping / iconography. */
  kind: "unknown-component" | "todo" | "diagnostic";
  /** The marker text itself — already human-readable (the emitters write full
   *  sentences, e.g. "Modal: expects trigger: Button(...) and an
   *  OperationForm(of:, op:) child"). */
  message: string;
  /** Friendly source hint derived from the file (`page Edit`, `components`,
   *  `forms`) so a finding points back at the `.ddd` construct. */
  source: string;
}

/** Roll-up of a parity scan — drives a one-glance badge in the playground. */
export interface FlutterParitySummary {
  /** True when the emitted Dart carries no fallback markers at all. */
  fullyRenders: boolean;
  /** Total findings. */
  count: number;
  /** Count per `kind`. */
  byKind: Record<FlutterParityFinding["kind"], number>;
  findings: FlutterParityFinding[];
}

/** Derive a friendly source label from an emitted Dart path. */
function sourceHint(path: string): string {
  const m = path.match(/lib\/pages\/(.+)_page\.dart$/);
  if (m) {
    // `product_admin_page.dart` → `page ProductAdmin`.
    const pascal = m[1]!
      .split("_")
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("");
    return `page ${pascal}`;
  }
  if (path.endsWith("lib/components.dart")) return "components";
  if (path.endsWith("lib/forms.dart")) return "forms";
  if (path.endsWith("lib/reads.dart")) return "reads";
  if (path.endsWith("lib/main.dart")) return "app shell";
  return path.replace(/^.*\/lib\//, "lib/");
}

function classify(text: string): FlutterParityFinding["kind"] {
  if (/unknown (layout )?component/i.test(text)) return "unknown-component";
  if (/^TODO\(flutter/i.test(text)) return "todo";
  return "diagnostic";
}

/** The 1-based line number a character offset lands on. */
function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

// A `/* … */` block comment (the `renderComment` diagnostics + inline
// `/* TODO(flutter): … */` markers).  Non-greedy so adjacent comments stay
// separate; `[\s\S]` so it spans lines.
const BLOCK_COMMENT = /\/\*\s*([\s\S]*?)\s*\*\//g;
// A `// TODO(flutter …): …` line marker (the Notifier-projection deferrals and
// the M-A form-field drop markers).
const TODO_LINE = /\/\/\s*(TODO\(flutter[^)]*\):[^\n]*)/g;
// The pack's `// flutter pack: no renderer for "X"` fallback (pack.ts:524) — a
// primitive the flutterMaterial pack has no renderer for (the standalone input
// family, etc.).  Captures the primitive name so the finding can name it (M-D).
const PACK_FALLBACK = /\/\/\s*flutter pack: no renderer for "([^"]+)"/g;

/** Scan one emitted Dart file for fallback markers. */
function scanFile(path: string, content: string): FlutterParityFinding[] {
  const out: FlutterParityFinding[] = [];
  const source = sourceHint(path);
  for (const m of content.matchAll(BLOCK_COMMENT)) {
    const text = m[1]!.trim();
    if (!text) continue;
    out.push({
      file: path,
      line: lineAt(content, m.index),
      kind: classify(text),
      message: text,
      source,
    });
  }
  for (const m of content.matchAll(TODO_LINE)) {
    out.push({
      file: path,
      line: lineAt(content, m.index),
      kind: "todo",
      message: m[1]!.trim(),
      source,
    });
  }
  for (const m of content.matchAll(PACK_FALLBACK)) {
    out.push({
      file: path,
      line: lineAt(content, m.index),
      kind: "diagnostic",
      message: `flutter pack: no renderer for "${m[1]}"`,
      source,
    });
  }
  return out;
}

/** Analyse an emitted Flutter VFS for parity fallbacks.  Pure + browser-safe:
 *  the caller generates the flutter deployable once, then hands the file map
 *  here.  Only `.dart` files are scanned (assets / pubspec / web shell carry no
 *  walker output). */
export function analyzeFlutterParity(files: ReadonlyMap<string, string>): FlutterParityFinding[] {
  const findings: FlutterParityFinding[] = [];
  for (const [path, content] of files) {
    if (!path.endsWith(".dart")) continue;
    findings.push(...scanFile(path, content));
  }
  // Stable order: by file, then line.
  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return findings;
}

/** Roll a parity scan into a badge-ready summary. */
export function flutterParitySummary(files: ReadonlyMap<string, string>): FlutterParitySummary {
  const findings = analyzeFlutterParity(files);
  const byKind = { "unknown-component": 0, todo: 0, diagnostic: 0 };
  for (const f of findings) byKind[f.kind]++;
  return { fullyRenders: findings.length === 0, count: findings.length, byKind, findings };
}
