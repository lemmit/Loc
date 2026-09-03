import { AstUtils, TextDocument } from "langium";
import type { MacroCall, Model, Ui, WithClause } from "../../../../src/language/generated/ast.js";
import { isMacroCall, isUi } from "../../../../src/language/generated/ast.js";
import { enumerateScaffoldPageUnfolds } from "../../../../src/language/lsp/unfold-macro.js";
import { buildLinkedDocument } from "../system/linked-doc";
import { ifParses } from "../edit-engine";

// Scaffold awareness for the page builder (M-T8.21 slice 1, audit H6).
//
// The Builder parses the source with the bare Langium parser (`parse.ts`) —
// no macro expansion — so a `ui WebApp with scaffold(...)` contributes NO
// pages to `collectBodies`, and the Sales System example opened on an empty
// canvas that told the user to write a `ui { page }` block.  The pages exist;
// they are synthesised by the macro in phase ② and the canvas can't edit a
// node with no source range.
//
// This module makes the gradient visible: it BUILDS the source (parse + macro
// expansion + linking, on the reused main-thread services `linked-doc.ts`
// keeps), then asks the unfold refactor for the per-page ejections the LSP
// code action already offers (`enumerateScaffoldPageUnfolds` — pure over a
// `LangiumDocument`, no `CodeAction` plumbing).  Each entry carries the text
// edits that turn one scaffolded page into a real `page` inside its
// `area <Plural> { … }`, which the override-by-name merge then substitutes
// for the generated one — its siblings stay under the macro.
//
// Pure + async (the build is), React-free, so the unit test drives it directly.

/** One page the scaffold produces, with the edits that eject it. */
export interface ScaffoldedPage {
  /** Stable key — `Orders/List`, `Home`. */
  key: string;
  /** Human label — `Orders / List`. */
  label: string;
  /** The `page` name the ejected source declares (`List`), i.e. what
   *  `collectBodies` reports once the unfold lands. */
  pageName: string;
  /** The enclosing area (absent for the singleton Home / index pages). */
  areaName?: string;
  /** The `ui` the macro is applied to. */
  uiName: string;
  /** The macro (`scaffold`, `scaffoldSubdomain`, …). */
  macroName: string;
  /** The LSP-shaped edits, computed against the source they were listed on. */
  edits: readonly { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[];
}

/** Every `with <macro>(...)` call on a `ui` in the (unlinked) AST — the
 *  cheap pre-check the pane runs on every parse before paying for a build. */
export function uiMacroCalls(ast: Model): { ui: Ui; call: MacroCall }[] {
  const out: { ui: Ui; call: MacroCall }[] = [];
  for (const node of AstUtils.streamAst(ast)) {
    if (!isUi(node)) continue;
    const clause = (node as { withClause?: WithClause }).withClause;
    for (const call of clause?.calls ?? []) if (isMacroCall(call)) out.push({ ui: node, call });
  }
  return out;
}

/** True when some `ui` carries a macro call — i.e. the source MAY have
 *  scaffolded pages and a build is worth running. */
export function mayHaveScaffoldedPages(ast: Model): boolean {
  return uiMacroCalls(ast).length > 0;
}

/** The document URI the scaffold build reuses (one services instance, see
 *  `linked-doc.ts` on why reuse is keyed by URI). */
const SCAFFOLD_URI = "memory:///loom-scaffold.ddd";

/** List the pages every `ui`'s scaffold macros synthesise from `source`.
 *  Returns [] when nothing is scaffolded, the source doesn't build, or a
 *  macro produces no pages. */
export async function listScaffoldedPages(source: string): Promise<ScaffoldedPage[]> {
  const linked = await buildLinkedDocument(source, SCAFFOLD_URI);
  if (!linked) return [];
  const out: ScaffoldedPage[] = [];
  for (const { ui, call } of uiMacroCalls(linked.model)) {
    for (const opt of enumerateScaffoldPageUnfolds(linked.doc, call)) {
      const segments = opt.label.split(" / ");
      const pageName = segments[segments.length - 1] ?? opt.label;
      const areaName = segments.length > 1 ? segments[0] : undefined;
      out.push({
        key: segments.join("/"),
        label: opt.label,
        pageName,
        areaName,
        uiName: ui.name,
        macroName: call.name,
        edits: opt.result.edits,
      });
    }
  }
  return out;
}

/** Apply a scaffolded page's ejection edits to `source`.  Null when the
 *  result would not parse (the pane's write gate refuses it visibly). */
export function unfoldScaffoldedPage(source: string, page: Pick<ScaffoldedPage, "edits">): string | null {
  const doc = TextDocument.create(SCAFFOLD_URI, "ddd", 0, source);
  const next = TextDocument.applyEdits(doc, page.edits.map((e) => ({ range: e.range, newText: e.newText })));
  return ifParses(next);
}
