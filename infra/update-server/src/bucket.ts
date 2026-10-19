/** Stored object metadata, as returned by `head`, `put`, and multipart completion. */
export interface FeedObject {
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly customMetadata?: { readonly sha256?: string };
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

/** Options for a conditional object write; artifact checksums are verified by storage before publication. */
export interface FeedPutOptions {
  readonly httpMetadata: { readonly contentType: string };
  readonly customMetadata?: { readonly sha256: string };
  readonly sha256?: string;
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
  put(key: string, value: string | ReadableStream<Uint8Array>, options: FeedPutOptions): Promise<FeedObject | null>;
  delete(key: string): Promise<void>;
  createMultipartUpload(key: string, options: FeedMultipartOptions): Promise<FeedMultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): FeedMultipartUpload;
}
