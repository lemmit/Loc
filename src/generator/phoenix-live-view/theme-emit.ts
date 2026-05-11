// ---------------------------------------------------------------------------
// Batch C — Phoenix theme CSS emitter.
//
// Exports `renderThemeCss(theme: ThemeIR | undefined): string` — produces a
// CSS file content string with custom properties derived from the system's
// `ThemeIR`.  The 10-shade ramps for brand and neutral colours are computed
// by the shared `prepareThemeVM` preparer (same one the React generator uses)
// so the generated CSS is token-equivalent to the Mantine theme.ts output.
//
// Output target: `priv/static/assets/theme.css` (caller decides the path).
//
// The ashPhoenix pack's `theme.heex.hbs` template emits a `<style>` block
// suitable for inlining in a `.html.heex` layout.  This module instead emits
// a standalone CSS file — no `<style>` wrapper — by extracting the same
// tokens from the ThemeVM and writing them directly.  This approach avoids
// a dependency on pack.render() for a pure-CSS output and matches the spec
// target (`priv/static/assets/theme.css`).
// ---------------------------------------------------------------------------

import type { ThemeIR } from "../../ir/loom-ir.js";
import { prepareThemeVM } from "../react/templating/preparers/theme.js";

/** Emit a standalone CSS file (`:root { ... }`) with design tokens from the
 *  system's ThemeIR.  Pass `undefined` when the system declares no `theme {}`
 *  block — the preparer fills in sensible defaults. */
export function renderThemeCss(theme: ThemeIR | undefined): string {
  const vm = prepareThemeVM(theme);

  const lines: string[] = [];
  lines.push(`/* Auto-generated. Design tokens for the Phoenix application. */`);
  lines.push(`:root {`);

  // Brand colour ramp — 10 shades, index 6 is the primary.
  lines.push(`  /* Brand colour ramp (10 shades, index 6 is the primary) */`);
  for (let i = 0; i < vm.brandShades.length; i++) {
    lines.push(`  --color-brand-${i}: ${vm.brandShades[i]};`);
  }
  lines.push(`  --color-primary: var(--color-brand-6);`);
  lines.push(``);

  // Neutral / surface colour ramp.
  lines.push(`  /* Neutral / surface colour ramp */`);
  for (let i = 0; i < vm.neutralShades.length; i++) {
    lines.push(`  --color-neutral-${i}: ${vm.neutralShades[i]};`);
  }
  lines.push(``);

  // Typography.
  lines.push(`  /* Typography */`);
  lines.push(`  --font-family: ${vm.fontFamily};`);
  lines.push(`  --font-family-mono: ${vm.fontFamilyMonospace};`);
  lines.push(``);

  // Border radius scale — five named steps + an alias pointing at the
  // chosen step.
  lines.push(`  /* Border radius */`);
  lines.push(`  --radius-xs: 0.125rem;`);
  lines.push(`  --radius-sm: 0.25rem;`);
  lines.push(`  --radius-md: 0.375rem;`);
  lines.push(`  --radius-lg: 0.5rem;`);
  lines.push(`  --radius-xl: 0.75rem;`);
  lines.push(`  --radius: var(--radius-${vm.radius});`);

  lines.push(`}`);
  lines.push(``);

  // Convenience base rules so the tokens take effect without per-class
  // overrides.
  lines.push(`body {`);
  lines.push(`  font-family: var(--font-family);`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`code, pre, kbd, samp {`);
  lines.push(`  font-family: var(--font-family-mono);`);
  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}
