// The part of the R2 Workers binding the feed uses. Cloudflare's R2Bucket satisfies it structurally, and
// tests supply an in-memory bucket. Members follow the R2 Workers API reference; see
// https://developers.cloudflare.com/r2/api/workers/workers-api-reference/.

/** Stored object metadata, as returned by `head`, `put`, and multipart completion. */
export interface FeedObject {
  readonly size: number;
  /** Unquoted entity tag, the form `onlyIf.etagMatches` compares. */
  readonly etag: string;
  /** Quoted entity tag for the HTTP `etag` header. */
  readonly httpEtag: string;
  readonly customMetadata?: { readonly sha256?: string };
  /** Copies the stored HTTP metadata (content type and similar) onto response headers. */
  writeHttpMetadata(headers: Headers): void;
}

/** A stored object with its body. The body can be read once, either as a stream or through `text`. */
export interface FeedObjectBody extends FeedObject {
  readonly body: ReadableStream<Uint8Array>;
  text(): Promise<string>;
}

/** A byte span inside an object; `offset + length` never exceeds its size. */
export interface FeedRange {
  readonly offset: number;
  readonly length: number;
}

/** A part accepted by an in-progress multipart upload. */
export interface FeedUploadedPart {
  readonly partNumber: number;
  readonly etag: string;
}

/** An in-progress multipart upload. `complete` makes the object visible under its key. */
export interface FeedMultipartUpload {
  readonly uploadId: string;
  uploadPart(partNumber: number, value: ReadableStream<Uint8Array>): Promise<FeedUploadedPart>;
  complete(parts: readonly FeedUploadedPart[]): Promise<FeedObject>;
  abort(): Promise<void>;
}

/** Options for a text object write. `onlyIf` matches an etag or requires that the key is still absent. */
export interface FeedPutOptions {
  readonly httpMetadata: { readonly contentType: string };
  readonly onlyIf?: { readonly etagMatches: string } | Headers;
}

/** Options for starting a multipart upload; `customMetadata` is attached to the completed object. */
export interface FeedMultipartOptions {
  readonly httpMetadata: { readonly contentType: string };
  readonly customMetadata: { readonly sha256: string };
}

/** Storage for the update feed. Every method may reject when R2 is unavailable. */
export interface FeedBucket {
  head(key: string): Promise<FeedObject | null>;
  get(key: string, options?: { readonly range: FeedRange }): Promise<FeedObjectBody | null>;
  /** Resolves null when an `onlyIf` precondition fails. */
  put(key: string, value: string, options: FeedPutOptions): Promise<FeedObject | null>;
  delete(key: string): Promise<void>;
  createMultipartUpload(key: string, options: FeedMultipartOptions): Promise<FeedMultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): FeedMultipartUpload;
}
