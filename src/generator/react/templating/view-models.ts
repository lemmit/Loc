// ---------------------------------------------------------------------------
// View-model types for the template-pack rendering layer.
//
// View-models are framework-neutral: they carry every *decision* the
// generator has made (humanized labels, formatter choice per type,
// link targets, op-icon picks, etc.) but no UI-library-specific text.
// Mantine, shadcn, and custom packs all render against the same VMs.
//
// VMs lean on string-typed JS expression slots (`valueExpr`,
// `keyExpr`) where the template needs to splice raw JS — for instance
// `row.customerId` or `data.id.slice(0, 8)`.  Templates are responsible
// for placing these inside `{}`/`{{{ }}}` JSX braces; preparers are
// responsible for ensuring the expressions evaluate correctly in the
// surrounding scope (e.g. `row` for table rows, `data` for detail).
// ---------------------------------------------------------------------------

/** A single cell in a list-page table row. */
export interface CellVM {
  /** Logical template name to render for this cell.  The pack's
   *  pack.json `emits` map resolves it to a .hbs file.  Examples:
   *  "cell-id-link", "cell-datetime", "cell-bool", "cell-number",
   *  "cell-enum", "cell-string", "cell-empty". */
  template: string;
  /** Stable testid for Playwright drivers — pack-invariant, computed
   *  by the preparer from slug + row id + field name.  Templates emit
   *  it verbatim on `<Table.Td data-testid={...}>`. */
  testIdExpr: string;
  /** JS expression that evaluates to the cell's raw value in the
   *  template's surrounding scope (typically `row.<field>`).  Templates
   *  splice this into JSX braces; semantics depend on `template`. */
  valueExpr: string;
  /** When the cell is a link, the React-Router target as a JS
   *  template-string expression — e.g. "`/customers/${row.id}`".
   *  Templates wrap the cell content in an Anchor pointing here.
   *  Undefined for non-link cells. */
  toExpr?: string;
  /** Decimal precision for number cells.  0 for int/long, 2 for
   *  decimal.  Undefined for other cell kinds. */
  decimals?: number;
}

/** A breadcrumb segment.  `to` is undefined for the current-page
 *  segment (rendered as plain text); otherwise rendered as an
 *  Anchor link. */
export interface BreadcrumbSegmentVM {
  label: string;
  to?: string;
}

/** Top-level view-model for an aggregate list page. */
export interface ListPageVM {
  /** PascalCase aggregate name — drives the React component export
   *  name (e.g. "Customer" → `function CustomerList()`). */
  aggregateName: string;
  /** Snake-case plural slug — drives URL paths and testid prefixes
   *  ("customers" → "/customers", "customers-list-create"). */
  slug: string;
  /** Plural humanised label for the page title and breadcrumb tail
   *  ("Customers", "Order Lines"). */
  humanPlural: string;
  /** Plural humanised lowercase label for empty-state / alert copy
   *  ("customers", "order lines"). */
  humanPluralLower: string;
  /** Singular humanised lowercase label for the "+ New <thing>"
   *  button copy ("customer", "order line"). */
  humanSingularLower: string;
  /** Breadcrumb trail for the list page — typically a 2-segment
   *  "Home / <Plural>" trail. */
  breadcrumbs: BreadcrumbSegmentVM[];
  /** Column header labels in row order, including the leading "Id"
   *  column. */
  columnHeaders: string[];
  /** One CellVM per column.  Index aligns with columnHeaders.  The
   *  first entry is always the id link cell. */
  cells: CellVM[];
  /** Name of the React Query hook that fetches the list, e.g.
   *  "useAllCustomers".  Imported from `../../api/<camel>.ts`. */
  hookName: string;
  /** camelCase aggregate name for the api-module import path
   *  (`../../api/<camel>` → `../../api/customer`). */
  hookImportPath: string;
}
