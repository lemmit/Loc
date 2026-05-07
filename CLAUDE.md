# Loom — index for agents

This file is a router. It points at the canonical docs; it does not
duplicate them. If something here disagrees with the linked file, the
linked file wins.

## Where to look

| Topic | File |
| --- | --- |
| What Loom is, project layout, status | [README.md](README.md) |
| Formal language reference | [docs/language.md](docs/language.md) |
| Per-platform generator feature matrix | [docs/generators.md](docs/generators.md) |
| Pipeline architecture (AST → IR → templates) | [docs/technical.md](docs/technical.md) |
| CLI, `.loomignore`, watch, Docker, Playwright | [docs/tools.md](docs/tools.md) |
| Auth / extern / views / workflow specifics | [docs/auth.md](docs/auth.md), [docs/extern.md](docs/extern.md), [docs/views.md](docs/views.md), [docs/workflow.md](docs/workflow.md) |
| Design retrospectives & gotchas | [experience_gathered.md](experience_gathered.md) |
| Sample `.ddd` sources | [examples/](examples/) (annotated walkthrough: [examples/acme.md](examples/acme.md)) |
| VS Code extension | [vscode/README.md](vscode/README.md) |

## How to run things

Scripts are defined in [package.json](package.json) — read it for the
authoritative list. The common ones: `langium:generate`, `build`,
`test`, `test:e2e`, `test:tsc`, `cli`.
