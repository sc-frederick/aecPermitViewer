import { bench, command } from "@hona/strobe";
import { readFileSync } from "node:fs";

// Under WSLg, Mesa picks its llvmpipe software renderer, and strobe refuses every case as SoftwareGpu. Mesa's d3d12
// driver renders on the Windows GPU instead; MESA_D3D12_DEFAULT_ADAPTER_NAME in the environment picks the adapter.
const wsl = process.platform === "linux" && /microsoft/i.test(readFileSync("/proc/version", "utf8"));

const isolated = { PERMIT_MONITOR_DATA_DIR: "{home}/permit-monitor" };

const env = wsl ? { ...isolated, GALLIUM_DRIVER: "d3d12" } : isolated;

// Every launch runs the unpackaged build in its own PERMIT_MONITOR_DATA_DIR (src/main/paths.ts): its own database,
// Electron profile, and single-instance lock, with no key storage and no sharing service. The launch command first
// copies in the variant's seeded list (perf/variant.mjs), which is in manual mode, so no scheduled check starts; with no
// key a check could not run anyway.
const app = command("node perf/variant.mjs seed && node node_modules/electron/cli.js . --remote-debugging-port=0", {
  build: "node perf/variant.mjs build",
  env,
  unset: ["TYPESAFE_API_KEY", "SHARE_SERVICE_URL", "UPDATE_*", "ELECTRON_RUN_AS_NODE"],
});

const firstPermit = "#permit-table tbody tr[data-permit-id] .permit-link";

// strobe 0.8.0 ends a command target's launch only on a selector, and this window shows its list before strobe can
// attach, so there is no launch case. `reload` times the window's own start instead: page load, the first snapshot
// from main, and the table.
export default bench({
  targets: { app },
  async setup({ page }) {
    await page.waitFor(firstPermit);
    await page.idle();
  },
  cases: {
    reload: {
      primary: "run.duration",
      metrics: ["main.work", "main.script", "main.style", "main.layout"],
      run: ({ page }) => page.goto("index.html", { until: firstPermit }),
      reset: ({ page }) => page.idle(),
    },
    details: {
      primary: "interaction.p95",
      metrics: ["main.work", "main.script", "main.style", "main.layout"],
      run: ({ page }) => page.click(firstPermit, { until: "#details-sheet[open] #history-list li" }),
      reset: ({ page }) => page.click("#details-sheet [data-close]", { until: "idle" }),
    },
    // A scroll gesture, as a touchpad, the keyboard, or the scrollbar scrolls: the pointer's hover does not move.
    scroll: {
      primary: "main.busy",
      metrics: ["main.work", "main.script", "main.style", "main.layout"],
      run: ({ page }) => page.scroll(".table-scroll", { by: 3000, speed: 3000 }),
      reset: ({ page }) => page.scroll(".table-scroll", { by: -3000, speed: 6000 }),
    },
    // A mouse wheel turned for about a second over the list: rows pass under the pointer and change hover as they go.
    // Reset parks the pointer on the list, so measured runs start where a person's pointer would be.
    wheel: {
      primary: "main.busy",
      metrics: ["main.work", "main.script", "main.style", "main.layout"],
      async run({ page }) {
        for (let tick = 0; tick < 30; tick += 1) {
          await page.wheel(".table-scroll", { dy: 100 });
          await page.wait(33);
        }
      },
      async reset({ page }) {
        await page.scroll(".table-scroll", { by: -3000, speed: 6000 });
        await page.hover(".table-scroll");
      },
    },
  },
});
