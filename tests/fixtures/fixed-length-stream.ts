/** Node stand-in for the Workers `FixedLengthStream` global: passes chunks through and enforces the byte count. */
export class LocalFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  /** Errors the stream when more or fewer than `length` bytes pass through. */
  constructor(length: number) {
    let received = 0;
    super({
      transform(chunk, controller) {
        received += chunk.byteLength;

        if (received > length) throw new Error("FixedLengthStream received too many bytes");
        controller.enqueue(chunk);
      },
      flush() {
        if (received !== length) throw new Error("FixedLengthStream received too few bytes");
      },
    });
  }
}
