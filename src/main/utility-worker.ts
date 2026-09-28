import { utilityProcess } from "electron";
import path from "node:path";
import { workerToMainSchema } from "../shared/worker-protocol.js";
import type { WorkerStart } from "./check-runner.js";

/**
 * Starts the browser worker script as an Electron utility process with exactly `environment`. Messages are parsed here,
 * because the worker drives untrusted pages; anything that doesn't match the worker protocol is dropped.
 */
export function startUtilityWorker(workerPath: string, environment: NodeJS.ProcessEnv): WorkerStart {
  let child: Electron.UtilityProcess;

  try {
    child = utilityProcess.fork(path.resolve(workerPath), [], { env: environment, serviceName: "Permit Browser" });
  } catch (cause) {
    return { _tag: "failed", cause };
  }

  return {
    _tag: "started",
    worker: {
      send: (message) => child.postMessage(message),
      kill: () => {
        child.kill();
      },
      onMessage: (listener) => {
        child.on("message", (raw) => {
          const message = workerToMainSchema.safeParse(raw);

          if (message.success) listener(message.data);
        });
      },
      onExit: (listener) => {
        child.on("exit", () => listener());
      },
      onError: (listener) => {
        child.on("error", () => listener());
      },
    },
  };
}
