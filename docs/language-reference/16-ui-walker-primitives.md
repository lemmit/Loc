# 16. UI: the walker primitive library

> **Grammar:** walker registry `src/generator/_walker/registry.ts`; `walker-stdlib.ts` · **Validators:** `walker-stdlib-completeness.test.ts` · **Docs:** [`../page-metamodel.md`](../page-metamodel.md), [`../design-packs.md`](../design-packs.md)

The closed primitive library page bodies are written in — layout, display, input, action and formatter primitives, plus the higher-level `Form`, `match`, `For`, and `QueryView`. These render per design pack; the tabs here pick the **framework** (react/vue/svelte) and where useful the **pack**.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **Layout primitives** — Stack, Group, Grid, Tabs/Tab, Card, Toolbar, Container, Paper, Breadcrumbs, Divider, Section, Sticky.
- **Display primitives** — Heading, Text, Bold/Italic/InlineCode, Badge, Stat, Empty, Anchor, Image, Avatar, Loader, Skeleton, Alert, KeyValueRow, Icon.
- **Input primitives** — Field, NumberField, PasswordField, MultilineField, Toggle, SelectField, Select, Fieldset.
- **Action primitives** — Action, Button, Modal.
- **Formatters** — Money, DateDisplay, EnumBadge, IdLink.
- **`Form`** — creates/runs/into; fields; onSubmit/then. Show the emitted form on two frameworks.
- **`For` / `QueryView`** — iteration with empty slot; async data with loading/error/empty/data.
- **`match` in markup** — predicate-arm conditional children; framework divergence (ternary vs if-block).
