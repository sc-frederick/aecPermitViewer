import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FeedObject, FeedObjectBody, FeedPutOptions, FeedRange } from "../../infra/update-server/src/bucket.js";
import { MemoryBucket } from "./memory-bucket.js";

const metadataSchema = z.object({ contentType: z.string(), metadata: z.object({ sha256: z.string().optional() }) });

export class FileFeedBucket extends MemoryBucket {
  constructor(private readonly directory: string) {
    super();
  }

  override async head(key: string): Promise<FeedObject | null> {
    if (key.startsWith("_uploads/")) return super.head(key);
    const file = path.join(this.directory, key);

    if (!existsSync(file)) return null;
    const bytes = readFileSync(file);
    const meta = metadataSchema.parse(JSON.parse(readFileSync(`${file}.meta.json`, "utf8")));
    const etag = createHash("md5").update(bytes).digest("hex");

    return {
      size: bytes.length,
      etag,
      httpEtag: `"${etag}"`,
      customMetadata: meta.metadata.sha256 ? { sha256: meta.metadata.sha256 } : {},
      writeHttpMetadata: (headers) => headers.set("content-type", meta.contentType),
    };
  }

  override async get(key: string, options?: { readonly range: FeedRange }): Promise<FeedObjectBody | null> {
    if (key.startsWith("_uploads/")) return super.get(key, options);
    const object = await this.head(key);

    if (!object) return null;
    const bytes = readFileSync(path.join(this.directory, key));
    const range = options?.range;
    const selected = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;

    return { ...object, body: new Blob([selected]).stream(), text: async () => selected.toString("utf8") };
  }

  override async put(
    key: string,
    value: string | ReadableStream<Uint8Array>,
    options: FeedPutOptions,
  ): Promise<FeedObject | null> {
    if (key.startsWith("_uploads/")) return super.put(key, value, options);

    const bytes =
      value instanceof ReadableStream ? Buffer.from(await new Response(value).arrayBuffer()) : Buffer.from(value);

    if (options.sha256 && createHash("sha256").update(bytes).digest("hex") !== options.sha256)
      throw new Error("Bad SHA-256");
    const createOnly = options.onlyIf instanceof Headers && options.onlyIf.get("if-none-match") === "*";

    if (
      options.onlyIf &&
      !(options.onlyIf instanceof Headers) &&
      (await this.head(key))?.etag !== options.onlyIf.etagMatches
    )
      return null;
    const file = path.join(this.directory, key);
    mkdirSync(path.dirname(file), { recursive: true });

    try {
      writeFileSync(file, bytes, createOnly ? { flag: "wx" } : {});
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "EEXIST") return null;
      throw cause;
    }

    writeFileSync(
      `${file}.meta.json`,
      JSON.stringify({ contentType: options.httpMetadata.contentType, metadata: options.customMetadata ?? {} }),
    );

    return this.head(key);
  }
}
