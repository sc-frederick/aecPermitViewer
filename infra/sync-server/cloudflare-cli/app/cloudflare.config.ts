import { bindings, defineConfig, exports } from "cf/config";

/** Worker configuration preserving the existing resource identities and runtime settings. */
export default defineConfig({
  worker: {
    exports: {
      ShareRoomObject: exports.durableObject({ storage: "sqlite" }),
      ShareAdmissionObject: exports.durableObject({ storage: "sqlite" }),
    },
    name: "permitmon-sync",
    compatibilityDate: "2026-09-01",
    entrypoint: "../../src/index.ts",
    workersDev: true,
    previewUrls: false,
    observability: {
      enabled: true,
      headSamplingRate: 1,
    },
    env: {
      SHARE_SOURCE_WRITES_PER_MINUTE: bindings.text("60"),
      SHARE_SOURCE_CREATIONS_PER_DAY: bindings.text("5"),
      SHARE_DEPLOYMENT_CREATIONS_PER_DAY: bindings.text("100"),
      SHARE_REGISTERED_ROOMS: bindings.text("1024"),
      SHARE_TRACKED_SOURCES: bindings.text("4096"),
      ROOMS: bindings.durableObject({
        worker: "permitmon-sync",
        exportName: "ShareRoomObject",
      }),
      ADMISSION: bindings.durableObject({
        worker: "permitmon-sync",
        exportName: "ShareAdmissionObject",
      }),
    },
  },
});
