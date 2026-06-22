# 14. APIs, storage, resources & channels

> **Grammar:** `Api`, `Storage`, `Resource`, `Channel`, `ChannelSource` · **Validators:** kind↔storage compatibility matrix · **Docs:** [`../resources.md`](../resources.md), [`../architecture.md`](../architecture.md)

The infrastructure surface: the derived `api` contract, physical `storage` instances and their connection sources, `resource` bindings (state/eventLog/cache/objectStore/queue/api…), and `channel` pub/sub with `channelSource`.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **`api`** — contract derived from a subdomain; `urlStyle`, `httpStatus` overrides; what each declaration kind exposes.
- **`storage`** — physical store types (postgres/redis/kafka/s3/…); connection sources `service`/`env`/`secret`/`literal`.
- **`resource`** — binding from context data `kind` to storage; the kind↔storage matrix; `schema`/`ttl`/`isolationLevel`/`readonly`.
- **`channel` & `channelSource`** — publisher contract (`carries`, `delivery`, `retention`, `key`) and its physical binding.
