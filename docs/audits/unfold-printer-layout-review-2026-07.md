# Unfold / structural-printer layout review — 2026-07

Snapshot-in-time review of what `Unfold macro` / `Unfold page` actually writes back
into a `.ddd` file, run against fresh `main` (2f5deb8) via the real LSP code action
plus direct `printStructural` calls.

**Verdict:** structure is correct and (with one exception) the output re-parses; what
is broken is *layout* — and it is worst exactly where the UI lives, because lambdas
(`data: rows => …`, `onClick: e => { … }`), `match`, and nested statement blocks are
the dominant page-body constructs.

## Defects

### 1. `match` statement arms print `;` separators that do not re-parse — CORRECTNESS

`src/language/print/print-stmt.ts` — `MatchStmt`'s `armText` joins an arm body with
`"; "`:

```ddd
match await self.calc() {
  int v => { let a = v; let b = v }
}
```

Re-parse: `Expecting token of type '}' but found ';'`.  The grammar
(`VariantStmtArm`, `ddd.langium`) is `'{' body+=Statement* '}'` — there is no `;`
separator in the statement grammar.  Any multi-statement match arm — the `match
await` shape from `docs/actions.md`, the primary UI action idiom — ejects
unparseable source.  Escapes the existing round-trip gate because no fixture has a
two-statement arm.

### 2. Lambda block bodies get zero indentation

`printLambda` (`print-expr.ts`) joins statements with a bare `\n`:

```ddd
Button(
  "Go",
  onClick: e => {
  count := count + 1
  let t = count
  }
)
```

### 3. Nested statement blocks mangle indentation

`ForStmt` / `IfLetStmt` / `MatchStmt` prefix `"  "` onto each child statement's
**first line only**, so a multi-line child's continuation lines and closing brace
land at the parent's depth:

```ddd
for x in lines {
  for y in lines {
  let z = x.q + y.q
  if let q = z {
  let w = q
} else {
  let w = 0
}
  }
  }
```

### 4. `match` expression arms are not indented

```ddd
Text(
  match {
  count > 3 => "many",
  count > 1 => "some",
  else => "none"
  }
)
```

### 5. The 100-column wrap budget is indent-blind

`wrapArgList` / `wrapBraced` measure the one-line form from column 0, but the result
is later indented by `block()` / `indent()` and again by unfold's `memberIndent`.
Real overflow in the shipped scaffold `Home` page (104 columns):

```ddd
          Card(Heading("1 aggregate", level: 4), Text("Manage records of each kind from the sidebar.")),
```

### 6. Inline-brace insert leaves trailing whitespace

`buildInsertEdit`'s inline-`}` branch inserts at the brace position, so the original
`{ }`'s space survives as a trailing space:

```
  ui Admin with scaffoldAggregate(of: Order), scaffoldWorkflow(of: Fulfil) {␠
```

Every unfold into an empty body emits it.

### 7. No blank line between ejected declarations

`block()` and the insert edit both join with a single `\n`, so unfolding a `ui`
ejects 5–7 pages as one undifferentiated wall:

```ddd
      menu {
        hidden: true
      }
    }
    page WorkflowsIndex {
```

The repo's own `.ddd` (e.g. `examples/acme.ddd`) blank-line-separates declarations.

### 8. Unfolding into a single-line body strands the existing members

Found on a second pass over the NON-UI hosts (`with crudish` / `with auditable`
on an aggregate whose body is written on one line). Splitting only at the `}`
left the body's existing member up on the header line while every inserted
member landed indented below it:

```ddd
aggregate Order with auditable { subject: string }
```
```ddd
aggregate Order { subject: string
  createdAt: datetime managed
  updatedAt: datetime managed
}
```

Parses, but reads as two different files. This is the "unfolds inline" shape.

## Fix plan — all eight landed

| # | Fix | Files |
|---|---|---|
| 1 | Match-arm bodies print as a real indented block (`stmtBlock`); the one-line `{ stmt }` form survives only for a single single-line statement. | `print-stmt.ts` |
| 2–4 | Every block body routes through the shared `indentBlock()` instead of first-line prefixing. | `print-expr.ts`, `print-stmt.ts` |
| 5 | An ambient print column (`withIndent` / `atColumn` in `print-expr.ts`) that `wrapArgList`/`wrapBraced` budget against. The `block`/`declBlock`/`commaBlock` helpers take a THUNK so they can run the item printers inside their own indent; `unfold-macro.ts` seeds the column with `memberIndent.length`. | `print-expr.ts`, `print-stmt.ts`, `print-structural.ts`, `unfold-macro.ts` |
| 6 | The inline-`}` insert replaces the whitespace before the brace instead of inserting at it. | `unfold-macro.ts` |
| 7 | `joinDecls` blank-line-separates a member from its neighbour when either spans multiple lines; only declaration CONTAINERS opt in (`declBlock`), so page props and field runs stay tight. | `print-structural.ts`, `unfold-macro.ts` |
| 8 | A block that opens AND closes on one line is reflowed: existing content moves down to member indent (relocated as one line — its tokens are never re-wrapped), then the printed members, then the `}`. A body already spanning lines keeps the plain split. Both insert paths pick the separator with the same `joinDecls` rule, so `with crudish` (multi-line first member) gets a blank line and `with tenantOwned` (one-line fields) stays tight. | `unfold-macro.ts` |

### Why the column budget is exact, not a heuristic

A nested item is always printed at `currentCol + 2` — where it lands *if* its
parent wraps. If the item came back multi-line the parent is forced to wrap (the
existing `includes("\n")` rule), so that is where it really sits; if it came back
single-line, the parent's own `currentCol + oneLine.length <= LINE_WIDTH` check
bounds the whole line. Neither branch can exceed the budget.

## Tests

- `test/language/print/print-block-layout.test.ts` — the three block-layout cases
  the corpus round-trip gates never exercised (multi-statement match arm, lambda
  block body, doubly-nested loop), each pinned to exact output plus a re-parse.
- `test/macro/unfold-layout.test.ts` — runs the real code action over every
  offered unfold and asserts: no trailing whitespace, blank-line-separated
  declarations, no blank line opening a block, no line past 100 columns, and a
  clean re-parse. Plus the single-line-body reflow (defect 8) on both the
  macro (`crudish`) and capability (`tenantOwned`) paths.

One pre-existing assertion moved from an exact string to a wrap-insensitive one
(`scaffold-body-builders.test.ts`): it pinned a `Column(…)` on one line, and
that call sits deep enough that the now-indent-aware budget correctly wraps it.
The assertion is about *what* the builder emits, not where the line breaks.
