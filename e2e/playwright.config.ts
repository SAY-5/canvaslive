import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    {
      command: "npm -w server run start",
      cwd: "..",
      port: 8787,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        HOST: "127.0.0.1",
        PORT: "8787",
        CANVASLIVE_DB: "/tmp/canvaslive-e2e.db",
        CANVASLIVE_JWT_SECRET: "e2e-secret-at-least-sixteen-chars",
        CANVASLIVE_REQUIRE_AUTH: "0",
      },
    },
    {
      command: "npm -w client run dev -- --host 127.0.0.1 --port 5173",
      cwd: "..",
      port: 5173,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
