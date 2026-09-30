// Stores shared permit lists for Permit Monitor: one SQLite-backed Durable Object per list, holding only the latest
// encrypted copy. The rules live in room.ts and router.ts, which run without the Workers runtime in tests; this file
// binds them to it.
import { DurableObject } from "cloudflare:workers";
import { admissionLimitsSchema, ShareAdmission, type AdmissionResult } from "./admission.js";
import { ShareRoom, type PublishResult, type ReadResult } from "./room.js";
import { route } from "./router.js";

/** Bindings from wrangler.jsonc. */
export type SyncEnv = SyncWorkerEnv;

/** One shared list. The Worker names it from a hash of the list's read token. */
export class ShareRoomObject extends DurableObject<SyncEnv> {
  private readonly room: ShareRoom;

  /** Wraps this room's SQLite storage in its domain policy. */
  constructor(ctx: DurableObjectState, env: SyncEnv) {
    super(ctx, env);
    this.room = new ShareRoom(ctx.storage);
  }

  /** Publishes admitted ciphertext with the current service time. */
  publish(body: ArrayBuffer): Promise<PublishResult> {
    return this.room.publish(body, Date.now());
  }

  /** Reports existing ciphertext without allocating persistent storage. */
  exists(): boolean {
    return this.room.exists();
  }

  /** Reads the latest ciphertext or reports its revision as unchanged. */
  read(knownRevision: number | null): ReadResult {
    return this.room.read(knownRevision);
  }

  /** Removes the ciphertext and retention alarm without releasing the admission reservation. */
  remove(): Promise<void> {
    return this.room.remove();
  }

  /** The retention alarm: nobody has published for RETENTION_MS, so the list goes. */
  override async alarm(): Promise<void> {
    await this.room.remove();
  }
}

/** One fixed deployment budget; synchronous SQLite operations serialize admissions, independent of source or key. */
export class ShareAdmissionObject extends DurableObject<SyncEnv> {
  private readonly admission: ShareAdmission;

  /** Parses deployment limits once for this object's lifetime and initializes its fixed schema. */
  constructor(ctx: DurableObjectState, env: SyncEnv) {
    super(ctx, env);

    const limits = admissionLimitsSchema.parse({
      sourceWritesPerMinute: env.SHARE_SOURCE_WRITES_PER_MINUTE,
      sourceCreationsPerDay: env.SHARE_SOURCE_CREATIONS_PER_DAY,
      deploymentCreationsPerDay: env.SHARE_DEPLOYMENT_CREATIONS_PER_DAY,
      registeredRooms: env.SHARE_REGISTERED_ROOMS,
      trackedSources: env.SHARE_TRACKED_SOURCES,
    });

    this.admission = new ShareAdmission(ctx.storage, limits);
  }

  /** Charges the source's request quota before any request body is read. */
  check(roomName: string, source: string): AdmissionResult {
    return this.admission.check(roomName, source, Date.now());
  }

  /** Atomically registers a validated new room before its ciphertext can be written. */
  register(roomName: string, source: string): AdmissionResult {
    return this.admission.register(roomName, source, Date.now());
  }
}

export default {
  fetch(request: Request, env: SyncEnv): Promise<Response> {
    return route(request, (name) => env.ROOMS.getByName(name), env.ADMISSION.getByName("deployment-budget-v1"));
  },
};
