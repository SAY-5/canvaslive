import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 10000,
    environment: "node",
  },
  ssr: {
    // Keep node: prefixed imports as-is; Vite otherwise strips the prefix.
    noExternal: [],
    external: [/^node:/],
  },
  resolve: {
    conditions: ["node"],
  },
});
