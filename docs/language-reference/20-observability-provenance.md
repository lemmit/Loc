# 20. Observability & provenance

> **Grammar:** `provenanced` modifier; observability is emitter-level · **Validators:** — · **Docs:** [`../observability.md`](../observability.md), [`../provenance.md`](../provenance.md)

Two cross-cutting runtime concerns the compiler wires automatically: the machine-parseable log-envelope catalog every backend emits identically, and the `provenanced` field modifier with `ddd snapshot` capture and the runtime trace SDK.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **The catalog envelope** — JSON shape (`ts`/`level`/`event`/`request_id`/…) and the event catalog; identical across all five backends.
- **`provenanced` fields** — assignment-lineage capture; per-backend `recordTrace` emission.
- **`ddd snapshot`** — immutable rule snapshot capture under `.loom/snapshots/`.
