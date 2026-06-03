// The diagnostic shape every IR-validator check pushes into.  Lifted out of
// validate.ts so the per-theme check modules under `./` can share the type
// without importing back from the orchestrator (which would be a cycle).
// Re-exported from ../validate.ts so existing importers are unaffected.

export interface LoomDiagnostic {
  severity: "error" | "warning";
  message: string;
  /** Where the diagnostic came from — `<system>/<test-name>`. */
  source: string;
  /** Optional stable diagnostic code (e.g. `loom.criterion-not-selectable`)
   *  mirroring the `loom.*` codes the Langium-side validators attach.
   *  Lets tests and tooling match a diagnostic by identity rather than
   *  by message substring. Undefined on the older message-only diags. */
  code?: string;
}
