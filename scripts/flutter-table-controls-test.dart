// Flutter `Table` control gate (M-T1.1) — copied into the CI scaffold-parity
// project by `generated-flutter-build.yml`, NOT emitted into user projects.
//
// Does the scaffolded Table's sort header and pager actually DRIVE the page
// state that the server-paged read is keyed by?  The provider is a Riverpod
// `.family` keyed by `(page, pageSize, sort, dir)`, so a control that moves
// that state re-keys the provider and refetches — server-driven, the same
// rationale as the Phoenix/LiveView leg.  A control that RENDERS and a control
// that WORKS look identical in a built bundle; only this tells them apart.
//
// Flutter web renders to CANVAS, so the Playwright DOM smoke that proves the
// Feliz leg is not available here.  A widget test is: it pumps the real
// generated page, taps the real generated controls and reads the real generated
// Notifier.  The read provider is overridden so the test observes the CONTROLS,
// not the network.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:app/pages/product_list_page.dart';
import 'package:app/reads.dart';
import 'package:app/models.dart';

void main() {
  testWidgets('sort header and pager drive the query state', (tester) async {
    final container = ProviderContainer(overrides: [
      productAllProvider.overrideWith(
        // `LoomPage` carries the whole page-metadata half of the envelope, not
        // just the count the pager needs — a member it doesn't decode is one the
        // DSL can't reach (M-T1.3 Defect B).  All five are required for the same
        // reason: a construction site that omits a count would report a wrong
        // one silently.
        (ref, q) async => const LoomPage<Product>(
          // `price` is a `money` field, which is the WIRE STRING in Dart
          // (`'1.0000'` — the fixed-scale decimal every backend serves), not a
          // number: money is `NUMERIC(19,4)` and a Dart `double` cannot hold
          // that range exactly (M-T1.21).
          items: <Product>[Product(id: 'p1', name: 'alpha', price: '1.0000', version: 1)],
          page: 1,
          pageSize: 1,
          total: 5,
          totalPages: 5,
        ),
      ),
    ]);
    addTearDown(container.dispose);

    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: const MaterialApp(home: ProductListPage()),
    ));
    await tester.pumpAndSettle();

    expect(container.read(productListProvider).pageNum, 1);
    expect(container.read(productListProvider).sortKey, '');

    // Tap the "Name" column header → sort key + ascending.
    await tester.tap(find.ancestor(of: find.text('Name'), matching: find.byType(InkWell)).first);
    await tester.pumpAndSettle();
    expect(container.read(productListProvider).sortKey, 'name');
    expect(container.read(productListProvider).sortDir, 'asc');

    // Re-tap the SAME column → direction flips (not a second key change).
    await tester.tap(find.ancestor(of: find.text('Name'), matching: find.byType(InkWell)).first);
    await tester.pumpAndSettle();
    expect(container.read(productListProvider).sortKey, 'name');
    expect(container.read(productListProvider).sortDir, 'desc');

    // Next / Prev move the page, and Prev is disabled on page 1.
    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();
    expect(container.read(productListProvider).pageNum, 2);
    await tester.tap(find.text('Prev'));
    await tester.pumpAndSettle();
    expect(container.read(productListProvider).pageNum, 1);
    final prev = tester.widget<TextButton>(
      find.ancestor(of: find.text('Prev'), matching: find.byType(TextButton)),
    );
    expect(prev.onPressed, isNull, reason: 'Prev must be disabled on page 1');
  });
}
