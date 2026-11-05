import { app, safeStorage } from "electron";
import { KeyStore } from "./key-store.js";
import { isolatedDataDirectory } from "./paths.js";

/**
 * Creates the key store over Electron's safeStorage. Unpackaged builds take TYPESAFE_API_KEY as an override; the
 * variable is deleted from the environment in every build. An isolated run has no key storage at all, so it never
 * reaches the user's keychain entry, and checks skip for want of a key.
 */
export function createKeyStore(dataRoot: string): KeyStore {
  const isolated = isolatedDataDirectory() !== null;
  const devKey = app.isPackaged || isolated ? null : process.env.TYPESAFE_API_KEY?.trim() || null;
  delete process.env.TYPESAFE_API_KEY;

  return new KeyStore(
    dataRoot,
    {
      // Windows and macOS only: on Linux, safeStorage can fall back to a hard-coded password.
      available: async () =>
        !isolated &&
        (process.platform === "win32" || process.platform === "darwin") &&
        (await safeStorage.isAsyncEncryptionAvailable()),
      encrypt: (key) => safeStorage.encryptStringAsync(key),
      decrypt: (encrypted) => safeStorage.decryptStringAsync(encrypted),
    },
    devKey,
  );
}
