import { defineConfig } from "vitest/config";

// Unit tests run the Edge Function core (pure TS, no Deno APIs) under Node with mocked HTTP.
// Mocks are NOT live verification — see scripts/feasibility.mjs and scripts/live-smoke.mjs for live checks.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
