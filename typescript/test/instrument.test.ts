import { describe, expect, it } from "vitest";
import { RevalexClient } from "../src/client.js";
import { instrumentAnthropic, instrumentOpenAI } from "../src/instrument.js";
import type { TraceInput } from "../src/contract.js";

/** Capture traces without any network: disabled client + redact spy. */
function captureClient() {
  const captured: TraceInput[] = [];
  const client = new RevalexClient({
    apiKey: "ev_test",
    disabled: true,
    redact: (t) => {
      captured.push(t);
      return t;
    },
  });
  return { client, captured };
}

describe("instrumentAnthropic", () => {
  const fakeAnthropic = () => ({
    messages: {
      create: async (_params: unknown) => ({
        model: "claude-opus-4-8",
        usage: { input_tokens: 12, output_tokens: 34 },
        content: [{ type: "text", text: "hello world" }],
      }),
    },
  });

  it("traces model, tokens, and text output; result passes through", async () => {
    const { client, captured } = captureClient();
    const anthropic = instrumentAnthropic(fakeAnthropic(), client);
    const res = await anthropic.messages.create({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] });
    expect(res.usage.output_tokens).toBe(34); // untouched result
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      type: "llm_call",
      name: "anthropic.messages.create",
      model: "claude-opus-4-8",
      tokensIn: 12,
      tokensOut: 34,
      output: "hello world",
      status: "ok",
    });
    expect(typeof captured[0]!.latencyMs).toBe("number");
  });

  it("captureContent:false omits input/output", async () => {
    const { client, captured } = captureClient();
    const anthropic = instrumentAnthropic(fakeAnthropic(), client, { captureContent: false });
    await anthropic.messages.create({ model: "m", messages: [{ role: "user", content: "secret" }] });
    expect(captured[0]!.input).toBeUndefined();
    expect(captured[0]!.output).toBeUndefined();
  });

  it("traces errors and rethrows untouched", async () => {
    const { client, captured } = captureClient();
    const broken = {
      messages: {
        create: async () => {
          throw new Error("rate limited");
        },
      },
    };
    const anthropic = instrumentAnthropic(broken, client);
    await expect(anthropic.messages.create({ model: "m", messages: [] })).rejects.toThrow("rate limited");
    expect(captured[0]).toMatchObject({ status: "error", errorMessage: "rate limited" });
  });
});

describe("instrumentOpenAI", () => {
  const fakeOpenAI = () => ({
    chat: {
      completions: {
        create: async (_params: unknown) => ({
          model: "gpt-x",
          usage: { prompt_tokens: 7, completion_tokens: 9 },
          choices: [{ message: { role: "assistant", content: "hey there" } }],
        }),
      },
    },
  });

  it("traces model, tokens, and message content", async () => {
    const { client, captured } = captureClient();
    const openai = instrumentOpenAI(fakeOpenAI(), client);
    const res = await openai.chat.completions.create({ model: "gpt-x", messages: [{ role: "user", content: "hi" }] });
    expect(res.choices[0].message.content).toBe("hey there");
    expect(captured[0]).toMatchObject({
      type: "llm_call",
      name: "openai.chat.completions.create",
      model: "gpt-x",
      tokensIn: 7,
      tokensOut: 9,
      output: "hey there",
      status: "ok",
    });
  });

  it("streaming calls trace latency but not output", async () => {
    const { client, captured } = captureClient();
    const streamy = {
      chat: { completions: { create: async (_p: unknown) => ({ model: "gpt-x" }) } },
    };
    const openai = instrumentOpenAI(streamy, client);
    await openai.chat.completions.create({ model: "gpt-x", stream: true, messages: [] });
    expect(captured[0]!.output).toBeUndefined();
    expect(captured[0]!.metadata).toMatchObject({ streaming: true });
  });
});
