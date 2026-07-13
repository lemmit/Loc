# String composition — template literals, ICU, and the concatenation ban

> Status: **proposal**. Companion to [`i18n.md`](./i18n.md). Closes that
> proposal's open question #4 (concatenation in user-visible slots) and
> defines the only user-visible string surface for the DSL going forward.

## Problem

The parent proposal extracts user-visible strings from `.ddd` source into
an ICU JSON catalog. That works cleanly for self-contained literals
(`Heading { "Action showcase" }`), but the DSL today also allows:

```ddd
Heading { "Order " + order.id }
```

Translating `"Order "` independently to `"Commande "` and concatenating
at runtime *accidentally* works for French. It silently breaks for every
language whose grammar doesn't match English's "noun then identifier"
order. This note defines the surface that makes that case impossible to
write.

## Why `+` is fatal at the language boundary

Five concrete failure modes a fragment-and-concatenate approach cannot
recover from:

1. **Word order.** Japanese natural form: `12345 番の注文`, not
   `注文 12345`. Concatenation pins the variable to the right side; the
   language wants it on the left. Translators cannot fix this without
   reshaping the whole sentence.
2. **Plural agreement.** English `1 Order` vs `2 Orders`; Russian has
   three plural classes (`1 заказ`, `2 заказа`, `5 заказов`); Arabic
   has six. ICU
   `{count, plural, one {Order} other {Orders}}` selects the right
   form per locale per value at render time. `+` can't.
3. **Grammatical gender / agreement.** "Cancelled order" → French
   *Commande annulée* (feminine `-e`); "Cancelled job" → *Travail
   annulé* (masculine, no `-e`). Pre-translating a shared "Cancelled"
   fragment loses the agreement context every time.
4. **Number / date / currency formatting.** `order.id.toString()` calls
   JS `Number.prototype.toString` with system defaults (grouping by
   commas, ASCII digits). ICU `{id, number}` respects locale: French
   non-breaking space as thousands separator, Bengali native digits,
   Arabic right-to-left rendering.
5. **Bidirectional text isolation.** Mixing LTR variable values into
   RTL strings (or vice-versa) requires Unicode direction marks
   (U+2068/U+2069) around the substitution. The runtime can insert them
   when it knows where placeholders sit in the message; with `+`-concat
   the placement is structural and unrecoverable.

Any one of these would be enough; together they make whole-message
authoring not a stylistic preference but a correctness requirement.

## The surface — template literals are the only form

In a user-visible slot, an author writes one of:

**Template literal (sugar, recommended default).**
```ddd
Heading { "Order ${order.id}" }
Empty   { "${count} orders pending" }
Toast   { "Updated ${order.id} — total ${order.total, number, ::currency/USD}" }
```

**Explicit ICU + values (escape hatch).**
```ddd
Heading { "Order {orderId}", orderId: order.id }
```

Both forms lower to the same `ICUMessageIR`:

```ts
type ICUMessageIR = {
  kind: 'ICUMessage';
  template: string;            // "Order {id}"
  params: Record<string, ExprIR>;
  source: SourceRef;
};
```

The template literal is the recommended default — concise, familiar to
anyone who has used JS or C# interpolation. The explicit form exists for
three cases:

- The derived placeholder name collides with another in the same
  template.
- The author wants a more meaningful name (`{customerName}` instead of
  the derived `{name}`).
- The expression has no obvious identifier to derive a name from
  (`${formatTotal(order)}`).

## Format suffixes pass through to ICU verbatim

ICU MessageFormat already has the vocabulary for everything users
realistically need to format. Loom does not invent a parallel syntax —
the part after the comma inside `${…}` is the ICU format suffix:

```ddd
// numbers, currencies, percentages
"${order.total, number, ::currency/USD}"
"${conversion, number, ::percent}"

// dates and times
"${order.createdAt, date, ::yMMMd}"
"${meeting.startsAt, time, short}"

// plurals — '#' is the plural variable inside the branch
"${count, plural, one {# order} other {# orders}}"

// selectors on any string-valued expression
"${order.status, select, cancelled {Cancelled} shipped {Shipped} other {Pending}}"
```

What the author writes maps one-to-one onto what the catalog stores and
what the translator edits. No translation between Loom-syntax and
ICU-syntax. Pass-through means an author who already knows ICU is
immediately productive; an author who doesn't can ignore the suffix
forms until they need plurals, at which point they learn standard ICU
once and it works in every other ICU-using tool they touch.

## Composition without concatenation

The author's instinct on hitting the concat ban will be "but how do I
glue together a fixed prefix and a variable suffix?" The answer is:
don't. Write the whole sentence as one message.

Two sub-cases worth being concrete about:

**Branching content.** Different prefixes per case — use ICU `select`:

```ddd
Text { "${order.status, select,
          cancelled {Cancelled order #${order.id}}
          other     {Order #${order.id}}
        }" }
```

ICU's `select` and `plural` *are* the composition primitive. The DSL
does not need a separate operator for joining translatable pieces;
adding one would re-open the door this design is closing.

**Domain-driven branching.** When the branch logic is genuinely domain
logic (not language-level selection), use the DSL's `match`:

```ddd
Text {
  match order.status {
    Cancelled -> "Cancelled order #${order.id}"
    Shipped   -> "Shipped order #${order.id}"
    _         -> "Order #${order.id}"
  }
}
```

Each branch contributes its own catalog entry. The translator sees three
whole-message strings, edits each independently, and there is never a
fragment translated out of context.

Use `match` when the cases are domain concepts; use ICU `select` when
they're language-level cosmetic variations. The choice is the same one
authors already make between domain-level conditionals and view-level
ones; i18n doesn't introduce a new question.

## Rejecting `+` in user-visible slots

A new validator at [`src/language/validators/strings.ts`](../../../src/language/validators/)
walks the AST in phase ④. For every `BinaryExpr { op: '+' }` whose
ancestor is a `StringLitIR` slot tagged `userVisible: true`, it emits:

```
Heading { "Order " + order.id }
                  ^^^^^^^^^^^^
error[loom.user-visible-concat]: string concatenation in a user-visible
  slot produces output that cannot be translated to languages with
  different word order, plural rules, or formatting conventions.

  Rewrite with template interpolation:

    Heading { "Order ${order.id}" }

  See: docs/old/proposals/i18n-strings.md
```

A code action (quickfix) would be welcome but is not a v1 requirement.
The AST transformation is mechanical — walk the `+`-chain, collect
literals and non-literals, emit a single `TemplateLit` with literals as
the static parts and non-literals as the holes — so it's a candidate
for a future LSP improvement.

The diagnostic fires *only* on user-visible slots. Domain-level concat
(`"audit:" + actorId` deep inside an emit, log message construction in
infrastructure code) stays untouched: `userVisible` is a per-slot bit
set in the walker registry, not a global property of `+`.

## Placeholder name derivation

`"Order ${order.id}"` needs to become the template string `"Order {id}"`.
The derivation rule:

| Source expression in `${…}` | Derived placeholder name |
|---|---|
| Bare identifier: `${count}` | `count` |
| Dotted path: `${order.id}` | `id` (last segment) |
| Nested path: `${order.customer.name}` | `name` (last segment) |
| Call: `${formatTotal(order)}` | `arg0`, `arg1`, … (positional fallback) |
| Same derived name twice in one template | First wins; subsequent get `_2`, `_3` suffix |

Authors who hit the positional-fallback case are nudged (warning, not
error: `loom.unnamed-placeholder`) to switch to the explicit form so the
catalog reads well to a translator.

## Key stability under field renames — the thorny part

Content-hashing the template string into the key has a wrinkle here. If
the author writes `"Order ${order.id}"` today, derives `"Order {id}"`,
hashes that to key `page.X.heading.a3f2`, and a translator translates
it — then tomorrow renames the field `order.id → order.orderNumber` —
the template derives to `"Order {orderNumber}"`, hashes to a *different*
key, and the translation is lost in a delete-old + add-new diff.

Field renames are common (much more than string rephrases). Treating
them as catalog churn is too noisy.

Three options:

| | Option A: live with churn | Option B: hash positional, render named | Option C: require explicit naming for stability |
|---|---|---|---|
| Catalog readability | Good — `{id}` | Good — `{id}` | Good — `{orderId}` |
| Survives field rename | No (carry-forward on sync) | Yes (sync rewrites name in OURS) | Yes |
| Cost on sync | Same as source-string rename | Parse ICU, rename one placeholder, re-serialise OURS | Nothing — author chose stability |
| Author burden | None | None | One annotation per stability-critical string |

**Recommendation: B as default, C as escape hatch.** Hash the template
with placeholders normalised to positional (`"Order {0}"` for hashing
purposes; `"Order {id}"` for catalog display and runtime). A field
rename leaves the hash stable; sync rewrites the placeholder name
inside OURS automatically (using `@formatjs/icu-messageformat-parser`,
already a transitive dep of `react-intl`). For strings where churn must
be impossible — marketing copy, legal notices, anything with editorial
oversight — authors use named `text { … }` entries with the explicit
form:

```ddd
context Marketing {
  text {
    orderConfirmation: "Order {orderId} confirmed"
  }
}
```

The named entry has a stable key (`text.Marketing.orderConfirmation`),
and the explicit placeholder name (`{orderId}`) was chosen by the author
rather than derived — so neither structure-hash nor placeholder-name
churn can touch it.

## What the sync sees

Three concrete scenarios:

**Field rename, default (option B).**

```
BASE     "page.X.heading.a3f2": "Order {id}"
THEIRS   "page.X.heading.a3f2": "Order {orderNumber}"
OURS fr  "page.X.heading.a3f2": "Commande {id}"
         ↓ sync: same key, placeholder rename
OURS fr  "page.X.heading.a3f2": "Commande {orderNumber}"
```

Translator's work preserved; placeholder name rewritten mechanically.
The diff in the PR shows one rename; no `TODO:` markers.

**True source-string change.**

```
BASE     "page.X.heading.a3f2": "Order {id}"
THEIRS   "page.X.heading.b7c1": "Order management for {id}"   (different hash)
OURS fr  "page.X.heading.a3f2": "Commande {id}"
         ↓ sync: delete-old + add-new
OURS fr  "page.X.heading.b7c1": "TODO: Order management for {id}"  (carry forward offered)
```

The sync prompt offers to carry the old translation forward as a
starting point (with a `(was: Order {id})` annotation). Translator
accepts or edits.

**Named entry, source-string change.**

```
BASE     "text.Marketing.orderConfirmation": "Order {orderId} confirmed"
THEIRS   "text.Marketing.orderConfirmation": "Order {orderId} successfully placed"
OURS fr  "text.Marketing.orderConfirmation": "Commande {orderId} confirmée"
         ↓ three-way merge: stable key, value differs across all three
OURS fr  "text.Marketing.orderConfirmation":
<<<<<<< OURS
           "Commande {orderId} confirmée"
||||||| BASE
           "Order {orderId} confirmed"
=======
           "Order {orderId} successfully placed"
>>>>>>> THEIRS
```

Translator opens, resolves, commits. Standard merge muscle memory; CI
catches unresolved markers (JSON parser fails).

## Implementation cost

Folds into the parent proposal's phasing without slipping the schedule:

- **Phase 1** needs `TemplateLitIR → ICUMessageIR` lowering anyway to
  build the catalog. Add the placeholder-name derivation in the same
  walk (≈ 80 LoC).
- **Phase 1** also gains the `loom.user-visible-concat` validator
  (≈ 50 LoC, mirrors the shape of existing validators in
  [`src/language/validators/`](../../../src/language/validators/)).
- **Phase 2** (React runtime) already needed `<FormattedMessage>`
  emission; the values map comes from `ICUMessageIR.params` directly.
- **Phase 3** (sync CLI) gets the **placeholder-rename rewriter** as a
  small post-merge step (≈ 60 LoC over the ICU parser).
- Catalog content-hash function normalises placeholders to positional
  before hashing — a single function (≈ 30 LoC) used in `enrichments.ts`
  and the sync CLI.

Total marginal cost over the parent proposal: ≈ 220 LoC of generator
code plus one new validator plus a half-dozen targeted tests. The
acceptance gate is byte-identical fixture output plus the existing
`LOOM_REACT_BUILD=1` smoke that the generated app type-checks with
`<FormattedMessage>` for every previously-string slot.

## Worked example — a real page before and after

Before (today, broken under translation):

```ddd
page OrderShow(o: Order) {
  Heading { "Order " + o.id }
  Text    { "Customer: " + o.customer.name }
  Text    { "Total: " + o.total + " " + o.currency }
  Text    { "Status: " + o.status }
  Empty   { "No items found for order " + o.id }
}
```

After (this proposal, translation-ready):

```ddd
page OrderShow(o: Order) {
  Heading { "Order ${o.id}" }
  Text    { "Customer: ${o.customer.name}" }
  Text    { "Total ${o.total, number, ::currency/${o.currency}}" }
  Text    { "${o.status, select,
               cancelled {Cancelled}
               shipped   {Shipped}
               other     {Pending}
             }" }
  Empty   { "No items found for order ${o.id}" }
}
```

Catalog (English, auto-extracted):

```json
{
  "page.OrderShow.heading.…": "Order {id}",
  "page.OrderShow.text.0.…":  "Customer: {name}",
  "page.OrderShow.text.1.…":  "Total {total, number, ::currency/{currency}}",
  "page.OrderShow.text.2.…":  "{status, select, cancelled {Cancelled} shipped {Shipped} other {Pending}}",
  "page.OrderShow.empty.…":   "No items found for order {id}"
}
```

French (translator-edited):

```json
{
  "page.OrderShow.heading.…": "Commande {id}",
  "page.OrderShow.text.0.…":  "Client : {name}",
  "page.OrderShow.text.1.…":  "Total {total, number, ::currency/{currency}}",
  "page.OrderShow.text.2.…":  "{status, select, cancelled {Annulée} shipped {Expédiée} other {En attente}}",
  "page.OrderShow.empty.…":   "Aucun article trouvé pour la commande {id}"
}
```

Every string is a whole sentence in the translator's language. Word
order, gender agreement (`Annulée` vs `Annulé` chosen per status),
number formatting, and the placeholder positions are all under the
translator's control — not the original developer's.

That's the entire point of this note: the *original developer's
sentence structure* must not be the *translator's prison*.
