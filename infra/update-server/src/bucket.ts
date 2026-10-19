export interface FeedObject {
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly customMetadata?: { readonly sha256?: string };
  writeHttpMetadata(headers: Headers): void;
}

export interface FeedObjectBody extends FeedObject {
  readonly body: ReadableStream<Uint8Array>;
  text(): Promise<string>;
}

export interface FeedRange {
  readonly offset: number;
  readonly length: number;
}

export interface FeedUploadedPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface FeedMultipartUpload {
  readonly uploadId: string;
  uploadPart(partNumber: number, value: ReadableStream<Uint8Array>): Promise<FeedUploadedPart>;
  complete(parts: readonly FeedUploadedPart[]): Promise<FeedObject>;
  abort(): Promise<void>;
}

export interface FeedPutOptions {
  readonly httpMetadata: { readonly contentType: string };
  readonly customMetadata?: { readonly sha256: string };
  readonly sha256?: string;
  readonly onlyIf?: { readonly etagMatches: string } | Headers;
}

export interface FeedMultipartOptions {
  readonly httpMetadata: { readonly contentType: string };
  readonly customMetadata: { readonly sha256: string };
}

export interface FeedBucket {
  head(key: string): Promise<FeedObject | null>;
  get(key: string, options?: { readonly range: FeedRange }): Promise<FeedObjectBody | null>;
  put(key: string, value: string | ReadableStream<Uint8Array>, options: FeedPutOptions): Promise<FeedObject | null>;
  delete(key: string): Promise<void>;
  createMultipartUpload(key: string, options: FeedMultipartOptions): Promise<FeedMultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): FeedMultipartUpload;
}
