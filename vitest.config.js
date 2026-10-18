import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["sf_flat_routes/web/**/*.test.js"],
  },
});
