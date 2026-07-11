// Starter-project templates for `ddd new` (the on-ramp verb).
//
// Pure string builders — no IR, no fs. `renderStarter` composes a shared
// DOMAIN block with a per-platform DEPLOYMENT block so the same model wires
// to whichever backend/frontend the author picked. The CLI validates the
// rendered source (via the in-memory `validate()` toolkit) before writing,
// so a template that drifts from the grammar fails fast rather than shipping
// a broken starter — `test/cli/new.test.ts` pins every combination.

export type StarterPlatform = "node" | "dotnet" | "elixir" | "java" | "python";
export type StarterTemplate = "blank" | "crud";
export type DesignPack =
  | "mantine"
  | "shadcn"
  | "mui"
  | "chakra"
  | "coreComponents"
  | "shadcnSvelte"
  | "flowbite"
  | "vuetify"
  | "shadcnVue";

export const STARTER_PLATFORMS: readonly StarterPlatform[] = [
  "node",
  "dotnet",
  "elixir",
  "java",
  "python",
];
export const STARTER_TEMPLATES: readonly StarterTemplate[] = ["blank", "crud"];
export const REACT_DESIGN_PACKS: readonly DesignPack[] = ["mantine", "shadcn", "mui", "chakra"];
export const SVELTE_DESIGN_PACKS: readonly DesignPack[] = ["shadcnSvelte", "flowbite"];
/** Vue-format packs — picking one scaffolds a `platform: vue` frontend
 *  (the design implies the frontend platform via its pack format). */
export const VUE_DESIGN_PACKS: readonly DesignPack[] = ["vuetify", "shadcnVue"];
export const DESIGN_PACKS: readonly DesignPack[] = [
  ...REACT_DESIGN_PACKS,
  ...SVELTE_DESIGN_PACKS,
  ...VUE_DESIGN_PACKS,
  "coreComponents",
];

/** Backend listen port per platform (mirrors `defaultPort` in
 *  `src/platform/registry.ts`). The frontend scaffold (react or svelte) always uses 3001. */
export const BACKEND_PORT: Record<StarterPlatform, number> = {
  node: 3000,
  dotnet: 8080,
  elixir: 4000,
  java: 8081,
  python: 8000,
};
export const FRONTEND_PORT = 3001;
/** The Vue frontend's port (mirrors the vue platform's defaultPort). */
export const VUE_FRONTEND_PORT = 3003;

/** Turn an arbitrary project name into a valid Loom system identifier
 *  (PascalCase, leading letter). `my-app` → `MyApp`, `123` → `App123`. */
export function toSystemName(name: string): string {
  const parts = name
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const id = parts.map((p) => p[0]!.toUpperCase() + p.slice(1)).join("");
  if (id.length === 0) return "App";
  return /^[A-Za-z]/.test(id) ? id : `App${id}`;
}

/** True when the (platform, design) pair is the Phoenix LiveView fullstack
 *  shape — one deployable that both serves the API and mounts a HEEx UI. */
function isLiveView(platform: StarterPlatform, design: DesignPack): boolean {
  return platform === "elixir" && design === "coreComponents";
}

interface DomainBlock {
  /** Source lines for the `subdomain`/`context` block (2-space indented). */
  source: string;
  /** The single bounded-context name the deployment wires to. */
  context: string;
}

function blankDomain(): DomainBlock {
  return {
    context: "Notes",
    source: `  subdomain Core {
    context Notes {
      aggregate Note with crudish {
        title: string
        body: string
        invariant title.length > 0
      }

      repository Notes for Note { }
    }
  }`,
  };
}

function crudDomain(): DomainBlock {
  return {
    context: "Projects",
    source: `  subdomain Core {
    context Projects {
      aggregate Project with crudish {
        name: string
        invariant name.length > 0
        derived display: string = name
      }

      repository Projects for Project { }

      aggregate Task with crudish {
        title: string
        done: bool
        project: Project id
      }

      repository Tasks for Task {
        find byProject(projectId: Project id): Task[] where this.project == projectId
      }
    }
  }`,
  };
}

function renderDeployment(platform: StarterPlatform, design: DesignPack, context: string): string {
  const storage = `  storage primary { type: postgres }
  resource appState { for: ${context}, kind: state, use: primary }`;

  if (isLiveView(platform, design)) {
    // Phoenix LiveView on `platform: elixir`: a single fullstack deployable
    // mounts the HEEx UI.  Field order follows the grammar: …ui → port → design.
    return `${storage}

  deployable app {
    platform: elixir,
    contexts: [${context}],
    dataSources: [appState],
    ui: WebApp,
    port: ${BACKEND_PORT.elixir},
    design: coreComponents
  }`;
  }

  // Backend + a separate SPA frontend.  The design pack picks the
  // frontend platform: svelte packs (shadcnSvelte / flowbite) →
  // `platform: svelte`, vue packs (vuetify / shadcnVue) →
  // `platform: vue`; everything else stays React.
  const frontendPlatform = SVELTE_DESIGN_PACKS.includes(design)
    ? "svelte"
    : VUE_DESIGN_PACKS.includes(design)
      ? "vue"
      : "react";
  const frontendPort = frontendPlatform === "vue" ? VUE_FRONTEND_PORT : FRONTEND_PORT;
  return `${storage}

  deployable api {
    platform: ${platform},
    contexts: [${context}],
    dataSources: [appState],
    port: ${BACKEND_PORT[platform]}
  }

  deployable webApp {
    platform: ${frontendPlatform},
    targets: api,
    ui: WebApp,
    port: ${frontendPort},
    design: ${design}
  }`;
}

/** Render the starter `.ddd` source for the chosen template + platform. */
export function renderStarter(opts: {
  name: string;
  template: StarterTemplate;
  platform: StarterPlatform;
  design: DesignPack;
}): string {
  const sys = toSystemName(opts.name);
  const domain = opts.template === "crud" ? crudDomain() : blankDomain();
  const deployment = renderDeployment(opts.platform, opts.design, domain.context);

  return `// ${sys} — scaffolded by \`ddd new\` (template: ${opts.template}, platform: ${opts.platform}).
// Edit this model, then regenerate:
//   ddd generate system main.ddd -o . && docker compose up

system ${sys} {

${domain.source}

  ui WebApp with scaffold(subdomains: [Core]) {
  }

${deployment}
}
`;
}

/** The project README — platform-aware run instructions. */
export function renderReadme(opts: {
  name: string;
  platform: StarterPlatform;
  design: DesignPack;
}): string {
  const backendPort = BACKEND_PORT[opts.platform];
  const liveView = isLiveView(opts.platform, opts.design);
  const svelte = SVELTE_DESIGN_PACKS.includes(opts.design);
  const frontendLine = liveView
    ? `- Frontend (LiveView):  http://localhost:${backendPort}`
    : svelte
      ? `- Frontend (Svelte):    http://localhost:${FRONTEND_PORT}`
      : `- Frontend (React):     http://localhost:${FRONTEND_PORT}`;

  return `# ${opts.name}

A Loom project scaffolded with \`ddd new\` — platform **${opts.platform}**${
    liveView ? " (Phoenix LiveView)" : `, frontend **${opts.design}**`
  }.

\`main.ddd\` is the single source of truth for the whole stack.

## Run it

\`\`\`bash
# 1. Generate the project tree + docker-compose.yml in place
ddd generate system main.ddd -o .

# 2. Build and start the stack
docker compose up --build
\`\`\`

Then open:

- Backend API:          http://localhost:${backendPort}
${frontendLine}

## Edit the model

Change \`main.ddd\` and re-run \`ddd generate system main.ddd -o .\`.
Generation overwrites its own output every run; pin any file you hand-edit
in \`.loomignore\` so it survives (see the comments in that file).

## Learn more

- Language reference: https://github.com/lemmit/loc/blob/main/docs/language.md
- CLI & workflow:     https://github.com/lemmit/loc/blob/main/docs/tools.md
`;
}

/** A `.loomignore` seeded with the customary pins, commented out so nothing
 *  is pinned until the author opts in (uncomments a line). */
export function renderLoomignore(): string {
  return `# .loomignore — pin files you hand-edit so \`ddd generate system\` leaves
# them alone. gitignore syntax; paths are relative to this directory.
# See https://github.com/lemmit/loc/blob/main/docs/tools.md#loomignore
#
# Uncomment the entrypoints/config you customise:
# Program.cs
# /index.ts
# package.json
# *.csproj
# tsconfig.json
# drizzle.config.ts
`;
}
