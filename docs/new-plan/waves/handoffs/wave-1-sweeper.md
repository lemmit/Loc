# Wave 1 hand-off — 1h sweeper

*Branch: `claude/wave-1-sweeper` @ `a09157c`.*

## Row table

| item | outcome | proof: test file + assertion that fails when reverted | notes |
|---|---|---|---|
| `F2-CB-C9` (validator, `src/language/type-system.ts`) | **fixed** (`eb8d631`) | `test/language/type-system/domainservice-requires-typing.test.ts` — "a bool-returning domain-service op in a bare `requires` validates clean" fails `expected [ Array(1) ] to deeply equal []` (`"'requires' must be of type 'bool', got 'unknown'."`); "an int-returning domain-service op in a bare `requires` is refused with the bool message" fails to match `/got 'int'/`, showing `got 'unknown'` instead. 2 of 3 assertions fail under the mutation (the third — the `&& true` masking case — still passes under the mutation, exactly reproducing the pre-fix discrepancy the row names). | Applied the one-arm patch the hand-off note recommended verbatim (not the seven-gate `unknown`-suppression variant): `typeOfPostfixChain` gains a `<DomainService>.<operation>(...)` arm mirroring the `<Repository>.<method>(...)` arm directly above it, plus a `lookupDomainServiceByName` helper beside `lookupRepositoryByName`. The seven `must be of type 'bool'` gates are untouched. |
| `M-T1.26` vue + angular arms (`designs/**` pack templates) | **fixed** (`a09157c`) | `test/generator/_walker/image-avatar-attr-cross-target.test.ts`, new describe block "Image/Avatar src:/alt: — vue/angular, every pack (M-T1.26)" — 10 of its 15 assertions (the dynamic-image and ref-avatar checks, across all 5 packs) fail under the mutation below; the 5 literal-image assertions still pass. | See "M-T1.26 — how the fence was actually satisfied" below — the hand-off note's own exact-shape section named a `_walker/walker-core.ts` change as part of the fix; the sweeper found a template-only equivalent that needs none. |

## `F2-CB-C9` — what changed

`src/language/type-system.ts`:

```ts
// `<DomainService>.<operation>(...)` — the AST twin of the arm
// `lower-expr.ts` already has (`findDomainServiceByName` +
// `lowerType(opDecl.returnType)`).
if (isNameRef(expr.head) && first && isMemberSuffix(first) && first.call) {
  const svc = lookupDomainServiceByName(expr.head.name, env);
  const op = svc?.operations.find((o) => o.name === first.member);
  if (op?.returnType) {
    curType = resolveTypeRef(op.returnType);
    for (let i = 1; i < expr.suffixes.length; i++) {
      curType = typeAfterSuffix(curType, expr.suffixes[i]!, env);
    }
    return curType;
  }
}
```

plus `lookupDomainServiceByName` beside `lookupRepositoryByName`. Repro
before the fix:

```
operation cancel() { requires Rules.isCancellable(this.qty) }
  -> error: 'requires' must be of type 'bool', got 'unknown'.
operation cancel() { requires Rules.isCancellable(this.qty) && true }
  -> 0 error(s), 0 warning(s).  OK
```

After: both validate clean when `isCancellable` returns `bool`; both
uniformly refuse (naming `'int'`, not `'unknown'`) when the called operation
returns `int` instead.

## `M-T1.26` — how the fence was actually satisfied

The hand-off note's "exact shape for whoever picks this up" named THREE
moves: (1) a `srcAttr`/`altAttr` full-fragment builder in
`_walker/walker-core.ts` (a `navAttrFragment` sibling), (2) every pack's
`primitive-image.hbs`/`primitive-avatar.hbs` splicing `{{{srcAttr}}}`
instead of hardcoding ` src={{{src}}}`, and (3) `text.ts` passing a
`srcAttr`/`altAttr` closure mirroring `emitAnchor`'s `navAttr` field. Moves
(1) and (3) are both inside `_walker/**` — off-limits (PR #2729 owns it).

Reading `navAttrFragment` confirmed it's already framework-generic (`name:
string` is a parameter, not hardcoded), so the missing piece is genuinely
just data: the template needs to know whether a given `src`/`alt` string is
a literal or a computed expression, and — for the dynamic case — needs the
value properly quoted/escaped for splicing into a bound attribute. Neither
requires a `WalkContext`:

- **Literal vs. dynamic, without a flag from `text.ts`**: `text.ts`'s
  `attrArgValue` already hands the template EXACTLY the raw JS text —
  `JSON.stringify(value)` for a literal, `emitExpr(...)`'s output for a
  dynamic value — and never wraps it for vue/angular (only react/svelte get
  brace-wrapped). A literal string is *exactly* `JSON.stringify`'s output,
  which round-trips through `JSON.parse`/`JSON.stringify` unchanged; a
  dynamic expression can only pass that round-trip if it IS, character for
  character, also a bare quoted string — in which case treating it as a
  literal is still correct (both shapes evaluate to the identical value).
  So the literal/dynamic distinction is recoverable from the string alone,
  with no unsafe case.
- **Quoting the dynamic case**: mirrors `quoteAttrExpr` (vue-target.ts) /
  the inline equivalent (angular-target.ts) — pick the delimiter the
  expression itself doesn't use, entity-escape only when it carries both,
  relying on the SAME "Vue/Angular decode HTML entities in an attribute
  value before compiling the bound expression" behaviour those two files'
  own comments already document and depend on.

Both live as two small, self-contained functions
(`isJsonStringLiteral`/`quoteJsExprForAttr`) behind two new Handlebars
helpers (`vueAttr`/`ngAttr`) in `src/generator/_packs/loader.ts` — not
`_walker/**`, not a duplicate of the `_walker/**` machinery reused
(`navAttrFragment` itself needs a full `WalkContext` no Handlebars helper
has access to, so it couldn't be called directly; this is a parallel
implementation of the same *policy*, not the same *code path* — flagging
that as a documented, deliberate duplication rather than a DRY violation
nobody noticed).

Sample output (`Image { src: "/img/" + slug, alt: "Photo" }`,
`Avatar { src: slug, alt: "User" }`, `Image { src: "/logo.png" }`):

```
vue (shadcnVue):     <img class="rounded-md" :src='("/img/" + slug)' alt="Photo" />
vue avatar:           <img class="h-full w-full object-cover" :src="slug" alt="User" />
vue literal:          <img class="rounded-md" src="/logo.png" alt="Static" />
angular (any pack):  <img class="loom-image" [src]='("/img/" + slug)' alt="Photo" />
angular avatar:        <img class="loom-avatar" [src]="slug" alt="User" />
angular literal:       <img class="loom-image" src="/logo.png" alt="Static" />
```

The literal case is byte-identical to before on every pack (verified: the
pre-existing pinned angular test in `test/generator/angular/walked-pages
.test.ts` — `'<img class="loom-avatar" src="/a.png" alt="user" />'` — still
passes unmodified).

**Ledger note for the coordinator**: M-T1.26 can now close as **fully
fixed** on all six JS-family targets (react/svelte/feliz/flutter from
packet 1e, vue/angular from this hand-off) — no targets remain silently
wrong. The `docs/new-plan/T1-ui-frontend.md` M-T1.26 status line should
move from "react/svelte/feliz/flutter fixed, vue/angular need a
`designs/**` pack template change" to fully done.

## Mutation proofs (file-copy revert, never `git checkout --`)

- **`F2-CB-C9`**: copied `src/language/type-system.ts` aside, removed the
  new arm + helper by string-splice, ran
  `domainservice-requires-typing.test.ts` — 2/3 tests failed exactly as
  named above (`got 'unknown'` in both), restored by copy-back, `tsc -b`
  clean again.
- **`M-T1.26`**: copied `src/generator/_packs/loader.ts` aside, mutated
  `bindableAttrFragment` to always splice raw (the exact pre-fix template
  shape — ` ${name}=${value}` unconditionally, no literal/dynamic branch),
  ran `image-avatar-attr-cross-target.test.ts` — 10/28 failed (all 5 packs'
  dynamic-image + ref-avatar assertions; the literal-image and
  react/svelte/feliz/flutter assertions stayed green, as expected since the
  mutation only touches the new vue/angular helper), restored by copy-back,
  `tsc -b` clean again, re-ran the same test — 28/28 green.

## Local gates run + results

- `npx tsc -b` — clean, after every edit and after both restores.
- `npx vitest run test/language test/ir/requires* test/system/diagnostic-catalog.test.ts test/language/type-system/domainservice-requires-typing.test.ts` — **186 test files, 1867 tests passed, 2 skipped, 0 failed**. (`test/ir/requires*` matches no files on this base — nothing named that way exists; not a gap I introduced.)
- `npx vitest run test/generator/vue test/generator/angular` — **70 test files, 360 tests passed, 0 failed.**
- `npx vitest run test/generator/_walker/image-avatar-attr-cross-target.test.ts` — **28/28 passed** (18 pre-existing + 10 new vue/angular-per-pack).
- `npx vitest run test/platform/pack-required-primitives.test.ts test/platform/pack-render-reachability.test.ts test/platform/pack-manifest.test.ts test/platform/vue-pack-groundwork.test.ts test/platform/angular-pack-groundwork.test.ts test/generator/vue/shadcn-vue-pack.test.ts test/generator/a11y-contract-cross-pack.test.ts` — **51/51 passed** (the required-emits / pack-completeness gates named in the brief).
- `npx biome ci <7 changed TS/test files>` — clean, 0 errors, 0 warnings (one formatting fix applied via `biome check --write` on `loader.ts`, then re-verified clean).
- Did **not** run the full `npm test` per the brief.

## Ledger closes (ids)

- `F2-CB-C9-requires-unknown-message` — close. Fixed exactly per the recommended one-arm patch; no suppression variant, no other gate weakened.
- `M-T1.26` (`docs/new-plan/T1-ui-frontend.md`) — close as **fully fixed** (react/svelte/feliz/flutter from packet 1e + vue/angular from this hand-off = all six JS-family targets). Update the mission doc's status line accordingly.

## Notes for the coordinator

1. **Item 2's "designs/** pack templates only" framing undersold the fix's
   real shape** — the note item 2 was built from named a change to
   `_walker/walker-core.ts` as part of the exact-shape recipe, which
   directly conflicts with "do not touch `_walker/**`". The conflict was
   resolvable: `navAttrFragment` turned out to need a full `WalkContext`
   only `_walker/**` code has, so it couldn't be reused directly from a
   Handlebars helper — but the underlying POLICY (literal-vs-dynamic
   detection + attribute quoting) doesn't actually need one, and reimplementing
   it as two small pure functions in `src/generator/_packs/loader.ts` (not
   `designs/**`, not `_walker/**`) closed the gap without touching either
   fenced area. Worth flagging for future fence-scoped hand-offs: "the note
   says exactly which files" can still be a plan that turns out to route
   through a file nobody named, once you trace why the naive template-only
   fix doesn't work.
2. **No `test/ir/requires*` files exist on this base** — the task's named
   test-run list included that glob; it currently matches nothing. Not a
   regression from this session (verified before touching anything);
   flagging in case it's meant to exist and quietly stopped matching at
   some point, or the glob in the brief was aspirational.
