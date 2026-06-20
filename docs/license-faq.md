# Loom — License FAQ

Loom is **source-available** under [`FSL-1.1-Apache-2.0`](../LICENSE) (the
Functional Source License 1.1, with an Apache 2.0 future grant).  This
document answers the questions a typical evaluator — engineer, legal,
or procurement — has before adopting Loom for a production system.

If the answer here ever conflicts with the [`LICENSE`](../LICENSE)
file, the LICENSE file is authoritative.

---

## 1. What is licensed under FSL-1.1-Apache-2.0?

Everything in this repository: the `ddd` CLI, the Langium grammar,
the IR, the per-platform generators (the five backends — TypeScript /
.NET / Phoenix / Python / Java — and the frontends — React / Vue /
Svelte / Angular), the VS Code extension, and the documentation.  This
is the **generator itself**.

You may use the generator for any **Permitted Purpose** — internal
use, building products and services for your own customers,
non-commercial education, non-commercial research, and professional
services delivered to a Loom licensee.  See the LICENSE file for the
formal definition.

Two years after each release is published, that release converts
automatically to the Apache License 2.0 (the "future license"
clause).  No action required on your part.

## 2. What about the code Loom *generates*?

**The output of `ddd generate` is yours.  We license it to you under
the [MIT License](https://opensource.org/license/mit), unencumbered by
FSL.**

Concretely:

- Every project Loom emits — `<outdir>/api/`, `<outdir>/web_app/`,
  `<outdir>/catalog_web/`, the docker-compose.yml, the e2e suite —
  is yours to ship under whatever license your project uses.
- The CLI writes a `LICENSE` file at the output-directory root
  containing the MIT grant for the generated code, so this posture
  is self-documenting in your repo.
- Any small runtime helper snippets the generator embeds verbatim
  into the output (error classes, mapping helpers, page-object
  bases, etc.) are dual-licensed **MIT OR Apache-2.0** when they
  ship inside generated projects.  They do *not* carry FSL terms in
  that context.  This means you can vendor and modify them without
  worrying about FSL transitivity.

You are not required to attribute Loom in your generated project,
though we'd appreciate it.  You may not use the "Loom" name or
trademarks to brand your own product (see the Trademarks clause of
the LICENSE).

## 3. What counts as "Competing Use"?

FSL forbids using the Software in a commercial product or service
that *substitutes for* Loom or offers *substantially similar
functionality*.  Plain-English examples:

| Use case | Allowed? | Why |
| --- | --- | --- |
| Building a SaaS for your own customers using `ddd generate` | ✅ | Internal use; the SaaS is not a DDD generator. |
| Internal line-of-business apps at any company size | ✅ | Internal use. |
| Commercial consulting where you generate code for clients | ✅ | Professional services to licensees. |
| Forking Loom and contributing patches upstream | ✅ | Modifications and derivative works are explicitly granted. |
| Self-hosting Loom for your team's CI | ✅ | Internal use. |
| Repackaging Loom (or a fork) as your own commercial DDD code generator | ❌ | Substitutes for the Software. |
| Hosting Loom-as-a-Service (web-based generator users pay you for) | ❌ | Substantially similar functionality, sold to others. |

When in doubt, ask: "Are we using Loom to *build something else*, or
are we *re-selling Loom-shaped functionality*?"  The first is
allowed; the second is not.

## 4. Why FSL and not OSI-approved open source today?

FSL is a fair-source license: it gives users near-total freedom for
any non-competing use *now*, and converts to a true OSI-approved
license (Apache 2.0) on a fixed schedule.  This lets the project
sustain itself in its early years while still committing to a fully
open future.

If your organisation requires OSI-approved licensing on its
**dependencies**, note that:

- The **generated output** is MIT (per §2), which is OSI-approved.
- The **generator** is FSL today; it converts to Apache-2.0
  two years after each release.
- You can pin a specific Loom release once it has converted to
  Apache 2.0 and depend only on that.

If your organisation requires OSI-approved licensing on the
**generator** itself today, Loom is not yet eligible.  Watch the
LICENSE file for the conversion date or contact the maintainers.

## 5. The generator emits Dockerfiles, docker-compose.yml, and
infrastructure scaffolding — is that all MIT too?

Yes.  Everything `ddd generate` writes — including
`docker-compose.yml`, `db-init/`, generated `Dockerfile`s, CI
scaffolding, `.loom/wire-spec.json` — is part of the generated
output and is licensed to you under MIT.

## 6. What if I pin a generated file via `.loomignore`?

Pinning a file (see [`tools.md`](tools.md)) tells Loom to leave it
alone on subsequent regens.  Once pinned, the file is yours to edit
freely; the MIT grant from §2 still applies to whatever Loom wrote
the first time, and your modifications are yours under whatever
license you choose for your project.

## 7. Can I redistribute Loom internally inside my company?

Yes — internal redistribution within an organisation is included in
"internal use and access."  Make sure each copy keeps the LICENSE
file and copyright notice intact (per the Redistribution clause).

## 8. Where do I send licensing questions that aren't covered here?

Open an issue on the GitHub repository, or contact the maintainers
listed in `package.json`.  Legal notices should reference the
specific clause of the LICENSE file your question is about.
