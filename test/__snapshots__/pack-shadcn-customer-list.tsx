// Auto-generated.
import { Link, useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertCircle, Plus } from "lucide-react";
import { useAllCustomers } from "../../api/customer";
import { IdValue, DateTimeValue, BoolValue, NumberValue, EmptyValue } from "@/lib/format";

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
        <Button onClick={() => navigate("/customers/new")} data-testid="customers-list-create"><Plus className="mr-2 h-4 w-4" />New customer</Button>
      </div>
      {q.isLoading && (
        <Card className="p-4">
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-7" />
            ))}
          </div>
        </Card>
      )}
      {q.isError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Couldn't load customers</AlertTitle>
          <AlertDescription>{(q.error as Error).message}</AlertDescription>
        </Alert>
      )}
      {q.data && q.data.length === 0 && (
        <Card className="p-12" data-testid="customers-list-empty">
          <div className="flex flex-col items-center gap-2">
            <p className="text-sm text-muted-foreground">No customers yet.</p>
            <Button variant="link" onClick={() => navigate("/customers/new")}>
              Create your first customer
            </Button>
          </div>
        </Card>
      )}
      {q.data && q.data.length > 0 && (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Id</TableHead>
<TableHead>Username</TableHead>
<TableHead>Email</TableHead>
<TableHead>Age</TableHead>
<TableHead>Balance</TableHead>
<TableHead>Vip</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((row) => (
                <TableRow key={row.id} data-testid={`customers-row-${row.id}`} className="cursor-pointer" onClick={() => navigate(`/customers/${row.id}`)}>
                  <TableCell><Link to={`/customers/${row.id}`} data-testid={`customers-row-${row.id}-link`} className="text-primary hover:underline"><IdValue id={row.id} /></Link></TableCell>

<TableCell data-testid={`customers-row-${row.id}-username`}>{ row.username === null || row.username === undefined || row.username === "" ? <EmptyValue /> : String(row.username)}</TableCell>

<TableCell data-testid={`customers-row-${row.id}-email`}>{ row.email === null || row.email === undefined || row.email === "" ? <EmptyValue /> : String(row.email)}</TableCell>

<TableCell data-testid={`customers-row-${row.id}-age`} className="text-right"><NumberValue value={row.age} /></TableCell>

<TableCell data-testid={`customers-row-${row.id}-balance`} className="text-right"><NumberValue value={row.balance} decimals={2} /></TableCell>

<TableCell data-testid={`customers-row-${row.id}-vip`}><BoolValue value={row.vip} /></TableCell>

                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
