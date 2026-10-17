import { app, safeStorage } from "electron";
import { KeyStore } from "./key-store.js";

/** Creates the user-encrypted store and consumes the development-only environment override once. */
export function createKeyStore(dataRoot: string): KeyStore {
  const devKey = app.isPackaged ? null : process.env.TYPESAFE_API_KEY?.trim() || null;
  delete process.env.TYPESAFE_API_KEY;

  return new KeyStore(
    dataRoot,
    {
      // Linux's hard-coded fallback password is unsuitable for a saved credential.
      available: async () =>
        (process.platform === "win32" || process.platform === "darwin") &&
        (await safeStorage.isAsyncEncryptionAvailable()),
      encrypt: (key) => safeStorage.encryptStringAsync(key),
      decrypt: (encrypted) => safeStorage.decryptStringAsync(encrypted),
    },
    devKey,
  );
}
