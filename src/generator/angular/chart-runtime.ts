// The `Chart` primitive's Angular runtime — `src/app/components/loom-chart.component.ts`.
//
// Seventh and last target, same conclusion as the four before it: a chart plots
// a grouped projection's rows, those rows are already decoded on this side, so
// the geometry is arithmetic and the output is inline SVG.  No charting
// library, nothing added to `package.json`.
//
// A standalone component used BY TAG (`<loom-chart …/>`), which is the shape
// Angular's own `DataGrid` child already uses — one import line plus one entry
// in the page's `imports: []`.
//
// WHY THE GEOMETRY IS IN THE COMPONENT AND NOT THE TEMPLATE
// ---------------------------------------------------------
// This is the wrinkle that made Angular the last leg.  Its templates resolve
// identifiers against the COMPONENT INSTANCE, never a module import or a JS
// global — which is why the page shell already re-exposes `sortRows`,
// `filterRows`, `Math` and `String` as `protected readonly` members.  Scale
// maths written inline in a template binding would need every one of its
// helpers lifted that way.  Computing it inside the component sidesteps the
// whole class of problem: the page's binding passes plain data, and the
// component owns the arithmetic.

import { lines } from "../../util/code-builder.js";

/** `src/app/components/loom-chart.component.ts` — emitted only for a ui that charts. */
export function renderAngularChartRuntime(): string {
  return lines(
    "// Auto-generated.  Do not edit by hand.",
    'import { Component, computed, Input, signal } from "@angular/core";',
    "",
    "export interface LoomChartPoint {",
    "  label: string;",
    "  value: number;",
    "}",
    "",
    "const WIDTH = 320;",
    "const HEIGHT = 160;",
    "",
    "@Component({",
    '  selector: "loom-chart",',
    "  standalone: true,",
    "  template: `",
    // A chart is an image of data (the registry's a11y contract) — the derived
    // name is the only thing a screen reader gets, since the marks carry none.
    '    <svg viewBox="0 0 320 160" role="img" [attr.aria-label]="label" class="loom-chart">',
    "      @if (isBar) {",
    "        @for (b of bars(); track b.key) {",
    '          <rect [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.width" [attr.height]="b.height" fill="currentColor" />',
    "        }",
    "      } @else {",
    '        <polyline [attr.points]="points()" fill="none" stroke="currentColor" stroke-width="2" />',
    "      }",
    "    </svg>",
    "  `,",
    "  styles: `",
    "    .loom-chart { width: 100%; height: 10rem; }",
    "  `,",
    "})",
    "export class LoomChart {",
    "  @Input() isBar = true;",
    '  @Input() label = "";',
    "",
    // The rows arrive as a plain binding but the geometry is `computed`, so a
    // refetch re-derives it — hence the signal behind the setter rather than a
    // bare field.
    "  private readonly rowsSignal = signal<LoomChartPoint[]>([]);",
    "",
    "  @Input() set rows(value: LoomChartPoint[]) {",
    "    this.rowsSignal.set(value ?? []);",
    "  }",
    "",
    // An all-zero (or empty) series would divide by zero and place NaN
    // coordinates, which the browser renders as an invisible chart rather than
    // an error — the floor keeps a flat series flat instead.
    "  protected readonly max = computed(() =>",
    "    Math.max(1, ...this.rowsSignal().map((r) => r.value)),",
    "  );",
    "",
    "  protected readonly slot = computed(() => WIDTH / Math.max(1, this.rowsSignal().length));",
    "",
    "  protected readonly bars = computed(() =>",
    "    this.rowsSignal().map((r, i) => {",
    "      const h = (r.value / this.max()) * HEIGHT;",
    "      return {",
    "        key: `${r.label}-${i}`,",
    "        x: this.slot() * i + this.slot() * 0.15,",
    "        y: HEIGHT - h,",
    "        width: this.slot() * 0.7,",
    "        height: h,",
    "      };",
    "    }),",
    "  );",
    "",
    "  protected readonly points = computed(() =>",
    "    this.rowsSignal()",
    "      .map((r, i) => `${this.slot() * (i + 0.5)},${HEIGHT - (r.value / this.max()) * HEIGHT}`)",
    '      .join(" "),',
    "  );",
    "}",
  );
}
