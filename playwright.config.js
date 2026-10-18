import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  forbidOnly: !!process.env["CI"],
  reporter: process.env["CI"] ? "github" : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}/` },
  projects: [{ name: "iphone-13", use: { ...devices["iPhone 13"], browserName: "chromium" } }],
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1 --directory site`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env["CI"],
    // http.server logs every request to stderr
    stderr: "ignore",
  },
});
