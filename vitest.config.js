import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["sf_flat_routes/web/**/*.test.js"],
    // the real-graph properties route 800 trips; CI runners are slower than a laptop
    testTimeout: 60_000,
  },
});
