import { pathToFileURL } from "url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    setupFiles: ["__tests__/setup.ts"],
    poolOptions: {
      // Workers exit when the runner dies, instead of filling memory (the file says why).
      forks: { execArgv: ["--import", pathToFileURL("__tests__/exit-with-runner.mjs").href] },
    },
  },
});
