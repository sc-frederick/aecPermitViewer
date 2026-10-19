export function serialBroadcast(send: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> = Promise.resolve();
  let next: Promise<void> | null = null;

  return () => {
    next ??= current
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => {
        next = null;
        const sent = send();
        current = sent.then(
          () => undefined,
          () => undefined,
        );

        return sent;
      });

    return next;
  };
}
