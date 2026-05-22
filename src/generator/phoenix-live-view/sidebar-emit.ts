// ---------------------------------------------------------------------------
// Batch C — Phoenix sidebar component emitter.
//
// Exports `renderSidebarComponent`, which produces an Elixir source file
// for `lib/<app>_web/components/sidebar.ex` — a Phoenix.Component function
// that renders the application's sidebar navigation.
//
// The section/link structure is derived from the UI IR using
// `deriveSidebarFromUi` (the same React menu-emitter derivation), so
// explicit `ui.menu { section ... }` blocks and per-page `menuMeta`
// annotations both drive the Phoenix sidebar just as they drive the React
// sidebar.
//
// HEEx structure:
//   <nav><ul> — one <li> per link inside each section;
//   sections are separated by an <h3> heading.
// ---------------------------------------------------------------------------

import type { UiIR } from "../../ir/loom-ir.js";
import { deriveSidebarFromUi } from "../react/menu-emitter.js";
import type { NavSectionVM } from "../react/templating/view-models.js";

export interface RenderSidebarComponentArgs {
  ui: UiIR;
  appName: string;
  appModule: string;
}

/** Emit the full Elixir source for `lib/<app>_web/components/sidebar.ex`.
 *  Returns the file content as a string; the caller writes it to the
 *  appropriate path. */
export function renderSidebarComponent(args: RenderSidebarComponentArgs): string {
  const { ui, appName, appModule } = args;

  const navSections: NavSectionVM[] = deriveSidebarFromUi(ui) ?? buildDefaultSections(ui);

  const webModule = `${appModule}Web`;
  const lines: string[] = [];

  lines.push(`# Auto-generated.`);
  lines.push(`defmodule ${webModule}.Components.Sidebar do`);
  lines.push(`  @moduledoc """`);
  lines.push(`  Application sidebar navigation component for ${appName}.`);
  lines.push(`  """`);
  lines.push(`  use ${webModule}, :html`);
  lines.push(``);
  lines.push(`  @doc "Renders the sidebar navigation."`);
  lines.push(`  attr :current_path, :string, default: "/"`);
  lines.push(``);
  lines.push(`  def sidebar(assigns) do`);
  lines.push(`    ~H"""`);
  lines.push(`    <nav class="flex flex-col gap-6 p-4" data-testid="sidebar">`);
  lines.push(`      <ul class="space-y-1">`);

  for (const section of navSections) {
    if (navSections.length > 1 && section.label) {
      const escapedLabel = escapeHeex(section.label);
      lines.push(`        <li class="pt-4 first:pt-0">`);
      lines.push(
        `          <h3 class="px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">`,
      );
      lines.push(`            ${escapedLabel}`);
      lines.push(`          </h3>`);
      lines.push(`          <ul class="space-y-0.5">`);
      for (const entry of section.entries) {
        lines.push(...renderNavEntry(entry, 12));
      }
      lines.push(`          </ul>`);
      lines.push(`        </li>`);
    } else {
      // Single section or no label — render entries directly under <ul>.
      for (const entry of section.entries) {
        lines.push(...renderNavEntry(entry, 8));
      }
    }
  }

  lines.push(`      </ul>`);
  lines.push(`    </nav>`);
  lines.push(`    """`);
  lines.push(`  end`);
  lines.push(`end`);
  lines.push(``);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Render a single nav link <li> at the given indent level. */
function renderNavEntry(entry: NavSectionVM["entries"][number], indentSpaces: number): string[] {
  const pad = " ".repeat(indentSpaces);
  const label = escapeHeex(entry.label);
  const testId = escapeHeex(entry.testId);

  // External links — sentinel `__external:<url>` written by menu-emitter.
  if (entry.to.startsWith("__external:")) {
    const url = escapeHeex(entry.to.slice("__external:".length));
    return [
      `${pad}<li>`,
      `${pad}  <a href="${url}" target="_blank" rel="noopener noreferrer"`,
      `${pad}     class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100"`,
      `${pad}     data-testid="${testId}">`,
      `${pad}    ${label}`,
      `${pad}    <span class="text-xs text-gray-400" aria-hidden="true">↗</span>`,
      `${pad}  </a>`,
      `${pad}</li>`,
    ];
  }

  // Internal links — Phoenix Router ~p sigil.
  const route = escapeHeex(entry.to);
  return [
    `${pad}<li>`,
    `${pad}  <.link navigate={~p"${route}"}`,
    `${pad}         class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100"`,
    `${pad}         data-testid="${testId}">`,
    `${pad}    ${label}`,
    `${pad}  </.link>`,
    `${pad}</li>`,
  ];
}

/** Escape special HEEx characters in plain text content. */
function escapeHeex(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Fallback: when the UI has no explicit menu block AND no eligible explicit
 *  pages with menuMeta, build a minimal section from whatever pages the UI
 *  declares.  This avoids an empty sidebar when `deriveSidebarFromUi`
 *  returns `undefined`. */
function buildDefaultSections(ui: UiIR): NavSectionVM[] {
  const entries = ui.pages
    .filter((p) => p.route && !p.route.includes(":"))
    .map((p) => ({
      to: p.route ?? "/",
      label: p.name,
      testId: `nav-${p.name.toLowerCase()}`,
      activeArgs: JSON.stringify(p.route ?? "/"),
    }));

  if (entries.length === 0) return [];
  return [{ label: "", entries }];
}
