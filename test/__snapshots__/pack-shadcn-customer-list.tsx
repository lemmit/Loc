// Auto-generated.
// shadcn pack — Phase 0 spike: native HTML5 + Tailwind utility classes
// (no shadcn UI library files yet — those land in Phase 2 with the
// full project shell).  Demonstrates that the same view-model
// produces a structurally-distinct output through a different pack.
import { Link, useNavigate } from "react-router-dom";
import { useAllCustomers } from "../../api/customer";

export default function CustomerList() {
  const navigate = useNavigate();
  const q = useAllCustomers();
  const count = q.data?.length ?? 0;
  return (
    <div data-testid="customers-list" className="flex flex-col gap-4">
      <nav data-testid="customers-list-breadcrumbs" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">Home</Link> <span>/</span> <span>Customers</span>
      </nav>
      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-2xl font-semibold tracking-tight">Customers</h2>
          <p className="text-sm text-muted-foreground">{q.isLoading ? "Loading…" : count === 1 ? "1 record" : count + " records"}</p>
        </div>
        <button onClick={() => navigate("/customers/new")} data-testid="customers-list-create" className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90">+ New customer</button>
      </div>
      {q.isLoading && (
        <div className="rounded-md border bg-card p-4">
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-7 rounded-sm bg-muted animate-pulse" />
            ))}
          </div>
        </div>
      )}
      {q.isError && <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive"><strong>Couldn't load customers: </strong>{(q.error as Error).message}</div>}
      {q.data && q.data.length === 0 && (
        <div data-testid="customers-list-empty" className="rounded-md border bg-card p-12">
          <div className="flex flex-col items-center gap-2">
            <p className="text-sm text-muted-foreground">No customers yet.</p>
            <button onClick={() => navigate("/customers/new")} className="text-sm text-primary hover:underline">
              Create your first customer
            </button>
          </div>
        </div>
      )}
      {q.data && q.data.length > 0 && (
        <div className="rounded-md border bg-card overflow-hidden">
          <table className="w-full caption-bottom text-sm">
            <thead className="border-b bg-muted/50">
              <tr>
                <th className="h-10 px-4 text-left align-middle font-medium text-muted-foreground">Id</th><th className="h-10 px-4 text-left align-middle font-medium text-muted-foreground">Username</th><th className="h-10 px-4 text-left align-middle font-medium text-muted-foreground">Email</th><th className="h-10 px-4 text-left align-middle font-medium text-muted-foreground">Age</th><th className="h-10 px-4 text-left align-middle font-medium text-muted-foreground">Balance</th><th className="h-10 px-4 text-left align-middle font-medium text-muted-foreground">Vip</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((row) => (
                <tr key={row.id} data-testid={`customers-row-${row.id}`} className="border-b last:border-0 hover:bg-muted/50 cursor-pointer transition-colors" onClick={() => navigate(`/customers/${row.id}`)}>
                  <td><Link to={`/customers/${row.id}`} data-testid={`customers-row-${row.id}-link`} className="text-primary underline-offset-4 hover:underline font-mono text-sm">{String(row.id).slice(0, 8) + "…"}</Link></td>
<td data-testid={`customers-row-${row.id}-username`}>{ row.username === null || row.username === undefined || row.username === "" ? <span className="text-muted-foreground">—</span> : String(row.username)}</td>
<td data-testid={`customers-row-${row.id}-email`}>{ row.email === null || row.email === undefined || row.email === "" ? <span className="text-muted-foreground">—</span> : String(row.email)}</td>
<td data-testid={`customers-row-${row.id}-age`} className="text-right tabular-nums">{ row.age === null || row.age === undefined ? <span className="text-muted-foreground">—</span> : new Intl.NumberFormat(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(row.age))}</td>
<td data-testid={`customers-row-${row.id}-balance`} className="text-right tabular-nums">{ row.balance === null || row.balance === undefined ? <span className="text-muted-foreground">—</span> : new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(row.balance))}</td>
<td data-testid={`customers-row-${row.id}-vip`}>{ row.vip === null || row.vip === undefined ? <span className="text-muted-foreground">—</span> : (row.vip ? <span className="font-medium">Yes</span> : <span className="text-muted-foreground">No</span>)}</td>

                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
