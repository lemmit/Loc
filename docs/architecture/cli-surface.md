# `ddd` CLI surface — sub-command extension model

> Convention spec. Status: describes the shipped command set
> (`src/cli/main.ts`, Commander-based) and pins how new sub-commands
> (next up: `ddd i18n`) attach.

## Shipped commands

| Command | Role |
|---|---|
| `ddd parse <file>` | parse + validate; non-zero exit on diagnostics |
| `ddd generate ts <file> -o <out>` | single Hono project (legacy single-context) |
| `ddd generate dotnet <file> -o <out>` | single .NET project (legacy) |
| `ddd generate system <file> -o <out>` | full multi-deployable tree + `docker-compose.yml` |
| `ddd verify <file> -o <out>` | run generated suites → traceability rollup → `.loom/verification.{json,md}` |
| `ddd snapshot <file> -o <out>` | capture immutable provenance rule snapshot under `.loom/snapshots/` |

Common flags: `-o/--out`, `-w/--watch` (legacy generate only),
`--dry-run` (print the `write`/`skip` plan, touch nothing).

## Command taxonomy

Sub-commands fall into three shapes; a new command should declare which
it is, because the shape dictates its flag contract and exit semantics:

| Shape | Reads | Writes | Exit |
|---|---|---|---|
| **check** (`parse`) | `.ddd` | nothing | non-zero on diagnostics |
| **emit** (`generate`, `verify`) | `.ddd` | files under `-o` | non-zero on diagnostics or generation failure |
| **steward** (`snapshot`, future `i18n sync`) | `.ddd` + an existing tracked artefact | updates that artefact deliberately | non-zero on conflict |

**emit** commands must honour `--dry-run` (print plan, touch nothing)
and must be idempotent (re-running with no source change is a no-op
diff). **steward** commands mutate author-owned, version-controlled
state (snapshots, locale catalogs) and are therefore run *deliberately*,
never on every build — they are the `ef migrations add` of Loom, not
part of `generate`.

## Adding a sub-command

1. Add the Commander command in `src/cli/main.ts` (or a sub-module under
   `src/cli/<area>/` for multi-verb groups — `i18n.md` puts its verbs in
   `src/cli/i18n/`).
2. Declare its taxonomy shape and honour that shape's flag contract
   (`--dry-run` for emit; deliberate-run + conflict exit for steward).
3. Keep the command **thin** — it parses args and calls into the
   toolchain library (`@loom/core` / `src/`); no domain logic in the CLI
   layer. The browser playground re-invokes the same library entry
   points without the CLI, so logic in `main.ts` is logic the playground
   can't reach.
4. Diagnostics use the `loom.*` codes from
   [`diagnostic-catalog.md`](./diagnostic-catalog.md); exit code derives
   from the highest diagnostic severity.
5. Add a `test/cli/<command>.test.ts`.

## Next sub-command: `ddd i18n` (i18n.md)

A multi-verb **steward** group:

| Verb | Role |
|---|---|
| `ddd i18n init` | scaffold `<repo>/locales/` + `.loom/source.lock.json` |
| `ddd i18n sync` | three-way merge (BASE = source.lock, OURS = translator file, THEIRS = current source) → updated locale files + refreshed lock |

Both write under the author-owned `<repo>/locales/` tree (never under
the generated `out/`), exit non-zero on unresolved merge conflict, and
are opt-in — `ddd generate` only *copies* resolved catalogs into the
output, it never reconciles. This is the steward contract above.
