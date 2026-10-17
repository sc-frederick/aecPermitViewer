import { createServer } from "node:http";
import { onTestFinished } from "vitest";
import { z } from "zod";
import { defined } from "./defined.js";

/** A running local server and what went wrong inside it. */
export interface FetchHandlerServer {
  /** The server's own address, `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** Each error the handler threw, as text; each was answered with a 500. */
  readonly failures: readonly string[];
}

/**
 * Serve a Worker-style fetch handler over real HTTP on an ephemeral 127.0.0.1 port until the running test finishes,
 * the way `wrangler dev` serves a Worker locally. Each incoming request reaches `handle` as a fetch `Request` with the
 * same method, headers, and body, and the incoming path and query resolved against `requestOrigin`.
 *
 * @param handle - The handler under test.
 * @param requestOrigin - The origin the handler sees requests arrive at, such as the deployed Worker's.
 * @returns The listening server's origin and a live list of the handler's failures.
 */
export async function serveFetchHandler(
  handle: (request: Request) => Promise<Response>,
  requestOrigin = "http://127.0.0.1",
): Promise<FetchHandlerServer> {
  const failures: string[] = [];

  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = [];

      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();

      for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
        headers.append(
          defined(incoming.rawHeaders[index], "header name"),
          defined(incoming.rawHeaders[index + 1], "header value"),
        );
      }

      const init: RequestInit = { method: incoming.method ?? "GET", headers };
      const body = Buffer.concat(chunks);

      if (body.length > 0) init.body = body;
      const response = await handle(new Request(new URL(incoming.url ?? "/", requestOrigin), init));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch((cause: unknown) => {
      failures.push(String(cause));
      outgoing.writeHead(500);
      outgoing.end("Local handler failed");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(
    () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  );
  const { port } = z.object({ port: z.number().int().positive() }).parse(server.address());

  return { origin: `http://127.0.0.1:${port}`, failures };
}
