import type {
  ComponentIR,
  DeployableIR,
  EnrichedBoundedContextIR,
  SystemIR,
} from "../../ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// Angular frontend generator — orchestrator.
//
// SLICE 1 (plumbing): this is a stub.  It keeps the platform registry's
// `Record<Platform, PlatformSurface>` total and lets a `platform: angular`
// deployable lower + compose end-to-end, emitting a placeholder README so
// the system orchestrator has a non-empty project tree.  The real
// generator (project shell, walker target, design-pack rendering) lands in
// Slices 3–7.  See docs/plans/angular-frontend-plan.md.
// ---------------------------------------------------------------------------

export interface GenerateAngularOptions {
  apiBaseUrl?: string;
  basePath?: string;
  topLevelComponents?: ComponentIR[];
}

export function generateAngularForContexts(
  _contexts: EnrichedBoundedContextIR[],
  _sys: SystemIR,
  deployable: DeployableIR,
  _options: GenerateAngularOptions = {},
): Map<string, string> {
  const out = new Map<string, string>();
  out.set(
    "README.md",
    [
      `# ${deployable.name}`,
      "",
      "Angular frontend (standalone components + signals).",
      "",
      "> Generator stub — Slice 1 plumbing only. The Angular project shell,",
      "> walker target, and design-pack rendering land in Slices 3–7.",
      "> See `docs/plans/angular-frontend-plan.md`.",
      "",
    ].join("\n"),
  );
  return out;
}
