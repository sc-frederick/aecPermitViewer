/**
 * Wraps `send` so sends never overlap and each one starts after every change that asked for it. Calls made in the same
 * turn, or while a send is under way, share the next send. That send waits for the current one to finish and then for
 * the turn to end, so it reads state no older than any caller's change, and nothing it reads can be sent before an
 * earlier read. The returned promise settles when the shared send does.
 */
export function serialBroadcast(send: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> = Promise.resolve();
  let next: Promise<void> | null = null;

  return () => {
    next ??= current
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => {
        next = null;
        const sent = send();
        // A failed send still lets the next one go ahead; its caller hears about the failure.
        current = sent.then(
          () => undefined,
          () => undefined,
        );

        return sent;
      });

    return next;
  };
}
