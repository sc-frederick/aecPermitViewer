import { ipcMain } from "electron";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { AppContext } from "../app-context.js";
import { pagePath } from "../paths.js";
import type { BridgeResult } from "../../shared/bridge.js";

export const NO_INPUT = z.undefined();

export type Handle = <I, T>(
  channel: string,
  schema: z.ZodType<I>,
  invalid: string,
  callback: (input: I) => Promise<BridgeResult<T>> | BridgeResult<T>,
) => void;

export function safeSender(context: AppContext, event: Electron.IpcMainInvokeEvent): boolean {
  if (
    !context.mainWindow ||
    event.sender !== context.mainWindow.webContents ||
    event.senderFrame !== context.mainWindow.webContents.mainFrame
  )
    return false;

  return event.senderFrame.url === pathToFileURL(pagePath()).href;
}

export function createHandle(context: AppContext): Handle {
  return (channel, schema, invalid, callback) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!safeSender(context, event)) return { ok: false, error: "Unauthorized request." };
      const parsed = schema.safeParse(args[0]);

      if (!parsed.success) return { ok: false, error: invalid };

      try {
        return await callback(parsed.data);
      } catch (cause) {
        context.diagnostics.record(channel, null, cause);

        return { ok: false, error: "Something went wrong. Try again." };
      }
    });
  };
}
