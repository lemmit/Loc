# 13. Workflows

> **Grammar:** `Workflow`, `create`/`handle`/`on`/`apply`, `eventSourced`, `transactional` · **Validators:** workflow checks in `src/ir/validate/checks/workflow-checks` · **Docs:** [`../workflow.md`](../workflow.md)

Context-level orchestration: the `create`/`handle`/`on`/`apply` member set, state fields, `eventSourced` and `transactional` modifiers with isolation levels, and consuming resources (object stores, queues, external APIs) from a workflow body.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **`workflow` & state** — declaration; state fields, derived, invariant, function.
- **`create` / `handle`** — starter (command- or event-triggered `by`) and continuation commands.
- **`on(e: Event)`** — event reactor; correlation via `by`.
- **`apply` (eventSourced)** — pure fold for `eventSourced` workflows.
- **`transactional` & isolation** — all-or-nothing; `readUncommitted`..`serializable`.
- **Body vocabulary** — `let x = Repo.…`, `for`, `if let`, calls, `emit`, guards.
- **Resource consumption** — objectStore (`put`/`get`/…), queue (`enqueue`/`dequeue`), external api (`get`/`post`), replica (`query`/`execute`).
