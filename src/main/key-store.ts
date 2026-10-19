import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { StoredKeyState } from "../shared/bridge.js";

function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

export interface KeyEncryption {
  available: () => Promise<boolean>;
  encrypt: (key: string) => Promise<Buffer>;
  decrypt: (encrypted: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export class KeyStorageUnavailable extends Error {
  readonly _tag = "KeyStorageUnavailable" as const;

  constructor() {
    super("Key storage is unavailable on this computer");
  }
}

export class KeyWriteFailed extends Error {
  readonly _tag = "KeyWriteFailed" as const;

  constructor(override readonly cause: unknown) {
    super("The key couldn't be written");
  }
}

export type KeySave = { _tag: "saved" } | { _tag: "failed"; error: KeyStorageUnavailable | KeyWriteFailed };

export class KeyStore {
  private readonly secretPath: string;
  private mutations: Promise<void> = Promise.resolve();
  private lastReadFailed = false;
  private generation = 0;

  constructor(
    dataRoot: string,
    private readonly encryption: KeyEncryption,
    private readonly devKey: string | null = null,
  ) {
    this.secretPath = path.join(dataRoot, "secrets", "typesafe-key.bin");
  }

  async state(): Promise<StoredKeyState> {
    if (this.devKey) return "configured";

    if (!(await this.encryption.available())) return "unavailable";

    try {
      await access(this.secretPath);

      return this.lastReadFailed ? "unreadable" : "configured";
    } catch (cause) {
      return isMissingFile(cause) ? "missing" : "unavailable";
    }
  }

  async save(key: string): Promise<KeySave> {
    this.generation += 1;

    return this.mutate(async () => {
      if (!(await this.encryption.available())) return { _tag: "failed", error: new KeyStorageUnavailable() };

      try {
        await this.writeEncrypted(await this.encryption.encrypt(key));
      } catch (cause) {
        return { _tag: "failed", error: new KeyWriteFailed(cause) };
      }

      this.lastReadFailed = false;

      return { _tag: "saved" };
    });
  }

  async remove(): Promise<void> {
    this.generation += 1;
    await this.mutate(async () => {
      await rm(this.secretPath, { force: true });
      this.lastReadFailed = false;
    });
  }

  async read(): Promise<string | null> {
    if (this.devKey) return this.devKey;

    if (!(await this.encryption.available())) return null;

    for (;;) {
      const generation = this.generation;
      await this.mutations;

      try {
        const key = await this.readSaved(generation);

        if (generation !== this.generation) continue;
        this.lastReadFailed = false;

        return key;
      } catch (cause) {
        if (generation !== this.generation) continue;
        this.lastReadFailed = true;
        throw cause;
      }
    }
  }

  private async readSaved(generation: number): Promise<string | null> {
    const encrypted = await readFile(this.secretPath).catch((cause) => {
      if (isMissingFile(cause)) return null;
      throw cause;
    });

    if (!encrypted) return null;
    const decrypted = await this.encryption.decrypt(encrypted);

    if (decrypted.shouldReEncrypt && generation === this.generation) {
      await this.mutate(async () => {
        if (generation !== this.generation) return;
        const migrated = await this.encryption.encrypt(decrypted.result);

        if (generation === this.generation) await this.writeEncrypted(migrated);
      });
    }

    return decrypted.result;
  }

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(work);
    this.mutations = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  private async writeEncrypted(encrypted: Buffer): Promise<void> {
    await mkdir(path.dirname(this.secretPath), { recursive: true });
    const temporaryPath = `${this.secretPath}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporaryPath, encrypted, { mode: 0o600, flag: "wx" });
      await rename(temporaryPath, this.secretPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
