# Throwaway verification spikes

These `spike-*.mjs` scripts are **not part of the app or CI**. Each was
written to node-verify one uncertain link in the npm-in-browser engine
work and is kept only as a reproducible record of that verification.
They import from `../src` and `../../out` and are run ad hoc with
`npx tsx spikes/<name>.mjs` (network required: npm registry / jsdelivr).

| spike | proves |
|---|---|
| `spike-npm-in-browser` | real drizzle tarball exports `extractUsedTable` (esm.sh drops it) |
| `spike-node-resolve` | exports-aware resolver lands drizzle's 443-key map on real files |
| `spike-npm-install` | full real backend dep set installs + resolves, browser-safe |
| `spike-vfs-bundle` | a real generated Hono backend bundles via the VFS plugin |
| `spike-engine-prepare` | `NpmInstallBundleEngine.prepare()` assembles end-to-end |
| `spike-b4-boot` | the engine's bundle boots real PGlite and serves requests |

Safe to delete; they are not referenced by `package.json`, Vite, or
`tsconfig`.
