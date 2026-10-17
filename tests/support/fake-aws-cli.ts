import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The bucket scripts/publish-feed.mjs writes to when R2_BUCKET is unset. */
export const FEED_BUCKET = "permitmon-updates";

const FAKE_AWS = path.resolve("tests/fixtures/fake-aws.mjs");

/** Where an installed fake AWS CLI lives. */
export interface FakeAwsCli {
  /** The folder holding the `aws` command, for the front of PATH. */
  readonly bin: string;
  /** The fake's storage: objects live at `<store>/<bucket>/<key>`. */
  readonly store: string;
}

/**
 * Install tests/fixtures/fake-aws.mjs under `root` as an `aws` command, with an empty FEED_BUCKET. The command is a POSIX
 * shell script, so Windows can't run it.
 *
 * @param root - A test-owned directory; the command goes in `root/bin` and the storage in `root/store`.
 * @returns The command and storage folders.
 */
export function installFakeAwsCli(root: string): FakeAwsCli {
  const bin = path.join(root, "bin");
  const store = path.join(root, "store");
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(store, FEED_BUCKET), { recursive: true });
  writeFileSync(path.join(bin, "aws"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AWS}" "$@"\n`);
  chmodSync(path.join(bin, "aws"), 0o755);

  return { bin, store };
}

/**
 * Build the environment that sends a publisher's `aws` calls to the fake CLI instead of R2.
 *
 * @param cli - The installed fake.
 * @returns This process's environment with the fake first on PATH, a placeholder R2 endpoint, and the fake's storage.
 */
export function fakeAwsEnvironment(cli: FakeAwsCli): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${cli.bin}${path.delimiter}${process.env.PATH ?? ""}`,
    R2_ENDPOINT: "https://r2.example.test",
    FAKE_AWS_ROOT: cli.store,
  };
}
