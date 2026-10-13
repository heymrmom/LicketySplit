import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
  },
  resolve: {
    alias: {
      "@licketysplit/core": path.resolve(__dirname, "../core/src"),
      "@licketysplit/agent": path.resolve(__dirname, "./src"),
    },
  },
});
