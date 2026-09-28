// The part of the Workers runtime module the sync Worker uses, declared here so the repository's type check needs no
// Cloudflare type package. See https://developers.cloudflare.com/durable-objects/api/base/.
declare module "cloudflare:workers" {
  import type { RoomStorage } from "./room.js";

  export abstract class DurableObject<Env> {
    protected readonly ctx: { readonly storage: RoomStorage };
    protected readonly env: Env;
    constructor(ctx: { readonly storage: RoomStorage }, env: Env);
  }
}
