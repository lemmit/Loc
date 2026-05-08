// Auto-generated.
import { Routes, Route, Link, useLocation } from "react-router-dom";
import { AppShell, Burger, Divider, Group, Title, NavLink, Anchor, Alert, Button, Stack } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import React from "react";
import Home from "./pages/home";
import CustomerList from "./pages/customers/list";
import CustomerNew from "./pages/customers/new";
import CustomerDetail from "./pages/customers/detail";
import OrderList from "./pages/orders/list";
import OrderNew from "./pages/orders/new";
import OrderDetail from "./pages/orders/detail";

// App-level error boundary catches render-time crashes from any
// page component.  Without it, an unhandled exception inside
// e.g. a detail page would blank the entire shell and leave the
// user with no path back.  Reset on click navigates back to the
// home route, matching the expectation that "the dashboard
// keeps working when one page is broken".
class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("App error boundary caught:", error, info.componentStack);
  }
  override render() {
    if (this.state.error) {
      return (
        <Stack data-testid="app-error" p="md">
          <Alert color="red" title="Something went wrong">
            {this.state.error.message}
          </Alert>
          <Group>
            <Button
              variant="default"
              onClick={() => {
                this.setState({ error: null });
                window.location.assign("/");
              }}
            >
              Back to home
            </Button>
          </Group>
        </Stack>
      );
    }
    return this.props.children;
  }
}

function NotFound() {
  return (
    <Stack data-testid="not-found" p="md">
      <Title order={2}>Not found</Title>
      <Anchor component={Link} to="/">← Back to home</Anchor>
    </Stack>
  );
}

// Active-route helper — drives NavLink's `active` prop.  Defaults
// to a prefix match so /orders/<id> + /orders/new + /orders all
// keep the "Orders" link highlighted; the `exact` opt-in narrows
// to literal equality (used by /workflows + /views index links so
// they don't shadow their per-item children).
function useIsActive() {
  const location = useLocation();
  return (path: string, opts?: { exact?: boolean }) => {
    if (opts?.exact) return location.pathname === path;
    return (
      location.pathname === path || location.pathname.startsWith(path + "/")
    );
  };
}

export default function App() {
  const isActive = useIsActive();
  const [opened, { toggle }] = useDisclosure();
  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 240, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
              data-testid="nav-burger"
            />
            <Anchor component={Link} to="/" underline="never" c="inherit">
              <Group gap={8} align="center">
                <div style={{ width: 28, height: 28, borderRadius: 6, background: "var(--mantine-color-brand-6)" }} aria-hidden="true" />
                <Title order={4} style={{ letterSpacing: "-0.01em" }}>Sample</Title>
              </Group>
            </Anchor>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="md">
        <Stack gap={4} data-testid="nav-sidebar">
          <Divider my="xs" label="Aggregates" labelPosition="left" />
          <NavLink component={Link} to="/customers" label="Customers" active={isActive("/customers")} data-testid="nav-customers" />
          <NavLink component={Link} to="/orders" label="Orders" active={isActive("/orders")} data-testid="nav-orders" />
        </Stack>
      </AppShell.Navbar>
      <AppShell.Main>
        <AppErrorBoundary>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/customers" element={<CustomerList />} />
            <Route path="/customers/new" element={<CustomerNew />} />
            <Route path="/customers/:id" element={<CustomerDetail />} />
            <Route path="/orders" element={<OrderList />} />
            <Route path="/orders/new" element={<OrderNew />} />
            <Route path="/orders/:id" element={<OrderDetail />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AppErrorBoundary>
      </AppShell.Main>
    </AppShell>
  );
}
