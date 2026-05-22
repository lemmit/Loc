// Auto-generated.
import { test as base, expect } from "@playwright/test";

export const test = base.extend<{ _consoleCapture: void }>({
  _consoleCapture: [
    async ({ page }, use, testInfo) => {
      const lines: string[] = [];
      page.on("console", (msg) => lines.push(`[${msg.type()}] ${msg.text()}`));
      page.on("pageerror", (err) =>
        lines.push(`[pageerror] ${err.stack ?? err.message}`),
      );
      await use();
      if (testInfo.status !== testInfo.expectedStatus && lines.length > 0) {
        await testInfo.attach("console-logs", {
          body: lines.join("\n"),
          contentType: "text/plain",
        });
      }
    },
    { auto: true },
  ],
});

export { expect };
