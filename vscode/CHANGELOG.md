# Loom DDD — Changelog

## 0.1.0 — initial release

- Syntax highlighting for `.ddd` files (TextMate grammar generated
  by Langium).
- LSP-backed hover, go-to-definition, completion, and workspace
  symbols for aggregates, entity parts, value objects, enums,
  events, repositories, modules, and deployables.
- Member-access completion: typing `.` on a typed receiver
  suggests properties, containments, derived, functions, magic `id`,
  collection ops on arrays, `length` on string, and enum values
  on enum names.
- "Loom: Generate from current file" command palette entry.
