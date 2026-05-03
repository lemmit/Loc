#!/usr/bin/env node
import("../out/cli/main.js").catch((err) => {
  console.error(err);
  process.exit(1);
});
