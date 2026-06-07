import React from "react";
import ReactDOM from "react-dom/client";
import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import App from "./App";
import { ErrorBoundary, installGlobalErrorLogging } from "./ErrorBoundary";

const theme = createTheme({
  fontFamilyMonospace:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
});

installGlobalErrorLogging();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </MantineProvider>
  </React.StrictMode>,
);
