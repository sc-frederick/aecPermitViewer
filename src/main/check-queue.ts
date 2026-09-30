import type { RunOutcome } from "../shared/permit.js";

/** Why a check was queued: someone asked for it, or the daily schedule found the permit due. */
export type CheckReason = "manual" | "scheduled";

/** Why checks can't run for lack of a usable key: none is saved, the saved one can't be read, or the service turned it down. */
export type KeyProblem = "missing" | "unreadable" | "rejected";

/** A check that has started; `finished` settles with its recorded outcome, or null when nothing was recorded. */
export interface StartedCheck {
  finished: Promise<RunOutcome | null>;
  cancel: () => void;
}

/** What the queue needs from the rest of the app. Each is a narrow question or action about one permit. */
export interface CheckQueuePorts {
  /** The portal pacing scope a permit's checks share, such as the host several authorities sit behind; null when it can't be checked. */
  scopeOf: (permitId: string) => string | null;
  /** Whether a scheduled check may still start now: scheduling on, inside the check window, and the permit included. */
  scheduledEligible: (permitId: string) => boolean;
  /** The saved key, or null when none is saved. Rejects when a saved key can't be read or decrypted. */
  readKey: () => Promise<string | null>;
  /**
   * Starts the browser check. `finished` rejects only when its result couldn't be saved. `stillWanted` answers whether
   * the check should still go ahead: false once it was cancelled, the queue stopped, or scheduled work stopped qualifying.
   * Call it after any wait of your own and immediately before the run begins, and settle `finished` with null when false.
   */
  start: (permitId: string, key: string, stillWanted: () => boolean) => StartedCheck;
  /** A cancelled check that never started waits for the permit's next scheduled slot instead of being picked up again. */
  defer: (permitId: string) => void;
  /** A check couldn't run for want of a key. `requested` is true when someone asked for that check. */
  keyUnavailable: (problem: KeyProblem, requested: boolean) => void;
  /** A check's result couldn't be saved locally. */
  saveFailed: () => void;
  /** The set of permits being checked changed. */
  changed: () => void;
}

interface Entry {
  permitId: string;
  reason: CheckReason;
}

interface Current extends Entry {
  cancelled: boolean;
  cancel: () => void;
}

/** Portals see at most one check per scope in this window, measured from the end of the last one. */
export const SCOPE_SPACING_MS = 30_000;

/**
 * Runs permit checks one at a time. Checks on different portals don't wait for each other; checks on one portal are
 * spaced out. Scheduled work is rechecked for eligibility when it is about to start, again after the key is read, and
 * through `stillWanted` after the starter's own waits; it pauses while no key works. Manual requests always go ahead.
 */
export class CheckQueue {
  private entries: Entry[] = [];
  private current: Current | null = null;
  private readonly readyAt = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private paused: KeyProblem | null = null;
  private again = false;
  private keyGeneration = 0;

  constructor(private readonly ports: CheckQueuePorts) {}

  /** Queues a check unless one is already queued or running; a manual request upgrades a queued scheduled one. */
  enqueue(permitId: string, reason: CheckReason): void {
    if (this.stopped || (reason === "scheduled" && this.paused === "rejected") || !this.ports.scopeOf(permitId)) return;

    if (this.current?.permitId === permitId) return;
    const queued = this.entries.find((entry) => entry.permitId === permitId);

    if (queued) {
      if (reason === "manual") queued.reason = "manual";

      return;
    }

    this.entries.push({ permitId, reason });
    this.ports.changed();
    this.kick();
  }

  /** Stops a queued, starting, or running check for the permit. */
  cancel(permitId: string): void {
    const index = this.entries.findIndex((entry) => entry.permitId === permitId);

    if (index >= 0) {
      this.entries.splice(index, 1);
      this.ports.defer(permitId);
      this.ports.changed();
    }

    if (this.current?.permitId === permitId && !this.current.cancelled) {
      this.current.cancelled = true;
      this.current.cancel();
    }
  }

  /** Forgets a queued check for a permit being removed. Returns false while its check is under way. */
  remove(permitId: string): boolean {
    if (this.current?.permitId === permitId) return false;
    this.entries = this.entries.filter((entry) => entry.permitId !== permitId);

    return true;
  }

  /** Drops queued scheduled work that is no longer eligible, after a setting changed. */
  prune(): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.reason === "manual" || this.ports.scheduledEligible(entry.permitId));

    if (this.entries.length !== before) this.ports.changed();
  }

  /** Permits with a check queued, starting, or running. */
  checkingIds(): Set<string> {
    const ids = new Set(this.entries.map((entry) => entry.permitId));

    if (this.current) ids.add(this.current.permitId);

    return ids;
  }

  /** True after the service rejected the key; scheduled checks aren't queued again until a key is saved. */
  get keyPaused(): boolean {
    return this.paused === "rejected";
  }

  /** A key was saved, so paused checks may run again. */
  resume(): void {
    this.keyGeneration += 1;
    this.paused = null;
    this.kick();
  }

  /** Stops taking work and cancels what is running. Resolves once the loop has finished. */
  stop(): Promise<void> {
    this.stopped = true;
    this.entries = [];
    this.clearTimer();
    this.ports.changed();

    if (this.current && !this.current.cancelled) {
      this.current.cancelled = true;
      this.current.cancel();
    }

    return this.running ?? Promise.resolve();
  }

  /** Takes work again after a shutdown that didn't go ahead. */
  restart(): void {
    this.stopped = false;
    this.kick();
  }

  /** Whether a check is starting or running. */
  get busy(): boolean {
    return this.current !== null;
  }

  private kick(): void {
    if (this.stopped) return;

    // Work that arrives while the loop is finishing is looked at again once it has.
    if (this.running) {
      this.again = true;

      return;
    }

    this.again = false;
    this.clearTimer();
    this.running = this.loop().finally(() => {
      this.running = null;

      if (this.again) this.kick();
    });
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The first queued entry whose scope is ready, taken off the queue, or when the soonest scope will be. */
  private next(): { _tag: "ready"; entry: Entry } | { _tag: "wait"; until: number } | { _tag: "empty" } {
    const now = Date.now();
    let soonest = Number.POSITIVE_INFINITY;

    for (const [index, entry] of this.entries.entries()) {
      const scope = this.ports.scopeOf(entry.permitId);
      const ready = scope ? this.readyAt.get(scope) ?? 0 : 0;

      if (ready <= now) {
        this.entries.splice(index, 1);

        return { _tag: "ready", entry };
      }

      soonest = Math.min(soonest, ready);
    }

    return Number.isFinite(soonest) ? { _tag: "wait", until: soonest } : { _tag: "empty" };
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const next = this.next();

      if (next._tag === "empty") return;

      if (next._tag === "wait") {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.kick();
        }, next.until - Date.now());

        return;
      }

      await this.run(next.entry);
    }
  }

  /** Whether an entry may still start: a manual request always may; scheduled work must qualify and not wait on a rejected key. */
  private wanted(entry: Entry): boolean {
    return entry.reason === "manual" || (this.paused !== "rejected" && this.ports.scheduledEligible(entry.permitId));
  }

  private async run(entry: Entry): Promise<void> {
    const scope = this.ports.scopeOf(entry.permitId);

    if (!scope || !this.wanted(entry)) {
      this.ports.changed();

      return;
    }

    const current: Current = { ...entry, cancelled: false, cancel: () => undefined };
    this.current = current;

    try {
      let generation = this.keyGeneration;
      let key = await this.ports.readKey().then((value) => value ?? "missing" as const, () => "unreadable" as const);

      // A replacement during a delayed read invalidates its answer, including missing/unreadable answers.
      while (generation !== this.keyGeneration && !this.stopped && !current.cancelled) {
        generation = this.keyGeneration;
        key = await this.ports.readKey().then((value) => value ?? "missing" as const, () => "unreadable" as const);
      }

      if (this.stopped || current.cancelled) {
        if (current.cancelled) this.ports.defer(entry.permitId);

        return;
      }

      // Settings can change while the key is read. Work that no longer qualifies stays due for a later pass.
      if (!this.wanted(entry)) return;

      if (key === "missing" || key === "unreadable") {
        this.pause(key, entry.reason === "manual");

        return;
      }

      // A key that reads again ends a pause for a missing or unreadable one; a rejected key waits for a new one.
      if (this.paused !== "rejected") this.paused = null;

      const check = this.ports.start(entry.permitId, key, () => !this.stopped && !current.cancelled && generation === this.keyGeneration && this.wanted(entry));
      current.cancel = check.cancel;

      let saveFailed = false;

      const outcome = await check.finished.catch(() => {
        saveFailed = true;
        this.ports.saveFailed();

        return null;
      });

      if (outcome !== null) this.readyAt.set(scope, Date.now() + SCOPE_SPACING_MS);
      // A check cancelled before it recorded a run still waits for its next slot, like one cancelled in the queue.
      else if (current.cancelled) this.ports.defer(entry.permitId);
      // The starter can still be waiting for the bundled browser when a key is replaced. Its stale generation
      // must not launch, but the original request still belongs to the new key and needs another start.
      else if (!saveFailed && generation !== this.keyGeneration && !this.stopped && this.wanted(entry)) this.entries.unshift(entry);

      if (outcome === "authentication_error" && generation === this.keyGeneration) this.pause("rejected", false);
    } finally {
      this.current = null;
      this.ports.changed();
    }
  }

  /**
   * Without a working key every check would fail the same way, so the queue empties rather than recording failures.
   * The notice goes out when the problem first appears or changes, and again for each check someone asked for.
   */
  private pause(problem: KeyProblem, requested: boolean): void {
    this.entries = [];

    if (this.paused === problem && !requested) return;
    this.paused = problem;
    this.ports.keyUnavailable(problem, requested);
  }
}
