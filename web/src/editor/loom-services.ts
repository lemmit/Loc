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
import { MonacoVscodeApiWrapper } from "monaco-languageclient/vscodeApiWrapper";
import tmGrammar from "../../../vscode/grammars/ddd.tmLanguage.json?raw";
import langConfig from "../../../vscode/language-configuration.json?raw";

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
          },
        },
        filesOrContents: new Map<string, string>([
          ["/ddd.tmLanguage.json", tmGrammar],
          ["/language-configuration.json", langConfig],
        ]),
      },
    ],
  });
  await wrapper.start();
}
