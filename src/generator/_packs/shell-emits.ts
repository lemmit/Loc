import type { LoadedPack } from "./loader.js";

// ---------------------------------------------------------------------------
// Pack-declared shell emission — `shellFiles` (logical template →
// output path) and `shellGlobs` (`components-ui-*` → `src/components/
// ui/{1}.tsx`-style source-copy globs).  Shared by every SPA frontend
// orchestrator (React, Vue); the pack manifest owns the paths, so a
// vue pack pointing its glob at `{1}.vue` needs no code change.
// ---------------------------------------------------------------------------

/** Emit each entry in the pack manifest's `shellFiles` map (logical
 *  template name → output path).  Throws if a declared template name
 *  isn't registered in `emits`, naming the offending key — this keeps
 *  manifest typos loud rather than silently dropping shell files. */
export function emitShellFiles(pack: LoadedPack, out: Map<string, string>): void {
  const entries = Object.entries(pack.manifest.shellFiles ?? {});
  for (const [templateName, outputPath] of entries) {
    if (!pack.templates.has(templateName)) {
      throw new Error(
        `pack ${pack.manifest.name}: shellFiles entry "${templateName}" → "${outputPath}" not present in emits map.`,
      );
    }
    out.set(outputPath, pack.render(templateName, {}));
  }
}

/** Emit every template matching one of the pack manifest's
 *  `shellGlobs` patterns.  Each pattern uses `*` as a single-segment
 *  capture; the corresponding output-path template references the
 *  captures as `{1}`, `{2}`, etc.  shadcn uses this for its
 *  `components-ui-*` library: pattern `components-ui-*` →
 *  `src/components/ui/{1}.tsx`. */
export function emitShellGlobs(pack: LoadedPack, out: Map<string, string>): void {
  const entries = Object.entries(pack.manifest.shellGlobs ?? {});
  for (const [pattern, outputTemplate] of entries) {
    // Translate `components-ui-*` → /^components-ui-(.+)$/.  Escape
    // every other regex meta-char so a future pattern like
    // `cells.*-mobile` can't accidentally interpret `.` as the
    // any-char metacharacter.
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("^" + escaped.replace(/\*/g, "(.+)") + "$");
    for (const templateName of pack.templates.keys()) {
      const m = re.exec(templateName);
      if (!m) continue;
      let outputPath = outputTemplate;
      for (let i = 1; i < m.length; i++) {
        outputPath = outputPath.replaceAll(`{${i}}`, m[i]);
      }
      out.set(outputPath, pack.render(templateName, {}));
    }
  }
}
