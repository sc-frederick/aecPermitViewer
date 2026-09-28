// Stores shared permit lists for Permit Monitor: one SQLite-backed Durable Object per list, holding only the latest
// encrypted copy. The rules live in room.ts and router.ts, which run without the Workers runtime in tests; this file
// binds them to it.
import { DurableObject } from "cloudflare:workers";
import { ShareRoom, type PublishResult, type ReadResult, type RoomStorage } from "./room.js";
import { route, type RoomApi } from "./router.js";

/** Bindings from wrangler.jsonc. */
export interface SyncEnv {
  readonly ROOMS: { getByName(name: string): RoomApi };
}

/** One shared list. The Worker names it from a hash of the list's read token. */
export class ShareRoomObject extends DurableObject<SyncEnv> {
  private readonly room: ShareRoom;

  constructor(ctx: { readonly storage: RoomStorage }, env: SyncEnv) {
    super(ctx, env);
    this.room = new ShareRoom(ctx.storage);
  }

  publish(body: ArrayBuffer): Promise<PublishResult> {
    return this.room.publish(body, Date.now());
  }

  read(knownRevision: number | null): ReadResult {
    return this.room.read(knownRevision);
  }

  remove(): Promise<void> {
    return this.room.remove();
  }

  /** The retention alarm: nobody has published for RETENTION_MS, so the list goes. */
  async alarm(): Promise<void> {
    await this.room.remove();
  }
}

export default {
  fetch(request: Request, env: SyncEnv): Promise<Response> {
    return route(request, (name) => env.ROOMS.getByName(name));
  },
};
