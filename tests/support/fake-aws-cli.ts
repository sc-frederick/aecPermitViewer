import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const FEED_BUCKET = "permitmon-updates";

const FAKE_AWS = path.resolve("tests/fixtures/fake-aws.mjs");

export interface FakeAwsCli {
  readonly bin: string;
  readonly store: string;
}

export function installFakeAwsCli(root: string): FakeAwsCli {
  const bin = path.join(root, "bin");
  const store = path.join(root, "store");
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(store, FEED_BUCKET), { recursive: true });
  writeFileSync(path.join(bin, "aws"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AWS}" "$@"\n`);
  chmodSync(path.join(bin, "aws"), 0o755);

  return { bin, store };
}

export function fakeAwsEnvironment(cli: FakeAwsCli): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${cli.bin}${path.delimiter}${process.env.PATH ?? ""}`,
    R2_ENDPOINT: "https://r2.example.test",
    FAKE_AWS_ROOT: cli.store,
  };
}
