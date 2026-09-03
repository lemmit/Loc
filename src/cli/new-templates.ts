// Starter-project templates for `ddd new` (the on-ramp verb).
//
// Pure string builders — no IR, no fs. `renderStarter` composes a shared
// DOMAIN block with a per-platform DEPLOYMENT block so the same model wires
// to whichever backend/frontend the author picked. The CLI validates the
// rendered source (via the in-memory `validate()` toolkit) before writing,
// so a template that drifts from the grammar fails fast rather than shipping
// a broken starter — `test/cli/new.test.ts` pins every combination.

import {
  BUILTIN_PACK_LATEST,
  type BuiltinPackFamily,
  type PackFormat,
  packFormatForBuiltin,
} from "../util/builtin-formats.js";

export type StarterPlatform = "node" | "dotnet" | "elixir" | "java" | "python";
export type StarterTemplate = "blank" | "crud";
/** A design pack `ddd new` can scaffold = a registered built-in pack family.
 *  Not a second hand-written union: the packs this verb offers and the packs
 *  that exist are the same set by construction. */
export type DesignPack = BuiltinPackFamily;

export const STARTER_PLATFORMS: readonly StarterPlatform[] = [
  "node",
  "dotnet",
  "elixir",
  "java",
  "python",
];
export const STARTER_TEMPLATES: readonly StarterTemplate[] = ["blank", "crud"];

/** Frontend `platform:` a pack's FORMAT scaffolds into.  `heex` packs are the
 *  exception: they mount on the Phoenix backend itself (one fullstack
 *  deployable), so they name no separate frontend platform. */
const FRONTEND_PLATFORM_FOR_FORMAT: Record<PackFormat, "react" | "svelte" | "vue" | "angular"> = {
  tsx: "react",
  svelte: "svelte",
  vue: "vue",
  angular: "angular",
  // Never read for a heex pack — `isLiveView` diverts those first — but the
  // record stays total so a NEW pack format cannot be added without deciding
  // what `ddd new` does with it.
  heex: "react",
};

/** The format the bareword `design: <family>` resolves to (via
 *  `BUILTIN_PACK_LATEST`), e.g. `mantine` → `tsx`. */
export function packFormatOf(design: DesignPack): PackFormat {
  const format = packFormatForBuiltin(design);
  if (!format) {
    // Unreachable: `design` is a registered family and every family's latest
    // version is in BUILTIN_PACK_FORMATS (pinned by builtin-pack tests).
    throw new Error(`no registered format for design pack '${design}'`);
  }
  return format;
}

const FORMAT_ORDER: readonly PackFormat[] = ["tsx", "vue", "svelte", "angular", "heex"];

/** Every design pack `ddd new --design` accepts, DERIVED from the built-in
 *  pack registry (`src/util/builtin-formats.ts`) and grouped by format.
 *
 *  It used to be a hand-written list, and it drifted the way hand-written
 *  lists do: seven of the thirteen registered families, so `--design vuetify`
 *  worked while `--help` denied it existed and `--design primeng` was
 *  rejected outright though the pack ships.  Deriving it means adding a pack
 *  directory + its registry entry is the whole change. */
export const DESIGN_PACKS: readonly DesignPack[] = (
  Object.keys(BUILTIN_PACK_LATEST) as DesignPack[]
)
  .slice()
  .sort(
    (a, b) =>
      FORMAT_ORDER.indexOf(packFormatOf(a)) - FORMAT_ORDER.indexOf(packFormatOf(b)) ||
      a.localeCompare(b),
  );

/** The packs of one format, in `DESIGN_PACKS` order — the grouping every
 *  human-facing list (the `--design` help, the `new` README) reads. */
export function designPacksForFormat(format: PackFormat): readonly DesignPack[] {
  return DESIGN_PACKS.filter((d) => packFormatOf(d) === format);
}

export const REACT_DESIGN_PACKS: readonly DesignPack[] = designPacksForFormat("tsx");
export const SVELTE_DESIGN_PACKS: readonly DesignPack[] = designPacksForFormat("svelte");
/** Vue-format packs — picking one scaffolds a `platform: vue` frontend
 *  (the design implies the frontend platform via its pack format). */
export const VUE_DESIGN_PACKS: readonly DesignPack[] = designPacksForFormat("vue");
export const ANGULAR_DESIGN_PACKS: readonly DesignPack[] = designPacksForFormat("angular");
/** Phoenix LiveView packs — these mount ON the elixir backend. */
export const LIVEVIEW_DESIGN_PACKS: readonly DesignPack[] = designPacksForFormat("heex");

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
/** The Angular frontend's port (mirrors the angular platform's defaultPort). */
export const ANGULAR_FRONTEND_PORT = 3004;

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
 *  shape — one deployable that both serves the API and mounts a HEEx UI.
 *  Keyed on the pack's FORMAT, so every heex pack (coreComponents, daisyui,
 *  the next one) takes this shape without being named here. */
function isLiveView(platform: StarterPlatform, design: DesignPack): boolean {
  return platform === "elixir" && packFormatOf(design) === "heex";
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
    design: ${design}
  }`;
  }

  // Backend + a separate SPA frontend.  The design pack picks the frontend
  // platform through its FORMAT (`vuetify` is a vue pack, therefore a
  // `platform: vue` deployable) — one mapping, in FRONTEND_PLATFORM_FOR_FORMAT,
  // instead of one `includes()` chain per pack family.
  const frontendPlatform = FRONTEND_PLATFORM_FOR_FORMAT[packFormatOf(design)];
  const frontendPort =
    frontendPlatform === "vue"
      ? VUE_FRONTEND_PORT
      : frontendPlatform === "angular"
        ? ANGULAR_FRONTEND_PORT
        : FRONTEND_PORT;
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

  // Authorization is opt-in in a fresh model.  When you wire real auth, prefer
  // deny-by-default: every client-reachable command AND read (operations,
  // creates, destroys, workflows, views, repository finds) must then declare a
  // \`requires <expr>\` gate — \`requires true\` is the explicit "intentionally
  // public" escape.  Mark the deployable \`auth: required\` to enforce it.
  //   auth {
  //     enforcement: denyByDefault
  //     oidc { issuer: env("OIDC_ISSUER") clientId: env("OIDC_CLIENT_ID") }
  //   }

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
  // Same format→frontend mapping the model itself was rendered from, so the
  // README can never name a framework or a port the deployment doesn't use.
  const framework = FRONTEND_PLATFORM_FOR_FORMAT[packFormatOf(opts.design)];
  const frontendPort =
    framework === "vue"
      ? VUE_FRONTEND_PORT
      : framework === "angular"
        ? ANGULAR_FRONTEND_PORT
        : FRONTEND_PORT;
  const frameworkLabel = { react: "React", svelte: "Svelte", vue: "Vue", angular: "Angular" }[
    framework
  ];
  const frontendLine = liveView
    ? `- Frontend (LiveView):  http://localhost:${backendPort}`
    : `- Frontend (${frameworkLabel}): http://localhost:${frontendPort}`;

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
