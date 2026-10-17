import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KeyStore, type KeyEncryption } from "../src/main/key-store.js";
import { temporaryDirectory } from "./support/temporary-directory.js";

function gate() {
  let open: () => void = () => undefined;

  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
}

class Encryption implements KeyEncryption {
  readonly decryptReached = gate();
  decryptWait: Promise<void> = Promise.resolve();
  encryptWait: Promise<void> = Promise.resolve();
  failEncrypt = false;
  failDecrypt = false;
  migrate = false;

  async available(): Promise<boolean> {
    return true;
  }

  async encrypt(key: string): Promise<Buffer> {
    await this.encryptWait;

    if (this.failEncrypt) throw new Error("synthetic encryption failure");

    return Buffer.from(`sealed:${key}`);
  }

  async decrypt(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> {
    this.decryptReached.open();
    await this.decryptWait;

    if (this.failDecrypt) throw new Error("synthetic decryption failure");

    return { result: encrypted.toString().slice(7), shouldReEncrypt: this.migrate };
  }
}

async function setup() {
  const directory = temporaryDirectory("permit-key-");
  const encryption = new Encryption();
  const store = new KeyStore(directory, encryption);
  expect(await store.save("old-fixture-key")).toEqual({ _tag: "saved" });

  return { directory, encryption, store };
}

describe("encrypted key mutation ordering", () => {
  it("does not recreate a removed key when an obsolete decrypt asks to migrate", async () => {
    const { directory, encryption, store } = await setup();
    const wait = gate();
    encryption.migrate = true;
    encryption.decryptWait = wait.promise;
    const reading = store.read();
    await encryption.decryptReached.promise;
    await store.remove();
    expect(await store.state()).toBe("missing");
    wait.open();
    expect(await reading).toBeNull();
    expect(await store.state()).toBe("missing");
    expect(await readdir(path.join(directory, "secrets"))).toEqual([]);
  });

  it("preserves replacement bytes and returns the current key after an obsolete migration", async () => {
    const { directory, encryption, store } = await setup();
    const wait = gate();
    encryption.migrate = true;
    encryption.decryptWait = wait.promise;
    const reading = store.read();
    await encryption.decryptReached.promise;
    expect(await store.save("replacement-fixture-key")).toEqual({ _tag: "saved" });
    wait.open();
    expect(await reading).toBe("replacement-fixture-key");
    expect(await readFile(path.join(directory, "secrets/typesafe-key.bin"), "utf8")).toBe(
      "sealed:replacement-fixture-key",
    );
    expect(await readdir(path.join(directory, "secrets"))).toEqual(["typesafe-key.bin"]);
  });

  it("serializes concurrent saves and removal in invocation order", async () => {
    const { directory, encryption, store } = await setup();
    const wait = gate();
    encryption.encryptWait = wait.promise;
    const first = store.save("first");
    const second = store.save("second");
    wait.open();
    expect(await Promise.all([first, second])).toEqual([{ _tag: "saved" }, { _tag: "saved" }]);
    expect(await store.read()).toBe("second");
    const third = store.save("third");
    const removed = store.remove();
    await Promise.all([third, removed]);
    expect(await store.read()).toBeNull();
    expect(await readdir(path.join(directory, "secrets"))).toEqual([]);
  });

  it("preserves the saved key after a failed write and allows subsequent writes", async () => {
    const { encryption, store } = await setup();
    encryption.failEncrypt = true;
    expect(await store.save("failed")).toMatchObject({ _tag: "failed", error: { _tag: "KeyWriteFailed" } });
    encryption.failEncrypt = false;
    expect(await store.read()).toBe("old-fixture-key");
    expect(await store.save("working")).toEqual({ _tag: "saved" });
    expect(await store.read()).toBe("working");
  });

  it("does not mark a removed key unreadable after an obsolete decrypt fails", async () => {
    const { encryption, store } = await setup();
    const wait = gate();
    encryption.decryptWait = wait.promise;
    encryption.failDecrypt = true;
    const reading = store.read();
    await encryption.decryptReached.promise;
    await store.remove();
    wait.open();
    expect(await reading).toBeNull();
    expect(await store.state()).toBe("missing");
  });
});
