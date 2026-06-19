// Auto-generated.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 3000, host: true, proxy: { "/api": (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITE_API_PROXY_TARGET ?? "http://localhost:8080" } },
  preview: { port: 3000, host: true, proxy: { "/api": (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITE_API_PROXY_TARGET ?? "http://localhost:8080" } },
});
