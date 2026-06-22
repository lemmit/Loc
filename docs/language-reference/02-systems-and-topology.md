# 2. Systems & deployment topology

> **Grammar:** `System`, `Subdomain`, `BoundedContext`, `Deployable`, `Platform`, `theme` · **Validators:** `checkDeployable` in `src/language/validators/deployable.ts` · **Docs:** [`../architecture.md`](../architecture.md), [`../platforms.md`](../platforms.md)

The outermost shells: how a `system` groups `subdomain`s and `context`s into `deployable`s, the backend/frontend platforms, design packs, the realization axes (`foundation`/`application`/`persistence`/…), and the `theme` block.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **`system`** — top-level deployment grouping; implicit anonymous system for bare contexts.
- **`subdomain` & `context`** — logical grouping vs bounded context; what each may contain.
- **`deployable`** — platform + contexts + storage bindings + ui + port. Show the emitted compose service.
- **Backend platforms** — `dotnet`, `node`, `elixir`, `python`, `java` — registry in `src/platform/registry.ts`.
- **Frontend platforms & `targets:`** — `react`, `vue`, `svelte`, `angular`, `phoenixLiveView`, `static`; `targets:` backend inheritance.
- **Design packs** — per-framework pack lists (mantine/shadcn/mui/chakra, vuetify/shadcnVue, …) and the `design:` pin.
- **Realization axes** — `foundation` (ash|vanilla), `application`, `persistence`, `directoryLayout`, `transport`, `runtime`.
- **`theme`** — system-level design tokens (primary, neutral, radius, fontFamily).
