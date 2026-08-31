// ---------------------------------------------------------------------------
// Web-shell files — the layouts module (`embed_templates "layouts/*"`).
//
// Only the design-neutral layouts module lives here.  CoreComponents, the
// root layout and the app layout are design vocabulary and render through the
// deployable's HEEx design pack (`pack.render("core-components" | "main" |
// "app-shell", …)` in ../vanilla/shell-emit.ts — see designs/coreComponents/v3
// and designs/daisyui/v1).
//
// NOTE: the vanilla Ecto/Phoenix backend emits its `<App>Web` entrypoint, the
// SPA controller (embedded-react mode) and the Error views from
// `renderVanilla{WebModule,SpaController,ErrorJson}` in
// `../vanilla/shell-emit.ts`, NOT from here.
// ---------------------------------------------------------------------------

export function renderLayouts(_appName: string, appModule: string): string {
  const webModule = `${appModule}Web`;
  return `# Auto-generated.
defmodule ${webModule}.Layouts do
  use ${webModule}, :html

  embed_templates "layouts/*"
end
`;
}
