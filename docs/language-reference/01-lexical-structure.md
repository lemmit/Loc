# 1. Lexical structure

> **Grammar:** terminals (`ID`, `STRING`, `INT`, `DECIMAL`), `Model`, `ImportStmt` · **Validators:** — · **Docs:** [`../language.md`](../language.md)

The tokens and file-level structure beneath every other chapter: comments, identifiers, literals and how their delimiters are stripped, the soft-keyword rule, and multi-file source via `import`.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **Comments** — line `//` and block `/* */`.
- **Identifiers & casing** — what `ID` admits; how `src/util/naming.ts` re-cases names on emission.
- **Literals** — string (delimiter-stripped — `"USD"` → 3 chars), int, decimal, boolean, `null`. Note the re-quote-on-emission rule.
- **Soft keywords** — keywords reserved only in context (e.g. `kind`, `payload`, `paged`, `state`, `route`) that are valid identifiers elsewhere. Give the list and one example each way.
- **`import` & multi-file source** — `import "path.ddd"`, relative resolution, ambient vs context-local scope.
