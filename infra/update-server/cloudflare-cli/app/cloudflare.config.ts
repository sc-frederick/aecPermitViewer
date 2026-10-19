import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "permitmon-updates",
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "../../src/index.ts",
    workersDev: true,
    previewUrls: false,
    domains: ["permitmon-updates.aeccloud.io"],
    env: {
      BUCKET: bindings.r2({
        name: "permitmon-updates",
      }),
    },
  },
});
