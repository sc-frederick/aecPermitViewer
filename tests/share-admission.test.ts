import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_ADMISSION_LIMITS } from "../infra/sync-server/src/admission.js";
import { route } from "../infra/sync-server/src/router.js";
import { openList, sealList, ShareService } from "../src/main/share-service.js";
import { SharePublisher } from "../src/main/share-sync.js";
import { readTokenFor, toBase64Url } from "../src/shared/share-protocol.js";
import { MemoryRooms } from "./fixtures/memory-rooms.js";
import { defined } from "./support/defined.js";

const WRITE_KEY = toBase64Url(new Uint8Array(32).fill(10));

const CONTENT_KEY = new Uint8Array(32).fill(11);

const servers: Server[] = [];

const publishers: SharePublisher[] = [];

/** A real HTTP boundary over the production router/admission policy and SQLite-backed room fixture. */
async function serve(rooms: MemoryRooms, responses: number[]): Promise<ShareService> {
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = [];

      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers({ "cf-connecting-ip": "192.0.2.1" });

      for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
        headers.append(
          defined(incoming.rawHeaders[index], "header name"),
          defined(incoming.rawHeaders[index + 1], "header value"),
        );
      }

      const init: RequestInit = { method: incoming.method ?? "GET", headers };
      const body = Buffer.concat(chunks);

      if (body.length > 0) init.body = body;

      const response = await route(
        new Request(`http://127.0.0.1${incoming.url ?? "/"}`, init),
        rooms.directory,
        rooms.admission,
      );

      responses.push(response.status);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      outgoing.writeHead(500);
      outgoing.end();
    });
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());

  return new ShareService(new URL(`http://127.0.0.1:${port}`));
}

afterEach(async () => {
  for (const publisher of publishers.splice(0)) await publisher.stop();
  vi.useRealTimers();

  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("sharing admission over real HTTP", () => {
  it("returns the deployment's bounded creation retry to the app", async () => {
    const rooms = new MemoryRooms({ ...DEFAULT_ADMISSION_LIMITS, sourceCreationsPerDay: 1 });
    const responses: number[] = [];
    const service = await serve(rooms, responses);
    const sealed = sealList("first", CONTENT_KEY);
    expect((await service.publish(WRITE_KEY, sealed))._tag).toBe("published");
    expect(await service.publish(toBase64Url(new Uint8Array(32).fill(12)), sealed)).toEqual({
      _tag: "retry",
      afterSeconds: 3600,
    });
    expect(responses).toEqual([200, 429]);
  });

  it("retries a rate-limited publication at Retry-After and eventually delivers the changed list without another user action", async () => {
    const rooms = new MemoryRooms({ ...DEFAULT_ADMISSION_LIMITS, sourceWritesPerMinute: 1 });
    const responses: number[] = [];
    const service = await serve(rooms, responses);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let json = "first";

    let notifyPublished = (): void => undefined;

    const recovered = new Promise<void>((resolve) => {
      notifyPublished = resolve;
    });

    const reports: string[] = [];

    const publisher = new SharePublisher(
      service,
      WRITE_KEY,
      CONTENT_KEY,
      () => json,
      () => false,
      () => {
        if (publisher.publishedAt === "2026-09-28T12:01:00.000Z") notifyPublished();
      },
      (operation) => {
        reports.push(operation);
      },
    );

    publishers.push(publisher);
    expect(await publisher.syncNow()).toBeNull();
    json = "changed";
    expect(await publisher.syncNow()).not.toBeNull();
    expect(responses).toEqual([200, 429]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(responses).toEqual([200, 429]);
    rooms.now += 60_000;
    await vi.advanceTimersByTimeAsync(1);
    await recovered;
    expect(responses).toEqual([200, 429, 200]);
    expect(publisher.problem).toBeNull();
    expect(reports).toEqual([]);
    const token = defined(await readTokenFor(WRITE_KEY), "read token");
    const reply = await service.fetch(token, null);

    if (reply._tag !== "found") throw new Error("retried list should exist");
    expect(openList(reply.sealed, CONTENT_KEY)).toEqual({ _tag: "ok", json: "changed" });
  });
});
