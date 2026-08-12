// The `Chart` primitive's Vue runtime — `src/components/LoomChart.vue`.
//
// WHY A COMPONENT, AND WHY NO CHARTING LIBRARY
// --------------------------------------------
// A chart plots a grouped projection's rows, and those rows are already decoded
// on this side (the TanStack query's `.data`).  So the geometry is arithmetic
// and the output is inline SVG — the same conclusion the HEEx, Feliz and
// Flutter legs reached in their own languages, and for the same reason.  React
// is the exception, and only because its eight packs each already ship a
// charting dependency; nothing about Vue makes one necessary.
//
// It is a COMPONENT rather than markup inlined at the call site because the
// scale maths needs the whole row set before it can place anything, and a Vue
// template expression is a poor place to compute a maximum.  The same argument
// made `LoomChart` a component on HEEx, a widget on Flutter and a `View.chart`
// helper on Feliz — four targets, one shape.
//
// WHY THE PROP IS A FLAT POINT LIST
// ---------------------------------
// `rows` is `{ label, value }[]`, not the projection's own rows plus two key
// names.  The call site knows the row type and applies the `x:`/`y:` accessors
// itself (`vueTarget.renderChartData`), which keeps this component free of any
// per-projection typing — exactly the split Flutter's `LoomChartPoint` draws.

import { lines } from "../../util/code-builder.js";

/** `src/components/LoomChart.vue` — emitted only for a ui that charts. */
export function renderVueChartRuntime(): string {
  return lines(
    "<!-- Auto-generated.  Do not edit by hand. -->",
    "<script setup lang='ts'>",
    "import { computed } from 'vue';",
    "",
    "export interface LoomChartPoint {",
    "  label: string;",
    "  value: number;",
    "}",
    "",
    "const props = defineProps<{ isBar: boolean; label: string; rows: LoomChartPoint[] }>();",
    "",
    "const WIDTH = 320;",
    "const HEIGHT = 160;",
    "",
    // An all-zero (or empty) series would divide by zero and place NaN
    // coordinates, which the browser renders as an invisible chart rather than
    // an error — the floor keeps a flat series flat instead.
    "const max = computed(() => Math.max(1, ...props.rows.map((r) => r.value)));",
    "const slot = computed(() => WIDTH / Math.max(1, props.rows.length));",
    "",
    "const bars = computed(() =>",
    "  props.rows.map((r, i) => {",
    "    const h = (r.value / max.value) * HEIGHT;",
    "    return {",
    "      key: `${r.label}-${i}`,",
    "      x: slot.value * i + slot.value * 0.15,",
    "      y: HEIGHT - h,",
    "      width: slot.value * 0.7,",
    "      height: h,",
    "    };",
    "  }),",
    ");",
    "",
    "const points = computed(() =>",
    "  props.rows",
    "    .map((r, i) => `${slot.value * (i + 0.5)},${HEIGHT - (r.value / max.value) * HEIGHT}`)",
    "    .join(' '),",
    ");",
    "</script>",
    "",
    "<template>",
    // A chart is an image of data (the registry's a11y contract) — the derived
    // name is the only thing a screen reader gets, since the marks carry none.
    '  <svg :viewBox="`0 0 ${320} ${160}`" role="img" :aria-label="label" class="loom-chart">',
    '    <template v-if="isBar">',
    '      <rect v-for="b in bars" :key="b.key" :x="b.x" :y="b.y" :width="b.width" :height="b.height" fill="currentColor" />',
    "    </template>",
    '    <polyline v-else :points="points" fill="none" stroke="currentColor" stroke-width="2" />',
    "  </svg>",
    "</template>",
    "",
    "<style scoped>",
    ".loom-chart {",
    "  width: 100%;",
    "  height: 10rem;",
    "}",
    "</style>",
  );
}
