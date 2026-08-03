// The state-controlled Modal's Flutter runtime — `lib/modal.dart`.
//
// `Modal { …, open: <state bool> }` is DECLARATIVE: the page says "this dialog
// is open when this flag is true".  Every web frontend renders that directly,
// because a dialog there is just an element you do or don't put in the tree.
// Flutter's dialogs are IMPERATIVE — `showDialog(...)` pushes a route and
// returns a future — so there is no widget to conditionally render, and that
// mismatch is why the primitive had no Dart renderer at all (a `Modal { open: }`
// used to degrade to a comment, silently dropping the dialog and everything in
// it).
//
// `LoomModalHost` is the bridge, and it is the standard one: a zero-size widget
// that watches the flag and drives `showDialog` on the edge, then reports the
// dismissal back so the page's state stays the single source of truth.  Three
// details make it correct rather than merely plausible:
//
//   * `addPostFrameCallback` — `showDialog` mutates the navigator, which cannot
//     happen during a build; deferring to after the frame is the supported way.
//   * an internal `_shown` latch — `didUpdateWidget` fires on every rebuild, so
//     without it a rebuild while open would stack a second dialog.
//   * `onClose` on the future's completion — a barrier tap or the system back
//     button dismisses the route without touching the flag, which would leave
//     the state stuck `true` and the dialog unopenable a second time.
//
// The `child` is built by the caller (the page's own walked markup), so the
// dialog body is the authored content, not a placeholder.

import { lines } from "../../util/code-builder.js";

/** `lib/modal.dart` — emitted only for a ui that uses a controlled Modal. */
export function renderFlutterModalRuntime(): string {
  return `${lines(
    "// Auto-generated.  Do not edit by hand.",
    "import 'package:flutter/material.dart';",
    "",
    "/// Bridges a DECLARATIVE `open` flag to Flutter's imperative `showDialog`.",
    "///",
    "/// Renders nothing itself: it sits in the widget tree next to the content",
    "/// that owns the flag, opens the dialog when the flag goes true, and calls",
    "/// [onClose] when the dialog goes away for ANY reason (submit, barrier tap,",
    "/// system back) so the caller's state never desynchronises from the UI.",
    "class LoomModalHost extends StatefulWidget {",
    "  const LoomModalHost({",
    "    super.key,",
    "    required this.open,",
    "    required this.onClose,",
    "    required this.child,",
    "    this.title,",
    "  });",
    "",
    "  /// Whether the dialog should currently be showing.",
    "  final bool open;",
    "",
    "  /// Called once the dialog has been dismissed, however that happened.",
    "  final VoidCallback onClose;",
    "",
    "  /// The dialog's content.",
    "  final Widget child;",
    "",
    "  /// Optional dialog title.",
    "  final Widget? title;",
    "",
    "  @override",
    "  State<LoomModalHost> createState() => _LoomModalHostState();",
    "}",
    "",
    "class _LoomModalHostState extends State<LoomModalHost> {",
    "  // Guards against a rebuild-while-open stacking a second dialog.",
    "  bool _shown = false;",
    "",
    "  @override",
    "  void initState() {",
    "    super.initState();",
    "    _sync();",
    "  }",
    "",
    "  @override",
    "  void didUpdateWidget(covariant LoomModalHost oldWidget) {",
    "    super.didUpdateWidget(oldWidget);",
    "    _sync();",
    "  }",
    "",
    "  void _sync() {",
    "    if (!widget.open || _shown) return;",
    "    _shown = true;",
    "    // `showDialog` pushes a route, which cannot run during a build.",
    "    WidgetsBinding.instance.addPostFrameCallback((_) {",
    "      if (!mounted) return;",
    "      showDialog<void>(",
    "        context: context,",
    "        builder: (BuildContext dialogContext) => AlertDialog(",
    "          title: widget.title,",
    "          content: SizedBox(",
    "            width: double.maxFinite,",
    "            child: SingleChildScrollView(child: widget.child),",
    "          ),",
    "        ),",
    "      ).then((_) {",
    "        _shown = false;",
    "        // A barrier tap or the back button dismisses the route without",
    "        // touching the flag — tell the caller so its state follows.",
    "        widget.onClose();",
    "      });",
    "    });",
    "  }",
    "",
    "  @override",
    "  Widget build(BuildContext context) => const SizedBox.shrink();",
    "}",
  )}\n`;
}
