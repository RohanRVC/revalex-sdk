import { describe, expect, it, vi } from "vitest";
import { RevalexClient } from "../src/client.js";

function mockFetch(status = 200, body: unknown = { accepted: 1, duplicates: 0 }) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("RevalexClient", () => {
  it("requires an apiKey", () => {
    expect(() => new RevalexClient({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("enqueues traces and sends them on flush", async () => {
    const fetchFn = mockFetch();
    const client = new RevalexClient({ apiKey: "ev_test", fetchFn, flushIntervalMs: 999_999 });
    client.trace({ type: "llm_call", name: "test-call", input: "hi", output: "hello" });
    await client.flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(client.stats.sent).toBe(1);
    await client.shutdown();
  });

  it("auto-generates a clientTraceId (idempotency key)", async () => {
    const fetchFn = mockFetch();
    const client = new RevalexClient({ apiKey: "ev_test", fetchFn, flushIntervalMs: 999_999 });
    client.trace({ type: "llm_call", name: "x" });
    await client.flush();
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const sent = JSON.parse((call[1] as RequestInit).body as string);
    expect(sent.traces[0].clientTraceId).toMatch(/^[0-9a-f-]{36}$/);
    await client.shutdown();
  });

  it("never throws from trace() even with a broken redact hook", () => {
    const client = new RevalexClient({
      apiKey: "ev_test",
      disabled: true,
      redact: () => {
        throw new Error("boom");
      },
    });
    expect(() => client.trace({ type: "llm_call", name: "x" })).not.toThrow();
    expect(client.stats.failed).toBe(1);
  });

  it("drops oldest traces when the queue is full (bounded memory)", () => {
    const client = new RevalexClient({
      apiKey: "ev_test",
      fetchFn: mockFetch(),
      flushIntervalMs: 999_999,
      maxQueueSize: 2,
    });
    client.trace({ type: "llm_call", name: "a" });
    client.trace({ type: "llm_call", name: "b" });
    client.trace({ type: "llm_call", name: "c" });
    expect(client.stats.dropped).toBe(1);
  });

  it("does not retry on a 401 (bad key) — fail-open, no infinite loops", async () => {
    const fetchFn = mockFetch(401, { error: { code: "unauthorized", message: "bad key" } });
    const errors: Error[] = [];
    const client = new RevalexClient({
      apiKey: "ev_bad",
      fetchFn,
      flushIntervalMs: 999_999,
      onError: (e) => errors.push(e),
    });
    client.trace({ type: "llm_call", name: "x" });
    await client.flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(errors.some((e) => /401/.test(e.message))).toBe(true);
    await client.shutdown();
  });

  it("wrap() times the call, records errors, and re-throws untouched", async () => {
    const fetchFn = mockFetch();
    const client = new RevalexClient({ apiKey: "ev_test", fetchFn, flushIntervalMs: 999_999 });
    await expect(
      client.wrap({ type: "llm_call", name: "failing" }, async () => {
        throw new Error("model exploded");
      }),
    ).rejects.toThrow("model exploded");
    expect(client.stats.enqueued).toBe(1);
    await client.shutdown();
  });
});
