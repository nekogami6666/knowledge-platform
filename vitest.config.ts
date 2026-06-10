import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ["{apps,packages}/*/src/**/*.test.ts"],
  },
});
