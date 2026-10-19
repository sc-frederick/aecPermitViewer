import { DurableObject } from "cloudflare:workers";
import { admissionLimitsSchema, ShareAdmission, type AdmissionResult } from "./admission.js";
import { ShareRoom, type PublishResult, type ReadResult } from "./room.js";
import { route } from "./router.js";

export type SyncEnv = SyncWorkerEnv;

export class ShareRoomObject extends DurableObject<SyncEnv> {
  private readonly room: ShareRoom;

  constructor(ctx: DurableObjectState, env: SyncEnv) {
    super(ctx, env);
    this.room = new ShareRoom(ctx.storage);
  }

  publish(body: ArrayBuffer): Promise<PublishResult> {
    return this.room.publish(body, Date.now());
  }

  exists(): boolean {
    return this.room.exists();
  }

  read(knownRevision: number | null): ReadResult {
    return this.room.read(knownRevision);
  }

  remove(): Promise<void> {
    return this.room.remove();
  }

  override async alarm(): Promise<void> {
    await this.room.remove();
  }
}

export class ShareAdmissionObject extends DurableObject<SyncEnv> {
  private readonly admission: ShareAdmission;

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

  check(roomName: string, source: string): AdmissionResult {
    return this.admission.check(roomName, source, Date.now());
  }

  register(roomName: string, source: string): AdmissionResult {
    return this.admission.register(roomName, source, Date.now());
  }
}

export default {
  fetch(request: Request, env: SyncEnv): Promise<Response> {
    return route(request, (name) => env.ROOMS.getByName(name), env.ADMISSION.getByName("deployment-budget-v1"));
  },
};
