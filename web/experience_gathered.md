
## 62. A catch-all `onResolve` sees things that aren't module specifiers (2026-08-01)

The React bundle died with:

```
vfs: bare "data:image/svg+xml,%3Csvg xmlns='…' viewBox='0 0 15 15'…" not in installed node_modules
```

`makeVfsNpmPlugin`'s resolver is registered as `onResolve({ filter: /.*/ })`,
and **esbuild routes CSS `url()` tokens through onResolve** — verified
directly: a stylesheet with `url("data:…")`, `url("https://…")` and
`url("./local.png")` produces onResolve calls for all three. So an inlined
icon in any bundled stylesheet fell past the relative / builtin / alias /
bare-package ladder and out the error return at the bottom. A remote asset
URL would have failed identically.

The generalisable bit: a catch-all resolver's fall-through error message
assumes every specifier reaching it is a module specifier, and that
assumption is false. URL-scheme strings (`data:`, `https:`, `blob:`,
protocol-relative `//`) have to be recognised and passed through `external`
BEFORE the ladder — but AFTER the `node:` builtin check, since `node:fs`
matches the URL-scheme shape too and must still stub out.

Method note: rather than hunt which npm package embedded the icon, the
cheaper move was to reproduce esbuild's *behaviour* with a ten-line spy
plugin. The bug is in how the resolver classifies inputs, not in any one
package, and the fix and its test follow from the classification — the
resolver arm is pure, so the test invokes the callback directly and needs no
bundler at all.
