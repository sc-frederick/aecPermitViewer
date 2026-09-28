import type {
  FeedBucket, FeedMultipartOptions, FeedMultipartUpload, FeedObject, FeedObjectBody, FeedPutOptions, FeedRange, FeedUploadedPart,
} from "../../infra/update-server/src/bucket.js";

/** The bucket operations a test can make unavailable. */
export type BucketOperation = "head" | "get" | "put" | "delete" | "createMultipartUpload" | "uploadPart" | "complete" | "abort";

interface StoredObject {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  readonly sha256: string | undefined;
  readonly etag: string;
}

interface PendingUpload {
  readonly key: string;
  readonly options: FeedMultipartOptions;
  readonly parts: Map<number, { readonly etag: string; readonly bytes: Uint8Array<ArrayBuffer> }>;
}

/**
 * An in-memory implementation of the feed's R2 port with R2's observable behavior for the operations the
 * Worker uses: conditional puts, multipart uploads that only appear on completion, and ranged reads.
 * Operations listed in `failing` reject the way an R2 outage does.
 */
export class MemoryBucket implements FeedBucket {
  /** Operations that currently reject. */
  readonly failing = new Set<BucketOperation>();

  private readonly objects = new Map<string, StoredObject>();

  private readonly uploads = new Map<string, PendingUpload>();

  private sequence = 0;

  /** Stores an object directly, as the CI release job or an earlier deployment would have. */
  seed(key: string, value: string | Uint8Array<ArrayBuffer>, contentType: string, sha256?: string): void {
    const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(value);
    this.objects.set(key, { bytes, contentType, sha256, etag: this.nextEtag() });
  }

  /** The stored bytes of `key` as text, bypassing failure injection, or null when absent. */
  storedText(key: string): string | null {
    const object = this.objects.get(key);

    return object ? new TextDecoder().decode(object.bytes) : null;
  }

  /** Number of multipart uploads started and neither completed nor aborted. */
  get openUploads(): number {
    return this.uploads.size;
  }

  async head(key: string): Promise<FeedObject | null> {
    this.check("head");
    const object = this.objects.get(key);

    return object ? this.describe(object) : null;
  }

  async get(key: string, options?: { readonly range: FeedRange }): Promise<FeedObjectBody | null> {
    this.check("get");
    const object = this.objects.get(key);

    if (!object) return null;
    const range = options?.range;

    if (range && (range.offset < 0 || range.length < 1 || range.offset + range.length > object.bytes.byteLength)) {
      throw new Error("get: The requested range is not satisfiable (10039)");
    }

    const bytes = range ? object.bytes.slice(range.offset, range.offset + range.length) : object.bytes;

    return {
      ...this.describe(object),
      body: new Blob([bytes]).stream(),
      text: async () => new TextDecoder().decode(bytes),
    };
  }

  async put(key: string, value: string, options: FeedPutOptions): Promise<FeedObject | null> {
    this.check("put");

    if (options.onlyIf && this.objects.get(key)?.etag !== options.onlyIf.etagMatches) return null;
    this.seed(key, value, options.httpMetadata.contentType);
    const stored = this.objects.get(key);

    return stored ? this.describe(stored) : null;
  }

  async delete(key: string): Promise<void> {
    this.check("delete");
    this.objects.delete(key);
  }

  async createMultipartUpload(key: string, options: FeedMultipartOptions): Promise<FeedMultipartUpload> {
    this.check("createMultipartUpload");
    const uploadId = `upload-${this.nextEtag()}`;
    this.uploads.set(uploadId, { key, options, parts: new Map() });

    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string): FeedMultipartUpload {
    const pending = (): PendingUpload => {
      const upload = this.uploads.get(uploadId);

      if (!upload || upload.key !== key) throw new Error("The specified multipart upload does not exist. (10024)");

      return upload;
    };

    return {
      uploadId,
      uploadPart: async (partNumber: number, value: ReadableStream<Uint8Array>): Promise<FeedUploadedPart> => {
        this.check("uploadPart");
        const bytes = new Uint8Array(await new Response(value).arrayBuffer());
        const etag = this.nextEtag();
        pending().parts.set(partNumber, { etag, bytes });

        return { partNumber, etag };
      },
      complete: async (parts: readonly FeedUploadedPart[]): Promise<FeedObject> => {
        this.check("complete");
        const upload = pending();

        const chunks = parts.map((part) => {
          const uploaded = upload.parts.get(part.partNumber);

          if (!uploaded || uploaded.etag !== part.etag) throw new Error("One or more of the specified parts could not be found. (10025)");

          return uploaded.bytes;
        });

        const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
        this.uploads.delete(uploadId);
        this.seed(key, bytes, upload.options.httpMetadata.contentType, upload.options.customMetadata.sha256);
        const stored = this.objects.get(key);

        if (!stored) throw new Error("Completed object vanished");

        return this.describe(stored);
      },
      abort: async (): Promise<void> => {
        this.check("abort");
        this.uploads.delete(uploadId);
      },
    };
  }

  private check(operation: BucketOperation): void {
    if (this.failing.has(operation)) throw new Error(`${operation}: We encountered an internal error. Please try again. (10001)`);
  }

  private nextEtag(): string {
    this.sequence += 1;

    return `etag-${this.sequence}`;
  }

  private describe(object: StoredObject): FeedObject {
    return {
      size: object.bytes.byteLength,
      etag: object.etag,
      httpEtag: `"${object.etag}"`,
      customMetadata: object.sha256 === undefined ? {} : { sha256: object.sha256 },
      writeHttpMetadata: (headers) => headers.set("content-type", object.contentType),
    };
  }
}
