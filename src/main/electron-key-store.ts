import { app, safeStorage } from "electron";
import { KeyStore } from "./key-store.js";

/**
 * Creates the key store over Electron's safeStorage. Unpackaged builds take TYPESAFE_API_KEY as an override; the
 * variable is deleted from the environment in every build.
 */
export function createKeyStore(dataRoot: string): KeyStore {
  const devKey = app.isPackaged ? null : process.env.TYPESAFE_API_KEY?.trim() || null;
  delete process.env.TYPESAFE_API_KEY;

  return new KeyStore(
    dataRoot,
    {
      // Windows and macOS only: on Linux, safeStorage can fall back to a hard-coded password.
      available: async () =>
        (process.platform === "win32" || process.platform === "darwin") &&
        (await safeStorage.isAsyncEncryptionAvailable()),
      encrypt: (key) => safeStorage.encryptStringAsync(key),
      decrypt: (encrypted) => safeStorage.decryptStringAsync(encrypted),
    },
    devKey,
  );
}
