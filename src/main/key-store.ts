import { app, safeStorage } from "electron";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Development runs (never a packaged build) may supply the key through TYPESAFE_API_KEY so the
 * app can be driven on machines without Windows key storage. It is read once here in main and is
 * never written to disk, logs, the renderer, or the worker.
 */
function developmentKey(): string | null {
  if (app.isPackaged) return null;
  const value = process.env.TYPESAFE_API_KEY?.trim();

  return value ? value : null;
}

/** This computer can't encrypt a key for the current user, so nothing was saved. */
export class KeyStorageUnavailable extends Error {
  readonly _tag = "KeyStorageUnavailable" as const;

  constructor() {
    super("Key storage is unavailable on this computer");
  }
}

/** Encrypting or writing the key failed. A key saved earlier, if any, is left as it was. */
export class KeyWriteFailed extends Error {
  readonly _tag = "KeyWriteFailed" as const;

  constructor(readonly cause: unknown) {
    super("The key couldn't be written");
  }
}

/** The result of saving a key. */
export type KeySave = { _tag: "saved" } | { _tag: "failed"; error: KeyStorageUnavailable | KeyWriteFailed };

/** The TypeSafe key, encrypted for the current Windows user in the app's data folder. */
export class KeyStore {
  private readonly secretPath: string;
  private readonly devKey = developmentKey();

  constructor(dataRoot: string) {
    this.secretPath = path.join(dataRoot, "secrets", "typesafe-key.bin");
    delete process.env.TYPESAFE_API_KEY;
  }

  /** Whether a key is saved and usable here, without reading or decrypting it. */
  async state(): Promise<"configured" | "missing" | "unavailable"> {
    if (this.devKey) return "configured";

    if (!(await this.encryptionAvailable())) return "unavailable";

    try {
      await access(this.secretPath);

      return "configured";
    } catch (cause) {
      return cause instanceof Error && "code" in cause && cause.code === "ENOENT" ? "missing" : "unavailable";
    }
  }

  /** Encrypts the key for this Windows user. The plaintext is never returned or persisted. */
  async save(key: string): Promise<KeySave> {
    if (!(await this.encryptionAvailable())) return { _tag: "failed", error: new KeyStorageUnavailable() };

    try {
      await this.writeEncrypted(await safeStorage.encryptStringAsync(key));
    } catch (cause) {
      return { _tag: "failed", error: new KeyWriteFailed(cause) };
    }

    return { _tag: "saved" };
  }

  /** Deletes the saved key, if there is one. Rejects when the file exists but can't be deleted. */
  async remove(): Promise<void> {
    await rm(this.secretPath, { force: true });
  }

  /**
   * The key, or null when none is saved or this computer can't store one. The file is read and decrypted once; a
   * saved key that can't be read or decrypted rejects, so it isn't mistaken for a missing one.
   */
  async read(): Promise<string | null> {
    if (this.devKey) return this.devKey;

    if (!(await this.encryptionAvailable())) return null;

    const encrypted = await readFile(this.secretPath).catch((cause) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
      throw cause;
    });

    if (!encrypted) return null;
    const decrypted = await safeStorage.decryptStringAsync(encrypted);

    if (decrypted.shouldReEncrypt) await this.writeEncrypted(await safeStorage.encryptStringAsync(decrypted.result));

    return decrypted.result;
  }

  private async encryptionAvailable(): Promise<boolean> {
    return process.platform === "win32" && await safeStorage.isAsyncEncryptionAvailable();
  }

  private async writeEncrypted(encrypted: Buffer): Promise<void> {
    await mkdir(path.dirname(this.secretPath), { recursive: true });
    const temporaryPath = `${this.secretPath}.tmp`;
    await writeFile(temporaryPath, encrypted, { mode: 0o600 });
    await rename(temporaryPath, this.secretPath);
  }
}
