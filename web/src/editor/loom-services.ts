// Initialises the @codingame/monaco-vscode-api services once for the
// playground: registers the `ddd` language, its TextMate grammar, and
// language-configuration as a virtual VS Code extension so highlighting and
// editor behaviour match the real extension.  Idempotent — every caller
// awaits the same init promise.

import getConfigurationServiceOverride from "@codingame/monaco-vscode-configuration-service-override";
import getKeybindingsServiceOverride from "@codingame/monaco-vscode-keybindings-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getTextmateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import "@codingame/monaco-vscode-theme-defaults-default-extension";
// Standard-language grammars for the generated-file viewer.  The
// `@codingame/monaco-vscode-editor-api` build ships a bare editor with NO
// built-in language modes (unlike stock `monaco-editor`), so a generated
// `.ts` / `.cs` / `.yml` file would render as flat grey text.  Each of these
// default-extension packages registers a language id + TextMate grammar +
// language-configuration as a virtual VS Code extension (side-effect import),
// which the textmate service tokenizes on the main thread.  The set mirrors
// the file types every backend/frontend emits (`generate system` can produce
// all of them); `languageFromPath` maps extensions onto these ids.
import "@codingame/monaco-vscode-typescript-basics-default-extension";
import "@codingame/monaco-vscode-json-default-extension";
import "@codingame/monaco-vscode-yaml-default-extension";
import "@codingame/monaco-vscode-markdown-basics-default-extension";
import "@codingame/monaco-vscode-csharp-default-extension";
import "@codingame/monaco-vscode-sql-default-extension";
import "@codingame/monaco-vscode-html-default-extension";
import "@codingame/monaco-vscode-css-default-extension";
import "@codingame/monaco-vscode-python-default-extension";
import "@codingame/monaco-vscode-java-default-extension";
import "@codingame/monaco-vscode-xml-default-extension";
import "@codingame/monaco-vscode-docker-default-extension";
import "@codingame/monaco-vscode-shellscript-default-extension";
import "@codingame/monaco-vscode-fsharp-default-extension";
import "@codingame/monaco-vscode-dart-default-extension";
import "@codingame/monaco-vscode-groovy-default-extension";
import "@codingame/monaco-vscode-ini-default-extension";
import { MonacoVscodeApiWrapper } from "monaco-languageclient/vscodeApiWrapper";
import tmGrammar from "../../../vscode/grammars/ddd.tmLanguage.json?raw";
import langConfig from "../../../vscode/language-configuration.json?raw";
import loomTheme from "../../../vscode/themes/loom-dark.json?raw";

let initPromise: Promise<void> | undefined;

export function initLoomServices(): Promise<void> {
  if (!initPromise) initPromise = doInit();
  return initPromise;
}

async function doInit(): Promise<void> {
  const wrapper = new MonacoVscodeApiWrapper({
    $type: "extended",
    viewsConfig: { $type: "EditorService" },
    serviceOverrides: {
      ...getConfigurationServiceOverride(),
      ...getLanguagesServiceOverride(),
      ...getTextmateServiceOverride(),
      ...getThemeServiceOverride(),
      ...getKeybindingsServiceOverride(),
    },
    // Activate the bespoke Loom palette (see vscode/themes/loom-dark.json).
    // Without this the editor inherits the stock VS Code dark theme, whose
    // scope mapping leaves most of the DSL flat grey.
    userConfiguration: {
      json: JSON.stringify({
        "workbench.colorTheme": "Loom Dark",
        "editor.semanticHighlighting.enabled": true,
      }),
    },
    extensions: [
      {
        config: {
          name: "loom-ddd",
          publisher: "loom",
          version: "0.0.0",
          engines: { vscode: "*" },
          contributes: {
            languages: [
              { id: "ddd", extensions: [".ddd"], configuration: "./language-configuration.json" },
            ],
            grammars: [
              { language: "ddd", scopeName: "source.ddd", path: "./ddd.tmLanguage.json" },
            ],
            themes: [
              { id: "Loom Dark", label: "Loom Dark", uiTheme: "vs-dark", path: "./loom-dark.json" },
            ],
          },
        },
        filesOrContents: new Map<string, string>([
          ["/ddd.tmLanguage.json", tmGrammar],
          ["/language-configuration.json", langConfig],
          ["/loom-dark.json", loomTheme],
        ]),
      },
    ],
  });
  await wrapper.start();
}
