# Acme — dataSource routing

Derived view of how `dataSource` declarations route domain contexts to physical storage.
Authoritative source is the `.ddd` model; the validators (`src/ir/validate/validate.ts` +
`src/language/validators/datasource.ts`) enforce the rules — this is the at-a-glance picture.

## Per deployable

### api — `platform: dotnet`

| Context | Kind | DataSource | Storage | Storage type | Schema | TablePrefix |
| --- | --- | --- | --- | --- | --- | --- |
| Customers | state | customersState | primarySql | postgres | customers _(default)_ | — |
| Orders | state | ordersState | primarySql | postgres | orders _(default)_ | — |
| Products | state | productsState | primarySql | postgres | products _(default)_ | — |

### catalogWeb — `platform: hono`

| Context | Kind | DataSource | Storage | Storage type | Schema | TablePrefix |
| --- | --- | --- | --- | --- | --- | --- |
| Customers | state | customersState | primarySql | postgres | customers _(default)_ | — |
| Products | state | productsState | primarySql | postgres | products _(default)_ | — |

### catalogApi — `platform: dotnet`

| Context | Kind | DataSource | Storage | Storage type | Schema | TablePrefix |
| --- | --- | --- | --- | --- | --- | --- |
| Customers | state | customersState | primarySql | postgres | customers _(default)_ | — |
| Products | state | productsState | primarySql | postgres | products _(default)_ | — |

## Per storage

| Storage | Type | Used by |
| --- | --- | --- |
| primarySql | postgres | api → Products (state); api → Orders (state); api → Customers (state); catalogWeb → Products (state); catalogWeb → Customers (state); catalogApi → Products (state); catalogApi → Customers (state) |
