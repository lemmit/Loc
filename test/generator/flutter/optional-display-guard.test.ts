import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// `Money` / `DateDisplay` / `EnumBadge` over an OPTIONAL field (ledger F2-CFE-9).
//
// A `money?` / `datetime?` / `<Enum>?` field decodes to `double?` / `DateTime?` /
// `String?` in `models.dart`, but `intl`'s `NumberFormat.format(num)` and
// `DateFormat.format(DateTime)` take NON-nullable arguments — so the bare call
// the pack emitted was a Dart compile error on every optional money/datetime
// column, and `EnumBadge`'s `.toString()` printed the literal word "null" to
// the user.  The JSX packs' `EmptyValue` renders an em-dash for the first two
// and nothing for the badge; Flutter now matches.
//
// The guard cannot branch on the field's optionality: a scaffold-synthesized
// table accessor types `row.<field>` as `string` for EVERY field (see
// `provableStringType`'s header), so the pack has no optionality signal.  It is
// an immediately-applied function literal with a NULLABLE parameter instead,
// which accepts a nullable AND a non-nullable argument with no analyzer lint —
// and `flutter analyze` fails on lints.
// ---------------------------------------------------------------------------

const SRC = `
system Fl {
  subdomain S { context C {
    enum St { A, B }
    aggregate Thing { name: string  total: money?  at: datetime?  kind: St? }
    repository Things for Thing { }
  } }
  ui App {
    framework: flutter
    page ThingList {
      route: "/things"
      body: Stack {
        QueryView { of: Thing.all, data: rows => Table {
          Column { "Total", r => Money { r.total } },
          Column { "At", r => DateDisplay { r.at } },
          Column { "Kind", r => EnumBadge { r.kind } },
          rows: rows
        } }
      }
    }
  }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
  deployable web { platform: flutter targets: api ui: App port: 3001 }
}
`;

describe("flutter optional display primitives", () => {
  it("null-guards Money / DateDisplay / EnumBadge instead of passing a nullable to intl", async () => {
    const files = await generateSystemFiles(SRC);
    const page = [...files.entries()].find(([k]) =>
      k.endsWith("pages/thing_list_page.dart"),
    )?.[1] as string;
    expect(page, "no thing_list_page.dart emitted").toBeDefined();

    // The model side is genuinely nullable — the premise of the whole row.
    const models = [...files.entries()].find(([k]) => k.endsWith("lib/models.dart"))![1];
    // `total: money?` — a money value is the wire STRING end to end since
    // M-T1.21, so the nullable model field is `String?`, not `double?`.
    expect(models).toContain("final String? total;");
    expect(models).toContain("final DateTime? at;");
    expect(models).toContain("final String? kind;");

    // Pre-fix: `NumberFormat.decimalPattern().format(row.total)` — `double?` is
    // not assignable to `num`.
    expect(page).not.toMatch(/NumberFormat\.decimalPattern\(\)\.format\(row\.total\)/);
    expect(page).toContain(
      "((num? v) => v == null ? '—' : NumberFormat.decimalPattern().format(v))(LoomMoney.toNum(row.total))",
    );

    // Pre-fix: `DateFormat.yMMMd().format(row.at)` — `DateTime?` vs `DateTime`.
    expect(page).not.toMatch(/DateFormat\.yMMMd\(\)\.format\(row\.at\)/);
    expect(page).toContain(
      "((DateTime? v) => v == null ? '—' : DateFormat.yMMMd().format(v))(row.at)",
    );

    // Pre-fix: `Text(row.kind.toString())` — renders the word "null".
    expect(page).not.toMatch(/Text\(row\.kind\.toString\(\)\)/);
    expect(page).toContain("((Object? v) => v == null ? '' : v.toString())(row.kind)");

    // The intl import still rides the `usesIntl` content sniff — the formatter
    // names moved inside the closure, they did not disappear.
    expect(page).toContain("import 'package:intl/intl.dart';");
  });
});
