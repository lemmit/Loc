// ---------------------------------------------------------------------------
// Web-shell files — the `<App>Web` entrypoint module, the SPA controller
// (embedded-React mode), the CoreComponents function-component library the
// HEEx walker dispatches into, the layouts (module + root/app HEEx), and
// the minimal Error views.  Consumed by `emitShellFiles` in ../shell-emit.ts
// (renderSpaController is additionally re-exported there for the orchestrator).
// ---------------------------------------------------------------------------

export function renderWebModule(_appName: string, appModule: string): string {
  const webModule = `${appModule}Web`;
  return `# Auto-generated.
defmodule ${webModule} do
  @moduledoc """
  The entrypoint for defining web interface, such as controllers, components,
  channels, and so on.  This can be used in your application as:

      use ${webModule}, :live_view

  """

  def live_view do
    quote do
      use Phoenix.LiveView, layout: {${webModule}.Layouts, :app}
      unquote(html_helpers())
    end
  end

  def live_component do
    quote do
      use Phoenix.LiveComponent
      unquote(html_helpers())
    end
  end

  def router do
    quote do
      use Phoenix.Router, helpers: false
      import Plug.Conn
      import Phoenix.Controller
      import Phoenix.LiveView.Router
    end
  end

  def channel do
    quote do
      use Phoenix.Channel
    end
  end

  # Controller bundle for the API + LV controllers we emit
  # (AggregatesController, OpenapiController, HealthController, …).
  # Standard Phoenix 1.7 shape — pulls in the controller DSL plus
  # the formats this generator emits (json + html for layout-bearing
  # endpoints).  Caller modules use \`use PhoenixAppWeb, :controller\`.
  def controller do
    quote do
      use Phoenix.Controller, formats: [:html, :json], layouts: [html: ${webModule}.Layouts]

      import Plug.Conn
      unquote(verified_routes())
    end
  end

  # Verified-routes helper bundle — exposed both to controllers and
  # LiveView modules so \`~p\` paths are reachable everywhere.
  def verified_routes do
    quote do
      use Phoenix.VerifiedRoutes,
        endpoint: ${webModule}.Endpoint,
        router: ${webModule}.Router,
        statics: ~w(assets fonts images favicon.ico robots.txt)
    end
  end

  def component do
    quote do
      use Phoenix.Component
      unquote(html_helpers())
    end
  end

  # HTML helper bundle for layouts + function components.  Required
  # by \`use PhoenixAppWeb, :html\` invocations (e.g. Layouts).  Mirrors
  # the standard Phoenix 1.7 generator shape — pulls in Phoenix.HTML,
  # core components, and a CSRF helper.
  def html do
    quote do
      use Phoenix.Component
      import Phoenix.Controller,
        only: [get_csrf_token: 0, view_module: 1, view_template: 1]
      unquote(html_helpers())
    end
  end

  defp html_helpers do
    quote do
      # phoenix_html 4.x dropped \`use Phoenix.HTML\` — import the
      # safe-string helpers directly instead.  Same surface, no
      # macro fan-out.
      import Phoenix.HTML
      # Phoenix.LiveView.Helpers was folded into Phoenix.Component in
      # LiveView 0.18+; the function components surface (\`~H\`, etc.)
      # comes from \`use Phoenix.Component\` on the caller side.
      import ${webModule}.CoreComponents
      alias Phoenix.LiveView.JS
      # Verified routes — provides the \`~p\` sigil that emitted
      # sidebar / page templates use for path interpolation.
      unquote(verified_routes())
    end
  end

  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
`;
}

/** SpaController (D-PHOENIX-SURFACE phase 6b) — serves the embedded
 *  React SPA's `index.html` for any `/app/*` client-side route.  Only
 *  emitted in embedded-react mode; the router's `/app` catch-all points
 *  here.  Reads the bundle the Dockerfile placed at
 *  `priv/static/app/index.html`. */
export function renderSpaController(appName: string, appModule: string): string {
  const webModule = `${appModule}Web`;
  return `# Auto-generated.
defmodule ${webModule}.SpaController do
  use ${webModule}, :controller

  @index_path Path.join(:code.priv_dir(:${appName}), "static/app/index.html")

  def index(conn, _params) do
    conn
    |> put_resp_content_type("text/html")
    |> send_file(200, @index_path)
  end
end
`;
}

export function renderCoreComponents(appModule: string): string {
  const webModule = `${appModule}Web`;
  return `# Auto-generated.
defmodule ${webModule}.CoreComponents do
  @moduledoc """
  Function components consumed by emitted layouts + LiveView pages.
  Mirrors the subset of Phoenix 1.7's standard CoreComponents that
  Loom's HEEx walker calls into: \`flash_group\`, \`header\`, \`button\`,
  \`input\`, \`simple_form\`, \`table\`, \`badge\`, \`empty\`, \`modal\`.

  Layouts are intentionally minimal/Tailwind-ish — projects can swap
  in a richer component module without touching the emitter.
  """
  use Phoenix.Component
  alias Phoenix.LiveView.JS

  @doc "Renders all currently-set flash messages."
  attr :flash, :map, default: %{}

  def flash_group(assigns) do
    ~H"""
    <div :if={Phoenix.Flash.get(@flash, :info)} class="rounded-md bg-blue-50 p-3 text-sm text-blue-700 mb-4">
      <%= Phoenix.Flash.get(@flash, :info) %>
    </div>
    <div :if={Phoenix.Flash.get(@flash, :error)} class="rounded-md bg-red-50 p-3 text-sm text-red-700 mb-4">
      <%= Phoenix.Flash.get(@flash, :error) %>
    </div>
    """
  end

  @doc "Page-section heading with optional subtitle + actions slot."
  attr :class, :string, default: nil
  # \`level\` is forwarded from the DSL Heading primitive (1..4).  Styling
  # is uniform here (single .text-2xl line) — the attr is accepted so
  # consumers can render their own sized variants without re-declaring.
  attr :level, :integer, default: 1
  slot :inner_block, required: true
  slot :subtitle
  slot :actions

  def header(assigns) do
    ~H"""
    <header class={["flex items-center justify-between gap-6 mb-6", @class]}>
      <div>
        <h1 class={[
          "font-semibold leading-7 text-zinc-900",
          @level <= 1 && "text-2xl",
          @level == 2 && "text-xl",
          @level == 3 && "text-lg",
          @level >= 4 && "text-base"
        ]}>
          {render_slot(@inner_block)}
        </h1>
        <p :if={@subtitle != []} class="mt-1 text-sm text-zinc-600">
          {render_slot(@subtitle)}
        </p>
      </div>
      <div :if={@actions != []} class="flex gap-2 flex-shrink-0">
        {render_slot(@actions)}
      </div>
    </header>
    """
  end

  @doc """
  Styled button.  Accepts type=button|submit|reset + arbitrary attrs.
  When \`to:\` is set, renders a \`<.link navigate>\` styled as a button
  (matches the DSL Button primitive's \`to:\` named arg for navigation).
  \`testid:\` is hoisted onto the rendered element for Playwright drivers.
  """
  attr :type, :string, default: "button"
  attr :class, :string, default: nil
  attr :to, :string, default: nil, doc: "when set, renders as a navigation link"
  attr :testid, :string, default: nil, doc: "data-testid forwarded to the root element"
  attr :rest, :global, include: ~w(form name value disabled phx-click phx-submit phx-disable-with)
  slot :inner_block, required: true

  def button(assigns) do
    classes =
      [
        "inline-flex items-center justify-center rounded-md bg-zinc-900 px-3 py-2 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50",
        assigns.class
      ]

    assigns = assign(assigns, :classes, classes)

    if assigns.to do
      ~H"""
      <.link navigate={@to} class={@classes} data-testid={@testid} {@rest}>
        {render_slot(@inner_block)}
      </.link>
      """
    else
      ~H"""
      <button type={@type} class={@classes} data-testid={@testid} {@rest}>
        {render_slot(@inner_block)}
      </button>
      """
    end
  end

  @doc "Form input with label + error message.  Supports text/number/email/checkbox/select/textarea."
  attr :id, :any, default: nil
  attr :name, :any
  attr :label, :string, default: nil
  attr :value, :any
  attr :type, :string, default: "text"
  attr :field, Phoenix.HTML.FormField,
    doc: "a form field struct retrieved from the form, for example: @form[:email]"
  attr :errors, :list, default: []
  attr :checked, :boolean
  attr :prompt, :string, default: nil
  attr :options, :list, default: []
  attr :multiple, :boolean, default: false
  attr :rest, :global, include: ~w(autocomplete cols disabled form list max maxlength min minlength pattern placeholder readonly required rows size step)

  def input(%{field: %Phoenix.HTML.FormField{} = field} = assigns) do
    assigns
    |> assign(field: nil, id: assigns.id || field.id)
    |> assign(:errors, Enum.map(field.errors, &translate_error/1))
    |> assign_new(:name, fn -> if assigns.multiple, do: field.name <> "[]", else: field.name end)
    |> assign_new(:value, fn -> field.value end)
    |> input()
  end

  def input(%{type: "checkbox"} = assigns) do
    assigns = assign_new(assigns, :checked, fn -> Phoenix.HTML.Form.normalize_value("checkbox", assigns[:value]) end)

    ~H"""
    <div>
      <label class="flex items-center gap-3 text-sm leading-6 text-zinc-600">
        <input type="hidden" name={@name} value="false" />
        <input
          type="checkbox"
          id={@id}
          name={@name}
          value="true"
          checked={@checked}
          class="rounded border-zinc-300 text-zinc-900 focus:ring-0"
          {@rest}
        />
        {@label}
      </label>
      <.error :for={msg <- @errors}>{msg}</.error>
    </div>
    """
  end

  def input(%{type: "select"} = assigns) do
    ~H"""
    <div>
      <.label for={@id}>{@label}</.label>
      <select
        id={@id}
        name={@name}
        class="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-400 focus:ring-0"
        multiple={@multiple}
        {@rest}
      >
        <option :if={@prompt} value="">{@prompt}</option>
        {Phoenix.HTML.Form.options_for_select(@options, @value)}
      </select>
      <.error :for={msg <- @errors}>{msg}</.error>
    </div>
    """
  end

  def input(%{type: "textarea"} = assigns) do
    ~H"""
    <div>
      <.label for={@id}>{@label}</.label>
      <textarea
        id={@id}
        name={@name}
        class="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-400 focus:ring-0"
        {@rest}
      >{Phoenix.HTML.Form.normalize_value("textarea", @value)}</textarea>
      <.error :for={msg <- @errors}>{msg}</.error>
    </div>
    """
  end

  def input(assigns) do
    ~H"""
    <div>
      <.label for={@id}>{@label}</.label>
      <input
        type={@type}
        name={@name}
        id={@id}
        value={Phoenix.HTML.Form.normalize_value(@type, @value)}
        class="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-400 focus:ring-0"
        {@rest}
      />
      <.error :for={msg <- @errors}>{msg}</.error>
    </div>
    """
  end

  attr :for, :string, default: nil
  slot :inner_block, required: true

  def label(assigns) do
    ~H"""
    <label for={@for} class="block text-sm font-medium leading-6 text-zinc-900">
      {render_slot(@inner_block)}
    </label>
    """
  end

  slot :inner_block, required: true

  def error(assigns) do
    ~H"""
    <p class="mt-1 text-sm leading-6 text-rose-600">{render_slot(@inner_block)}</p>
    """
  end

  @doc "Form wrapper that renders a Phoenix.HTML.Form with submit handler."
  attr :for, :any, required: true
  attr :as, :any, default: nil
  attr :rest, :global, include: ~w(autocomplete name rel action enctype method novalidate target multipart phx-change phx-submit phx-trigger-action phx-disable-with)
  slot :inner_block, required: true
  slot :actions

  def simple_form(assigns) do
    ~H"""
    <.form :let={f} for={@for} as={@as} {@rest}>
      <div class="space-y-4">
        {render_slot(@inner_block, f)}
        <div :for={action <- @actions} class="mt-4 flex items-center justify-end gap-2">
          {render_slot(action, f)}
        </div>
      </div>
    </.form>
    """
  end

  @doc "Data table with :col slots."
  attr :id, :string, required: true
  attr :rows, :list, required: true
  attr :row_id, :any, default: nil, doc: "function that returns the id for the row"
  attr :row_click, :any, default: nil, doc: "function or {JS, …} to invoke on row click"
  attr :row_item, :any, default: &Function.identity/1, doc: "function to derive the row data shown to the slot"
  slot :col, required: true do
    attr :label, :string
  end
  slot :action, doc: "trailing per-row action column"

  def table(assigns) do
    assigns = assign_new(assigns, :row_id, fn -> nil end)

    ~H"""
    <div class="overflow-x-auto">
      <table id={@id} class="min-w-full divide-y divide-zinc-200 text-sm">
        <thead class="bg-zinc-50">
          <tr>
            <th :for={col <- @col} class="px-3 py-2 text-left font-semibold text-zinc-700">{col[:label]}</th>
            <th :if={@action != []} class="px-3 py-2 text-right font-semibold text-zinc-700">
              <span class="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-zinc-100 bg-white">
          <tr :for={row <- @rows} id={@row_id && @row_id.(row)} class={@row_click && "hover:bg-zinc-50 cursor-pointer"}>
            <td :for={col <- @col} phx-click={@row_click && @row_click.(row)} class="px-3 py-2 text-zinc-900">
              {render_slot(col, @row_item.(row))}
            </td>
            <td :if={@action != []} class="px-3 py-2 text-right">
              <span :for={action <- @action}>{render_slot(action, @row_item.(row))}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    """
  end

  @doc "Colored pill — used for status / enum displays."
  attr :class, :string, default: nil
  slot :inner_block, required: true

  def badge(assigns) do
    ~H"""
    <span class={["inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700", @class]}>
      {render_slot(@inner_block)}
    </span>
    """
  end

  @doc "Empty-state placeholder rendered when a list is empty."
  attr :class, :string, default: nil

  def empty(assigns) do
    ~H"""
    <div class={["text-center text-sm text-zinc-500 py-8", @class]}>
      No items.
    </div>
    """
  end

  @doc """
  A modal dialog driven by \`show_modal/1\` + \`hide_modal/1\` JS
  commands.  The \`:title\` slot renders the heading; the default
  slot is the body (typically a \`<.simple_form>\`).
  """
  attr :id, :string, required: true
  attr :show, :boolean, default: false
  attr :on_cancel, JS, default: %JS{}
  slot :title
  slot :inner_block, required: true

  def modal(assigns) do
    ~H"""
    <div
      id={@id}
      phx-mounted={@show && show_modal(@id)}
      phx-remove={hide_modal(@id)}
      class="relative z-50 hidden"
    >
      <div id={"#{@id}-bg"} class="fixed inset-0 bg-zinc-900/30 transition-opacity" aria-hidden="true" />
      <div
        class="fixed inset-0 overflow-y-auto"
        aria-labelledby={"#{@id}-title"}
        role="dialog"
        aria-modal="true"
        tabindex="0"
      >
        <div class="flex min-h-full items-center justify-center p-4">
          <div class="w-full max-w-lg">
            <.focus_wrap
              id={"#{@id}-container"}
              phx-window-keydown={hide_modal(@on_cancel, @id)}
              phx-key="escape"
              phx-click-away={hide_modal(@on_cancel, @id)}
              class="relative hidden rounded-md bg-white p-6 shadow-lg ring-1 ring-zinc-200 transition"
            >
              <div class="absolute top-4 right-4">
                <button
                  type="button"
                  phx-click={hide_modal(@on_cancel, @id)}
                  class="rounded-md p-1 text-zinc-400 hover:text-zinc-600"
                  aria-label="close"
                >
                  &times;
                </button>
              </div>
              <h2
                :if={@title != []}
                id={"#{@id}-title"}
                class="text-lg font-semibold leading-7 text-zinc-900 mb-4"
              >
                {render_slot(@title)}
              </h2>
              <div id={"#{@id}-content"}>
                {render_slot(@inner_block)}
              </div>
            </.focus_wrap>
          </div>
        </div>
      </div>
    </div>
    """
  end

  # ---- Internal helpers -----------------------------------------------------

  @doc false
  def show_modal(js \\\\ %JS{}, id) when is_binary(id) do
    js
    |> JS.show(to: "##{id}")
    |> JS.show(
      to: "##{id}-bg",
      transition:
        {"transition-all transform ease-out duration-200", "opacity-0", "opacity-100"}
    )
    |> JS.show(
      to: "##{id}-container",
      transition:
        {"transition-all transform ease-out duration-200",
         "opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95",
         "opacity-100 translate-y-0 sm:scale-100"}
    )
    |> JS.focus_first(to: "##{id}-content")
  end

  @doc false
  def hide_modal(js \\\\ %JS{}, id) do
    js
    |> JS.hide(
      to: "##{id}-bg",
      transition:
        {"transition-all transform ease-in duration-150", "opacity-100", "opacity-0"}
    )
    |> JS.hide(
      to: "##{id}-container",
      transition:
        {"transition-all transform ease-in duration-150",
         "opacity-100 translate-y-0 sm:scale-100",
         "opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"}
    )
    |> JS.hide(to: "##{id}", transition: {"block", "block", "hidden"})
    |> JS.pop_focus()
  end

  defp translate_error({msg, opts}) do
    Enum.reduce(opts, msg, fn {key, value}, acc ->
      String.replace(acc, "%{#{key}}", fn _ -> to_string(value) end)
    end)
  end
end
`;
}

export function renderLayouts(_appName: string, appModule: string): string {
  const webModule = `${appModule}Web`;
  return `# Auto-generated.
defmodule ${webModule}.Layouts do
  use ${webModule}, :html

  embed_templates "layouts/*"
end
`;
}

export function renderRootLayout(appName: string): string {
  return `<!DOCTYPE html>
<html lang="en" class="[scrollbar-gutter:stable]">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="csrf-token" content={get_csrf_token()} />
    <.live_title suffix=" · ${appName}">
      <%= assigns[:page_title] || "${appName}" %>
    </.live_title>
    <link phx-track-static rel="stylesheet" href={~p"/assets/app.css"} />
    <script defer phx-track-static type="text/javascript" src={~p"/assets/app.js"}>
    </script>
  </head>
  <body class="bg-white antialiased">
    <%= @inner_content %>
  </body>
</html>
`;
}

/** The `app.html.heex` layout.  When the deployable emits a derived sidebar
 *  (a LiveView app with a `ui:` block), the chrome is a flex row: the
 *  `<.sidebar>` component on the left as the real navigation, the page body
 *  (`@inner_content`) on the right.  `@current_path` is published on every
 *  LiveView by the `<App>Web.Nav` on_mount hook (see renderLiveNav).
 *
 *  In the embedded-SPA case (`hasSidebar === false`) there is no Sidebar
 *  module and the SPA owns the UI, so the layout falls back to the minimal
 *  hardcoded `Home` header — referencing no sidebar component or routes.
 *
 *  The sidebar is invoked by its FULLY-QUALIFIED module path rather than the
 *  short `<.sidebar>` form.  An `import <App>Web.Components.Sidebar` would have
 *  to live in the shared `html_helpers` bundle, but the Sidebar module itself
 *  does `use <App>Web, :html` (→ that same bundle) → it would import itself
 *  while being defined (a `CompileError`).  The qualified call needs no import,
 *  so it's both self-import-safe and unused-import-warning-clean. */
export function renderAppLayout(
  appModule: string,
  hasSidebar = false,
  authEnabled = false,
): string {
  if (!hasSidebar) {
    return `<a href="#main-content" class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:border focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium">Skip to content</a>
<header class="px-4 sm:px-6 lg:px-8">
  <div class="flex items-center justify-between border-b border-zinc-100 py-3 text-sm">
    <div class="flex items-center gap-4">
      <nav aria-label="Primary navigation" class="flex items-center gap-4 font-semibold leading-6 text-zinc-900">
        <a href="/">Home</a>
      </nav>
    </div>
  </div>
</header>
<main id="main-content" class="px-4 py-20 sm:px-6 lg:px-8">
  <div class="mx-auto max-w-2xl">
    <.flash_group flash={@flash} />
    <%= @inner_content %>
  </div>
</main>
`;
  }

  // When auth is on, `LiveAuth.on_mount` assigns `@current_user` on every
  // LiveView in the session, so the layout forwards it to the sidebar (whose
  // `current_user` attr a gated link's `<%= if (@current_user.…) do %>`
  // reads).  No-auth apps emit no such assign — keep the call byte-identical.
  const currentUserAttr = authEnabled ? " current_user={@current_user}" : "";
  return `<div class="flex min-h-screen">
  <a href="#main-content" class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:border focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium">Skip to content</a>
  <nav aria-label="Primary navigation" class="w-64 flex-shrink-0 border-r border-zinc-100 bg-zinc-50">
    <${appModule}Web.Components.Sidebar.sidebar current_path={@current_path}${currentUserAttr} />
  </nav>
  <main id="main-content" class="flex-1 px-4 py-8 sm:px-6 lg:px-8">
    <div class="mx-auto max-w-4xl">
      <.flash_group flash={@flash} />
      <%= @inner_content %>
    </div>
  </main>
</div>
`;
}

/** Minimal ErrorJSON module — Phoenix's render_errors pipeline calls
 *  `render/2` with template names like "404.json" / "500.json" and
 *  expects a map back.  Phoenix.Controller.status_message_from_template/1
 *  turns the template ("500.json") into a status reason string ("Internal
 *  Server Error"), which we surface in the envelope. */
export function renderErrorJson(appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}Web.ErrorJSON do
  @moduledoc "Render exceptions as JSON envelopes for the API."

  # Catch-all: e.g. "404.json" → %{error: "Not Found"}, "500.json" → %{error: "Internal Server Error"}.
  def render(template, _assigns) do
    %{error: Phoenix.Controller.status_message_from_template(template)}
  end
end
`;
}

/** Minimal ErrorHTML module — Phoenix's render_errors pipeline picks
 *  json or html based on the request's Accept header.  Browser requests
 *  hit this one; the body is intentionally minimal so an exception
 *  doesn't leak internal state. */
export function renderErrorHtml(appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}Web.ErrorHTML do
  @moduledoc "Render exceptions as a plain HTML body for browser callers."

  def render(template, _assigns) do
    Phoenix.Controller.status_message_from_template(template)
  end
end
`;
}
