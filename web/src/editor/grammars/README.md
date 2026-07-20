# Vendored TextMate grammars

Grammars registered as virtual VS Code extensions in `../loom-services.ts` for
the playground's generated-file viewer. The `@codingame/monaco-vscode-*`
extension packages only wrap VS Code's **built-in** languages, so any language
that isn't a VS Code built-in (like Elixir) needs its grammar vendored here.

## `elixir.tmLanguage.json`

- **Language:** Elixir (`.ex`, `.exs`), scope `source.elixir`.
- **Source:** [`elixir-editors/elixir-tmbundle`](https://github.com/elixir-editors/elixir-tmbundle) → `Syntaxes/Elixir.tmLanguage`, commit `43c8cd957d5ac6e1abbd8730fc7a08c81a6e76c9`, converted to JSON and redistributed by [`tm-grammars`](https://github.com/shikijs/textmate-grammars-themes) (`tm-grammars@1.31.15`, `grammars/elixir.json`).
- **License:** Apache-2.0 (elixir-tmbundle). See <https://raw.githubusercontent.com/elixir-editors/elixir-tmbundle/master/LICENSE>.

To refresh: `npm pack tm-grammars`, copy `package/grammars/elixir.json` here, keep this note in sync.
