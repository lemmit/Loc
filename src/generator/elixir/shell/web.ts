// ---------------------------------------------------------------------------
// Web-shell files — the layouts module (`embed_templates "layouts/*"`).
//
// This file once held the hardcoded CoreComponents / root-layout / app-layout
// strings; those surfaces are design vocabulary and now render through the
// deployable's HEEx design pack (`pack.render("core-components" | "main" |
// "app-shell", …)` in ../vanilla/shell-emit.ts — see designs/coreComponents/v3
// and designs/daisyui/v1).  Only the design-neutral layouts module remains.
//
// NOTE: the vanilla Ecto/Phoenix backend emits its `<App>Web` entrypoint, the
// SPA controller (embedded-react mode, M-T6.1) and the Error views from
// `renderVanilla{WebModule,SpaController,ErrorJson}` in
// `../vanilla/shell-emit.ts`, NOT from here — those functions used to live in
// this file but were superseded and removed (M-T9.8 dead-export drain).
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
