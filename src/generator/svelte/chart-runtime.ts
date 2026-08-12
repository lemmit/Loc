// The `Chart` primitive's Svelte runtime — `src/lib/components/LoomChart.svelte`.
//
// Third framework to reach the same conclusion, and the reasoning has not
// changed: a chart plots a grouped projection's rows, those rows are already
// decoded on this side, so the geometry is arithmetic and the output is inline
// SVG.  No charting library, no dependency in the generated `package.json`.
//
// It is a COMPONENT rather than markup inlined at the call site because the
// scale maths needs the whole row set before it can place anything — the same
// argument that made `LoomChart` a component on HEEx and Vue, a widget on
// Flutter and a `View.chart` helper on Feliz.
//
// `rows` is the flat `{ label, value }[]` point shape (applied by
// `svelteTarget.renderChartData`), so this component carries no per-projection
// typing — same split as every sibling leg.

import { lines } from "../../util/code-builder.js";

/** `src/lib/components/LoomChart.svelte` — emitted only for a ui that charts. */
export function renderSvelteChartRuntime(): string {
  return lines(
    "<!-- Auto-generated.  Do not edit by hand. -->",
    "<script lang='ts'>",
    "  export interface LoomChartPoint {",
    "    label: string;",
    "    value: number;",
    "  }",
    "",
    // Svelte 5 runes: props via `$props()`, derived values via `$derived`.
    "  const { isBar, label, rows }: { isBar: boolean; label: string; rows: LoomChartPoint[] } =",
    "    $props();",
    "",
    "  const WIDTH = 320;",
    "  const HEIGHT = 160;",
    "",
    // An all-zero (or empty) series would divide by zero and place NaN
    // coordinates, which the browser renders as an invisible chart rather than
    // an error — the floor keeps a flat series flat instead.
    "  const max = $derived(Math.max(1, ...rows.map((r) => r.value)));",
    "  const slot = $derived(WIDTH / Math.max(1, rows.length));",
    "",
    "  const bars = $derived(",
    "    rows.map((r, i) => {",
    "      const h = (r.value / max) * HEIGHT;",
    "      return {",
    "        x: slot * i + slot * 0.15,",
    "        y: HEIGHT - h,",
    "        width: slot * 0.7,",
    "        height: h,",
    "      };",
    "    }),",
    "  );",
    "",
    "  const points = $derived(",
    "    rows",
    "      .map((r, i) => `${slot * (i + 0.5)},${HEIGHT - (r.value / max) * HEIGHT}`)",
    "      .join(' '),",
    "  );",
    "</script>",
    "",
    // A chart is an image of data (the registry's a11y contract) — the derived
    // name is the only thing a screen reader gets, since the marks carry none.
    '<svg viewBox="0 0 320 160" role="img" aria-label={label} class="loom-chart">',
    "  {#if isBar}",
    "    {#each bars as b}",
    '      <rect x={b.x} y={b.y} width={b.width} height={b.height} fill="currentColor" />',
    "    {/each}",
    "  {:else}",
    '    <polyline points={points} fill="none" stroke="currentColor" stroke-width="2" />',
    "  {/if}",
    "</svg>",
    "",
    "<style>",
    "  .loom-chart {",
    "    width: 100%;",
    "    height: 10rem;",
    "  }",
    "</style>",
  );
}
