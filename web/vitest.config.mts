import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/__tests__/*.test.ts"],
    env: {
      NODE_ENV: "test",
      AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
      PUBLIC_ORIGIN: "https://pereval.test",
      LAVA_MOCK: "1",
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
