// ---------------------------------------------------------------------------
// Auto-upgrade a hand-written `Table` over a PAGED read to server paging.
//
// `.all` is paged-by-default (M-T2.6).  The simplest thing an author can write —
//
//   QueryView { of: Api.Task.all, data: rows => Table { rows: rows, Column {…} } }
//
// — used to emit no pager and send no `page` param, so it rendered the
// backend's default first page (20 rows) with rows 21+ unreachable and nothing
// on screen saying so.  Same class as the Phoenix slice-8 defect ("hard-capped
// at the first 10 rows … rows 11+ unreachable"), and the last live consequence
// of the paged-by-default flip.
//
// This pass rewrites that body into the shape the SCAFFOLD already emits, so
// "a working paged table" has one definition rather than two:
//
//   state { pageNum: int = 1  sortKey: string = ""  sortDir: string = "asc" }
//   QueryView { of: Api.Task.all(pageNum, 20, sortKey, sortDir), paged: true,
//     data: rows => Table { rows: rows.items, page: pageNum, sortKey: sortKey,
//       sortDir: sortDir, serverPaged: true, totalPages: rows.totalPages, … } }
//
// WHY THE MACRO LAYER.  Page `state` is a structural declaration the page shell
// consumes, so the walker cannot add it — which is exactly why the scaffold
// does this as a macro.  And macros emit FINAL AST, so `unfold` ejects real
// `.ddd` source the author can edit; a walker-level rewrite would be invisible.
//
// WHY IT CAN DECIDE PAGED-NESS HERE.  `ensureFindAll` (enrichment) synthesises
// the paged `all` only when the repository declares none — so either the repo
// declares `find all` and its return type is right there in the AST, or the
// read is the synthesised paged one.  No type resolution needed.
//
// THE OPT-OUT IS TAKING CONTROL.  A `Table` that already carries `page:` or
// `serverPaged:`, a `QueryView` that already declares `paged:`, a read that
// already passes arguments, or a table over a plain array find — all left
// exactly as written.  Scaffolded pages carry their controls already, so they
// pass through this untouched and byte-identical.
// ---------------------------------------------------------------------------

import { type AstNode, AstUtils } from "langium";
import type {
  BuilderCall,
  BuilderEntry,
  Expression,
  FindDecl,
  Lambda,
  Model,
  Page,
  PostfixChain,
  StateBlock,
  Ui,
} from "../../language/generated/ast.js";
import {
  isArea,
  isBuilderCall,
  isLambda,
  isNameRef,
  isPage,
  isPostfixChain,
  isRepository,
  isStateBlock,
  isUi,
} from "../../language/generated/ast.js";
import { mkBuilderEntry } from "../api/_mk.js";
import { memberAccess } from "../api/factories.js";
import { _setContainer, _tag } from "../api/factories-internals.js";
import { boolLit, intLit, nameRefExpr, stateBlock, stringLit } from "../api/ui-factories.js";

/** Rows per page the synthesised read requests.  Matches the backend's own
 *  `PAGED_DEFAULT_PAGE_SIZE`, so the first render asks for exactly what an
 *  un-parameterised read was already getting — the page COUNT changes, the row
 *  window does not. */
const AUTO_PAGE_SIZE = 20;

/** Page-state field names the rewrite introduces.  `pageNum`, not `page`:
 *  `page` is now a legal identifier (M-T1.3 Defect B), but `pageNum` reads
 *  better beside `pageSize` and matches the scaffold, which is the shape this
 *  pass is deliberately converging on. */
const PAGE_FIELD = "pageNum";
const SORT_KEY_FIELD = "sortKey";
const SORT_DIR_FIELD = "sortDir";

/** Every `Page` under a ui, including those nested in `area` blocks. */
function pagesOf(ui: Ui): Page[] {
  const out: Page[] = [];
  const visit = (members: readonly unknown[]): void => {
    for (const m of members) {
      if (isPage(m)) out.push(m);
      else if (isArea(m)) visit(m.members);
    }
  };
  visit(ui.members);
  return out;
}

/** Every `BuilderCall` at or below `node`.
 *
 *  Uses Langium's `streamAllContents`, NOT a hand-rolled object walk: a
 *  `Reference`'s `.ref` points back at another AST node without a `$` prefix,
 *  so a naive recursion follows it up the tree and never terminates.  (The
 *  expander's own traversal carries the same warning.) */
function builderCallsIn(node: AstNode): BuilderCall[] {
  const out: BuilderCall[] = [];
  if (isBuilderCall(node)) out.push(node);
  for (const child of AstUtils.streamAllContents(node)) {
    if (isBuilderCall(child)) out.push(child);
  }
  return out;
}

const entry = (call: BuilderCall, name: string): BuilderEntry | undefined =>
  call.entries.find((e) => e.name === name);

/** Append a named entry to a builder call, wiring `$container` as the parser
 *  would have. */
function addEntry(call: BuilderCall, name: string, value: Expression): void {
  const e = _tag(mkBuilderEntry({ $type: "BuilderEntry", name, value }), undefined);
  _setContainer(value, e, "value");
  call.entries.push(e);
  _setContainer(e, call, "entries", call.entries.length - 1);
}

/** `<param>.<member>` — via the shared factory, so the node carries whatever
 *  `mkAst` sets up.  Hand-rolled object literals of the same SHAPE do not
 *  lower: the emitted read came out as `<expr>`. */
const memberOf = (param: string, member: string): PostfixChain =>
  memberAccess(nameRefExpr(param), member);

/** The aggregate + operation a `QueryView` `of:` expression reads, when it is a
 *  bare member chain (`Api.Task.all` / `Task.all`) with NO call suffix.  A read
 *  that already passes arguments is one the author is driving, so it returns
 *  undefined and the whole rewrite is skipped. */
function bareRead(of: Expression): { aggregate: string; operation: string } | undefined {
  if (!isPostfixChain(of)) return undefined;
  const suffixes = of.suffixes ?? [];
  if (suffixes.some((s) => s.$type === "CallSuffix")) return undefined;
  const members = suffixes.filter((s) => s.$type === "MemberSuffix") as { member: string }[];
  if (members.length === 0 || members.length !== suffixes.length) return undefined;
  const operation = members[members.length - 1]!.member;
  // `Api.Task.all` → aggregate is the second-to-last member; `Task.all` → the
  // chain head names it.
  const aggregate =
    members.length >= 2
      ? members[members.length - 2]!.member
      : isNameRef(of.head)
        ? of.head.name
        : undefined;
  return aggregate ? { aggregate, operation } : undefined;
}

/** Does `<aggregate>.all` return the paged envelope?  True unless the model
 *  declares its own `find all` with a non-paged return — see the header note on
 *  `ensureFindAll`. */
function allIsPaged(model: Model, aggregate: string): boolean {
  let declared: FindDecl | undefined;
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isRepository(node) || node.aggregate?.$refText !== aggregate) continue;
    for (const f of node.finds) {
      if (f.name === "all") declared = f;
    }
  }
  // No user-declared `all` ⇒ enrichment synthesises the paged auto-`findAll`.
  if (!declared) return true;
  return (declared.returnType?.ctors ?? []).includes("paged");
}

/** Merge the paging state fields into a page's `state {}`, creating the block
 *  when the page has none.  Existing fields of the same name win — a page that
 *  already declares `pageNum` is one the author is driving. */
function ensurePagingState(page: Page): void {
  const existing = page.props.find((p) => isStateBlock(p)) as StateBlock | undefined;
  const have = new Set((existing?.fields ?? []).map((f) => f.name));
  const wanted = (
    [
      { name: PAGE_FIELD, type: "int", init: 1 },
      { name: SORT_KEY_FIELD, type: "string", init: "" },
      { name: SORT_DIR_FIELD, type: "string", init: "asc" },
    ] as { name: string; type: "int" | "string"; init: number | string }[]
  ).filter((f) => !have.has(f.name));
  if (wanted.length === 0) return;
  const block = stateBlock(wanted);
  if (!existing) {
    page.props.push(block);
    _setContainer(block, page, "props", page.props.length - 1);
    return;
  }
  for (const f of block.fields) {
    existing.fields.push(f);
    _setContainer(f, existing, "fields", existing.fields.length - 1);
  }
}

/** Thread `(pageNum, 20, sortKey, sortDir)` onto the read, so a control change
 *  refetches instead of writing state nothing reads.
 *
 *  Rebuilt through `memberAccess` rather than by appending a `CallSuffix` to
 *  the existing chain: the receiver is everything up to the last member, and
 *  the factory produces the exact node the parser would. */
function withControls(of: PostfixChain): PostfixChain {
  const suffixes = of.suffixes as unknown as { $type: string; member: string }[];
  const last = suffixes[suffixes.length - 1]!;
  const receiver =
    suffixes.length === 1
      ? (of.head as Expression)
      : chainOf(
          of.head as Expression,
          suffixes.slice(0, -1).map((m) => m.member),
        );
  return memberAccess(receiver, last.member, {
    call: true,
    args: [
      nameRefExpr(PAGE_FIELD),
      intLit(AUTO_PAGE_SIZE),
      nameRefExpr(SORT_KEY_FIELD),
      nameRefExpr(SORT_DIR_FIELD),
    ],
  });
}

/** `head.a.b` — rebuild a bare member chain through the factory. */
function chainOf(head: Expression, members: readonly string[]): Expression {
  return members.reduce<Expression>((acc, m) => memberAccess(acc, m), head);
}

/** The one rewrite.  Returns true when it fired (for tests / diagnostics). */
function upgradeQueryView(model: Model, page: Page, qv: BuilderCall): boolean {
  // Author already opted into the envelope — their body reads `rows.items`
  // itself and drives its own controls.
  if (entry(qv, "paged") || entry(qv, "single")) return false;
  const ofEntry = entry(qv, "of");
  const dataEntry = entry(qv, "data");
  if (!ofEntry || !dataEntry) return false;
  const read = bareRead(ofEntry.value);
  if (!read || read.operation !== "all") return false;
  if (!allIsPaged(model, read.aggregate)) return false;
  if (!isLambda(dataEntry.value)) return false;
  const lambda = dataEntry.value as Lambda;
  const param = lambda.param;

  // Find a Table whose `rows:` is the bare data binding.  A body that already
  // slices or maps the rows is doing something this pass shouldn't second-guess.
  const table = builderCallsIn(lambda.body as AstNode).find((c) => {
    if (c.type !== "Table") return false;
    const rows = entry(c, "rows");
    return !!rows && isNameRef(rows.value) && rows.value.name === param;
  });
  if (!table) return false;
  // The author took control of paging — leave everything alone.
  if (entry(table, "page") || entry(table, "serverPaged")) return false;

  ensurePagingState(page);
  const controlled = withControls(ofEntry.value as PostfixChain);
  ofEntry.value = controlled;
  _setContainer(controlled, ofEntry, "value");
  addEntry(qv, "paged", boolLit(true));

  // The binding is now the ENVELOPE, so the table iterates its rows.
  const rowsEntry = entry(table, "rows")!;
  const items = memberOf(param, "items");
  rowsEntry.value = items;
  _setContainer(items, rowsEntry, "value");

  addEntry(table, "page", nameRefExpr(PAGE_FIELD));
  addEntry(table, "sortKey", nameRefExpr(SORT_KEY_FIELD));
  addEntry(table, "sortDir", nameRefExpr(SORT_DIR_FIELD));
  addEntry(table, "serverPaged", boolLit(true));
  addEntry(table, "totalPages", memberOf(param, "totalPages"));
  markSortableColumns(table);
  return true;
}

/** Give each `Column` whose accessor is a simple member read off the row a
 *  `sortable:`/`field:` pair, so the header can ask the server to order by it.
 *
 *  A column whose accessor COMPUTES its display is deliberately left alone:
 *  the backend's `sort` parameter is whitelisted per aggregate FIELD, so there
 *  is nothing for a computed column to sort by.  Leaving it unsortable is the
 *  correct answer, not a degradation. */
function markSortableColumns(table: BuilderCall): void {
  for (const e of table.entries) {
    if (e.name || !isBuilderCall(e.value) || e.value.type !== "Column") continue;
    const col = e.value;
    if (entry(col, "sortable") || entry(col, "field")) continue;
    const accessor = col.entries.find((c) => !c.name && isLambda(c.value));
    if (!accessor || !isLambda(accessor.value)) continue;
    const field = simpleMemberRead(accessor.value as Lambda);
    if (!field) continue;
    addEntry(col, "sortable", boolLit(true));
    addEntry(col, "field", stringLit(field));
  }
}

/** The field name an accessor lambda reads off its row param, for the two
 *  shapes that name exactly one column: `o => o.name` and `o => X { o.name }`.
 *  Anything else (a concat, a ternary, a nested chain) yields undefined. */
function simpleMemberRead(l: Lambda): string | undefined {
  const direct = (e: unknown): string | undefined => {
    if (!isPostfixChain(e as never)) return undefined;
    const chain = e as PostfixChain;
    if (!isNameRef(chain.head) || chain.head.name !== l.param) return undefined;
    const sfx = chain.suffixes ?? [];
    if (sfx.length !== 1 || sfx[0]!.$type !== "MemberSuffix") return undefined;
    return (sfx[0] as unknown as { member: string }).member;
  };
  const body = l.body;
  const own = direct(body);
  if (own) return own;
  // `o => Text { o.name }` — a single-child display primitive wrapping the read.
  if (isBuilderCall(body as never)) {
    const call = body as unknown as BuilderCall;
    const positional = call.entries.filter((c) => !c.name);
    if (positional.length === 1) return direct(positional[0]!.value);
  }
  return undefined;
}

/** Run the rewrite over every page of every ui in the model.  Called from the
 *  macro expander AFTER `with` expansion, so scaffold-generated pages are seen
 *  too — they already carry their controls, so they pass through untouched. */
export function autoPagePagedTables(model: Model): number {
  let fired = 0;
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isUi(node)) continue;
    for (const page of pagesOf(node)) {
      for (const prop of page.props) {
        for (const call of builderCallsIn(prop)) {
          if (call.type === "QueryView" && upgradeQueryView(model, page, call)) fired++;
        }
      }
    }
  }
  return fired;
}
