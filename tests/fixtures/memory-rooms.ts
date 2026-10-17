import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import {
  ShareAdmission,
  DEFAULT_ADMISSION_LIMITS,
  type AdmissionApi,
  type AdmissionLimits,
} from "../../infra/sync-server/src/admission.js";
import { ShareRoom, type RoomStorage, type SqlRow, type SqlValue } from "../../infra/sync-server/src/room.js";
import type { RoomApi, RoomDirectory } from "../../infra/sync-server/src/router.js";

function toSqlite(value: SqlValue): SQLInputValue {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

const scalarSchema = z.union([z.string(), z.number(), z.null()]);

/** A column as a Durable Object returns it: BLOBs as ArrayBuffer. */
function fromSqlite(value: SQLInputValue): SqlValue {
  if (value instanceof Uint8Array) return value.slice().buffer;

  return scalarSchema.parse(value);
}

/**
 * Durable Object SQLite storage on node:sqlite. Alarms are recorded, not run, and `exec` takes one statement, which is
 * all the room uses.
 */
export class MemoryRoomStorage implements RoomStorage {
  alarm: number | null = null;
  private db = new DatabaseSync(":memory:");

  readonly sql: RoomStorage["sql"] = {
    exec: (query, ...bindings) => {
      const rows = this.db.prepare(query).all(...bindings.map(toSqlite));

      return {
        toArray: () =>
          rows.map((row): SqlRow =>
            Object.fromEntries(Object.entries(row).map(([column, value]) => [column, fromSqlite(value)])),
          ),
      };
    },
  };

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  /** Leaves an empty database with no tables, as the real `deleteAll` does. */
  async deleteAll(): Promise<void> {
    this.db.close();
    this.db = new DatabaseSync(":memory:");
  }
}

/** Rooms by name, each a ShareRoom over its own storage, reached the way the Worker reaches Durable Objects. */
export class MemoryRooms {
  readonly storages = new Map<string, MemoryRoomStorage>();
  /** One room per name for the life of the test, as a Durable Object instance outlives the requests it serves. */
  private readonly rooms = new Map<string, ShareRoom>();
  /** Clock in epoch milliseconds, read by both the rooms and admission. */
  now = Date.parse("2026-09-28T12:00:00.000Z");
  /** When true, every room and admission call rejects, like an unavailable Durable Object. */
  failing = false;
  /** Storage for the deployment's admission coordinator, separate from room storage. */
  readonly admissionStorage = new MemoryRoomStorage();
  private readonly budget: ShareAdmission;

  /** Runs the production admission policy over `admissionStorage`. */
  constructor(limits: AdmissionLimits = DEFAULT_ADMISSION_LIMITS) {
    this.budget = new ShareAdmission(this.admissionStorage, limits);
  }

  /** The production admission policy, reading the same `now` as the rooms. */
  readonly admission: AdmissionApi = {
    check: async (name, source) => {
      this.check();

      return this.budget.check(name, source, this.now);
    },
    register: async (name, source) => {
      this.check();

      return this.budget.register(name, source, this.now);
    },
  };

  readonly directory: RoomDirectory = (name) => {
    let room = this.rooms.get(name);

    if (!room) {
      const storage = new MemoryRoomStorage();
      room = new ShareRoom(storage);
      this.storages.set(name, storage);
      this.rooms.set(name, room);
    }

    const current = room;

    const api: RoomApi = {
      exists: async () => {
        this.check();

        return current.exists();
      },
      publish: async (body) => {
        this.check();

        return current.publish(body, this.now);
      },
      read: async (known) => {
        this.check();

        return current.read(known);
      },
      remove: async () => {
        this.check();
        await current.remove();
      },
    };

    return api;
  };

  private check(): void {
    if (this.failing) throw new Error("Durable Object unavailable");
  }
}
