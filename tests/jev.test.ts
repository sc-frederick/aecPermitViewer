import type { Fetch, JsonValue } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chooseNavigation, navigationClient, type NavigationDecision } from "../src/main/jev.js";
import type { PageObservation } from "../src/shared/worker-protocol.js";

// The real SDK client runs every request through its fetch seam, which answers from the test; nothing leaves the process.

/** A search page offering one step, so Jev is offered `open`, `WAIT`, and `STOP`. */
const OBSERVATION: PageObservation = {
  phase: "search",
  location: "permit-search",
  fingerprint: "search-page",
  headings: ["Building Permits"],
  formLabels: ["Record Number"],
  visibleControls: ["Record Number field"],
  resultNumbers: [],
  recentActions: [],
  candidates: [{ id: "open", description: "Open the exact result.", established: false }],
};

/** The part of the request body that says which labels were offered. */
const offeredCriteriaSchema = z.object({
  questions: z.object({ next: z.object({ criteria: z.record(z.string(), z.string()) }) }),
});

/** What the service saw: the criteria of each request it received. */
interface ServiceLog {
  offered: string[][];
}

/** The SDK's fetch seam standing in for the service, and what it was asked. */
interface ScriptedService {
  fetch: Fetch;
  log: ServiceLog;
}

type Reply = (init: RequestInit | undefined) => Promise<Response>;

/** A fetch that answers the n-th request with the n-th reply and records what it was asked. */
function service(replies: Reply[]): ScriptedService {
  const log: ServiceLog = { offered: [] };

  const fetch: Fetch = async (_url, init) => {
    const body = offeredCriteriaSchema.parse(JSON.parse(String(init?.body)));
    log.offered.push(Object.keys(body.questions.next.criteria));
    const reply = replies[log.offered.length - 1];

    if (!reply) throw new Error(`Unexpected request ${log.offered.length}`);

    return reply(init);
  };

  return { fetch, log };
}

function json(status: number, body: JsonValue, headers: Record<string, string> = {}): Reply {
  return async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A successful reply carrying `next` as the answer. */
function answering(next: JsonValue): Reply {
  return json(200, { model: "jev-1.13.0", answers: { next }, usage: { input_tokens: 10, output_tokens: 2 } });
}

function answer(choice: string, confidence: number, probabilities: Record<string, number>): Reply {
  return answering({ type: "choice", choice, confidence, probabilities });
}

const rateLimited = json(429, { error: "rate limited" }, { "retry-after-ms": "0" });

async function decide(
  fetch: Fetch,
  controller = new AbortController(),
  remainingRequests = 20,
): Promise<NavigationDecision> {
  return chooseNavigation({
    client: navigationClient("test-key", fetch),
    jurisdictionId: "hillsborough-county-building",
    observation: OBSERVATION,
    requestedNumber: "HC-BLD-26-0000001",
    signal: controller.signal,
    remainingRequests,
    deadline: Date.now() + 60_000,
    onAttempt: () => undefined,
  });
}

describe("Jev navigation answers", () => {
  it("takes a confident, well-separated choice among the offered steps", async () => {
    const { fetch, log } = service([answer("open", 0.95, { open: 0.95, WAIT: 0.03, STOP: 0.02 })]);

    expect(await decide(fetch)).toEqual({
      _tag: "chosen",
      candidateId: "open",
      actualModel: "jev-1.13.0",
      attempts: 1,
    });
    expect(log.offered).toEqual([["open", "WAIT", "STOP"]]);
  });

  it("returns WAIT and STOP as their own decisions", async () => {
    expect(await decide(service([answer("WAIT", 0.9, { open: 0.05, WAIT: 0.9, STOP: 0.05 })]).fetch)).toEqual({
      _tag: "wait",
      actualModel: "jev-1.13.0",
      attempts: 1,
    });
    expect(await decide(service([answer("STOP", 0.9, { open: 0.05, WAIT: 0.05, STOP: 0.9 })]).fetch)).toEqual({
      _tag: "stop",
      actualModel: "jev-1.13.0",
      attempts: 1,
    });
  });

  it("refuses an answer that omits offered alternatives, which would otherwise inflate the margin", async () => {
    const decision = await decide(service([answer("open", 0.9, { open: 1 })]).fetch);

    expect(decision).toEqual({
      _tag: "malformed_response",
      problem: "missing_alternative",
      actualModel: "jev-1.13.0",
      attempts: 1,
    });
  });

  it.each([
    ["confidence above 1", answer("open", 10, { open: 10, WAIT: -5, STOP: -5 })],
    ["a negative probability", answer("open", 0.9, { open: 1.05, WAIT: -0.05, STOP: 0 })],
    ["a probability above 1", answer("open", 0.9, { open: 1.2, WAIT: 0, STOP: 0 })],
    ["not a choice answer", answering({ type: "noul", noul: 0.9 })],
    [
      "a missing confidence",
      answering({ type: "choice", choice: "open", probabilities: { open: 1, WAIT: 0, STOP: 0 } }),
    ],
    ["no answer to the question asked", json(200, { model: "jev-1.13.0", answers: {} })],
  ])("refuses %s", async (_case, reply) => {
    expect(await decide(service([reply]).fetch)).toMatchObject({
      _tag: "malformed_response",
      problem: "invalid_answer",
    });
  });

  it("refuses a choice that wasn't offered", async () => {
    const decision = await decide(service([answer("submit", 0.9, { open: 0, WAIT: 0, STOP: 0, submit: 1 })]).fetch);

    expect(decision).toMatchObject({ _tag: "malformed_response", problem: "unknown_choice" });
  });

  it("refuses probabilities for labels that weren't offered", async () => {
    const decision = await decide(
      service([answer("open", 0.9, { open: 0.9, WAIT: 0.05, STOP: 0, submit: 0.05 })]).fetch,
    );

    expect(decision).toMatchObject({ _tag: "malformed_response", problem: "unexpected_alternative" });
  });

  it("refuses probabilities that aren't a distribution", async () => {
    const decision = await decide(service([answer("open", 0.9, { open: 0.9, WAIT: 0.9, STOP: 0.9 })]).fetch);

    expect(decision).toMatchObject({ _tag: "malformed_response", problem: "not_normalized" });
  });

  it("accepts probabilities that sum to 1 only after rounding", async () => {
    const decision = await decide(service([answer("open", 0.9, { open: 0.903, WAIT: 0.048, STOP: 0.048 })]).fetch);

    expect(decision).toMatchObject({ _tag: "chosen", candidateId: "open" });
  });

  it.each([
    [
      "no model name",
      json(200, {
        answers: {
          next: { type: "choice", choice: "open", confidence: 1, probabilities: { open: 1, WAIT: 0, STOP: 0 } },
        },
      }),
    ],
    ["no answers", json(200, { model: "jev-1.13.0" })],
    [
      "a body that isn't JSON",
      async () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }),
    ],
  ])("refuses a reply with %s", async (_case, reply: Reply) => {
    expect(await decide(service([reply]).fetch)).toEqual({
      _tag: "malformed_response",
      problem: "reply",
      actualModel: null,
      attempts: 1,
    });
  });

  it("keeps a weak margin or low confidence as too uncertain to act on, not as a malformed reply", async () => {
    expect(await decide(service([answer("open", 0.9, { open: 0.5, WAIT: 0.45, STOP: 0.05 })]).fetch)).toEqual({
      _tag: "unsupported_page",
      actualModel: "jev-1.13.0",
      attempts: 1,
    });
    expect(await decide(service([answer("open", 0.5, { open: 0.9, WAIT: 0.05, STOP: 0.05 })]).fetch)).toEqual({
      _tag: "unsupported_page",
      actualModel: "jev-1.13.0",
      attempts: 1,
    });
  });
});

describe("Jev navigation requests", () => {
  it("reports cancellation when the run's signal ends a request in flight", async () => {
    const controller = new AbortController();

    const { fetch, log } = service([
      (init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          controller.abort();
        }),
    ]);

    expect(await decide(fetch, controller)).toEqual({ _tag: "cancelled", actualModel: null, attempts: 1 });
    expect(log.offered).toHaveLength(1);
  });

  // The server asks for the longest wait the app honors (5 s), so a wait the signal couldn't end would outlast the
  // test's 5 s budget before the second request failed it.
  it("reports cancellation during the wait before retrying a rate-limited request", async () => {
    const controller = new AbortController();

    const { fetch, log } = service([
      async () => {
        setTimeout(() => controller.abort(), 50);

        return json(429, { error: "rate limited" }, { "retry-after-ms": "5000" })(undefined);
      },
    ]);

    expect(await decide(fetch, controller)).toEqual({ _tag: "cancelled", actualModel: null, attempts: 1 });
    expect(log.offered).toHaveLength(1);
  });

  it("does not ask once the run is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, log } = service([]);

    expect(await decide(fetch, controller)).toEqual({ _tag: "cancelled", actualModel: null, attempts: 0 });
    expect(log.offered).toEqual([]);
  });

  it("retries a rate-limited request once, then answers", async () => {
    const { fetch, log } = service([rateLimited, answer("open", 0.95, { open: 0.95, WAIT: 0.03, STOP: 0.02 })]);

    expect(await decide(fetch)).toEqual({
      _tag: "chosen",
      candidateId: "open",
      actualModel: "jev-1.13.0",
      attempts: 2,
    });
    expect(log.offered).toHaveLength(2);
  });

  it("gives up as unavailable when the retry is rate-limited too", async () => {
    const { fetch, log } = service([rateLimited, rateLimited]);

    expect(await decide(fetch)).toEqual({ _tag: "api_unavailable", actualModel: null, attempts: 2 });
    expect(log.offered).toHaveLength(2);
  });

  it("does not retry past the run's remaining request budget", async () => {
    const { fetch, log } = service([rateLimited]);

    expect(await decide(fetch, new AbortController(), 1)).toEqual({
      _tag: "api_unavailable",
      actualModel: null,
      attempts: 1,
    });
    expect(log.offered).toHaveLength(1);
  });

  it("reports a rejected key without retrying", async () => {
    const { fetch, log } = service([json(401, { error: "invalid key" })]);

    expect(await decide(fetch)).toEqual({ _tag: "authentication_error", actualModel: null, attempts: 1 });
    expect(log.offered).toHaveLength(1);
  });
});
