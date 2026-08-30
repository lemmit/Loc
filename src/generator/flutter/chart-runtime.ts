// The `Chart` primitive's Flutter runtime — `lib/chart.dart` (M-T1.3).
//
// WHY THERE IS NO CHARTING PACKAGE HERE
// -------------------------------------
// A chart plots a GROUPED query-time projection's rows, and on this side those
// rows are already decoded into the Riverpod provider the page watches — so
// the geometry is arithmetic and the output is a `CustomPainter`.  Adding
// `fl_chart` (or any sibling) would buy axis chrome at the cost of a pub
// dependency, a version to keep current, and a licence to vet, for output this
// file produces in ~60 lines.  The Feliz and HEEx legs reached the same
// conclusion in their own languages; the tsx legs are the exception, and only
// because eight packs already ship a charting library each.
//
// WHY THE POINT LIST IS FLAT RATHER THAN GENERIC
// ----------------------------------------------
// `LoomChart` takes `List<LoomChartPoint>` — a label + a double — not a
// `List<T>` plus accessor closures.  The call site knows the row type and can
// map into it in one expression, so making the widget generic would push a type
// parameter through `CustomPainter` (which cannot be generic over its repaint
// comparison without boilerplate) to express nothing the caller hasn't already
// resolved.  The accessors are applied at the call site (`flutter/pack.ts`),
// which is also where the walker's `x:`/`y:` field names are in scope.

import { lines } from "../../util/code-builder.js";

/** `lib/chart.dart` — emitted only for a ui that renders a `Chart`. */
export function renderFlutterChartRuntime(): string {
  return lines(
    "// Auto-generated.  Do not edit by hand.",
    "import 'package:flutter/material.dart';",
    "",
    "/// One plotted point: the category-axis label and its numeric value.",
    "class LoomChartPoint {",
    "  final String label;",
    "  final double value;",
    "",
    "  const LoomChartPoint(this.label, this.value);",
    "}",
    "",
    "/// A line or bar chart over a grouped projection's rows.",
    "///",
    "/// `Semantics(image: true, label: …)` is the Flutter spelling of the",
    '/// registry\'s a11y contract for `Chart` (`role="img"` + a required name):',
    "/// the painted marks carry no semantics of their own, so the derived label",
    "/// is all a screen reader gets.",
    "class LoomChart extends StatelessWidget {",
    "  final bool isBar;",
    "  final String label;",
    "  final List<LoomChartPoint> points;",
    "",
    "  const LoomChart({super.key, required this.isBar, required this.label, required this.points});",
    "",
    "  @override",
    "  Widget build(BuildContext context) {",
    "    return Semantics(",
    "      image: true,",
    "      label: label,",
    "      child: SizedBox(",
    "        height: 160,",
    "        child: CustomPaint(",
    "          size: Size.infinite,",
    "          painter: _LoomChartPainter(",
    "            isBar: isBar,",
    "            points: points,",
    "            color: Theme.of(context).colorScheme.primary,",
    "          ),",
    "        ),",
    "      ),",
    "    );",
    "  }",
    "}",
    "",
    "class _LoomChartPainter extends CustomPainter {",
    "  final bool isBar;",
    "  final List<LoomChartPoint> points;",
    "  final Color color;",
    "",
    "  _LoomChartPainter({required this.isBar, required this.points, required this.color});",
    "",
    "  @override",
    "  void paint(Canvas canvas, Size size) {",
    "    if (points.isEmpty) return;",
    "    // An all-zero series would divide by zero and paint NaN offsets, which",
    "    // Flutter draws as nothing at all — the floor keeps a flat series flat.",
    "    final maxValue = points",
    "        .map((p) => p.value)",
    "        .fold<double>(1, (a, b) => a > b ? a : b);",
    "    final slot = size.width / points.length;",
    "    final paint = Paint()..color = color;",
    "    if (isBar) {",
    "      for (var i = 0; i < points.length; i++) {",
    "        final barHeight = (points[i].value / maxValue) * size.height;",
    "        canvas.drawRect(",
    "          Rect.fromLTWH(slot * i + slot * 0.15, size.height - barHeight, slot * 0.7, barHeight),",
    "          paint,",
    "        );",
    "      }",
    "      return;",
    "    }",
    "    final stroke = Paint()",
    "      ..color = color",
    "      ..style = PaintingStyle.stroke",
    "      ..strokeWidth = 2;",
    "    final path = Path();",
    "    for (var i = 0; i < points.length; i++) {",
    "      final x = slot * (i + 0.5);",
    "      final y = size.height - (points[i].value / maxValue) * size.height;",
    "      if (i == 0) {",
    "        path.moveTo(x, y);",
    "      } else {",
    "        path.lineTo(x, y);",
    "      }",
    "    }",
    "    canvas.drawPath(path, stroke);",
    "  }",
    "",
    "  @override",
    "  bool shouldRepaint(_LoomChartPainter old) =>",
    "      old.isBar != isBar || old.color != color || old.points != points;",
    "}",
  );
}
