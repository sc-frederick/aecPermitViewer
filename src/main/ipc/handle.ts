import { ipcMain } from "electron";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { AppContext } from "../app-context.js";
import { pagePath } from "../paths.js";
import type { BridgeResult } from "../../shared/bridge.js";

/** The input schema for requests that carry none. */
export const NO_INPUT = z.undefined();

/** Registers the handler for one window request channel; see {@link createHandle}. */
export type Handle = <I, T>(
  channel: string,
  schema: z.ZodType<I>,
  invalid: string,
  callback: (input: I) => Promise<BridgeResult<T>> | BridgeResult<T>,
) => void;

/** Whether a request came from the app's own page in the main window's top frame. */
export function safeSender(context: AppContext, event: Electron.IpcMainInvokeEvent): boolean {
  if (
    !context.mainWindow ||
    event.sender !== context.mainWindow.webContents ||
    event.senderFrame !== context.mainWindow.webContents.mainFrame
  )
    return false;

  return event.senderFrame.url === pathToFileURL(pagePath()).href;
}

/**
 * Returns `handle`, which answers a window request once its input parses; otherwise answers with `invalid`. A failure
 * the callback didn't answer itself gets a generic reply, and its classified cause is recorded under the channel's name.
 */
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
