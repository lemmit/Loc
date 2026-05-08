// Auto-generated.
import { defineConfig, devices } from "@playwright/test";

// Tests target a running web_app — typically the docker-compose
// service on port 3001.  Override via E2E_BASE_URL.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3001",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
