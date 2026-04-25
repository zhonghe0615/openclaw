import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { mightBeReminderIntent, tryLlmReminderFallback } from "./reminder.llm.js";

const { mockRunEmbeddedPiAgent } = vi.hoisted(() => ({
  mockRunEmbeddedPiAgent: vi.fn(),
}));

vi.mock("../agents/pi-embedded.runtime.js", () => ({
  runEmbeddedPiAgent: mockRunEmbeddedPiAgent,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdtemp: vi.fn().mockResolvedValue("/tmp/openclaw-intent-test"),
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));

const cfg = {
  agents: { defaults: { userTimezone: "Asia/Shanghai" } },
  mcp: { servers: { "workspace-reminder": { command: "node", args: ["r.js"] } } },
} satisfies OpenClawConfig;

const baseCtx = {
  CommandAuthorized: true as const,
  BodyForCommands: "睡前叫我关灯",
  CommandBody: "睡前叫我关灯",
  Body: "睡前叫我关灯",
  Provider: "openclaw-weixin",
  Surface: "openclaw-weixin",
  From: "user-1",
  AccountId: "acct-1",
  SessionKey: "agent:codex:openclaw-weixin:user-1",
};

const baseParams = {
  ctx: baseCtx,
  cfg,
  agentId: "codex",
  workspaceDir: "/tmp/ws",
  nowMs: Date.parse("2026-04-25T10:00:00.000Z"),
};

function mockLlm(json: unknown) {
  mockRunEmbeddedPiAgent.mockResolvedValueOnce({
    payloads: [{ text: JSON.stringify(json) }],
  });
}

describe("mightBeReminderIntent", () => {
  it.each([
    ["10分钟后提醒我", true],
    ["睡前叫我关灯", true],
    ["5分钟后去买菜", true],
    ["明天早上开会", true],
    ["吃完饭记得吃药", true],
    ["下午三点通知我", true],
    ["今晚别忘了", true],
    ["今天天气怎么样", false],
    ["帮我查一下新闻", false],
    ["你好", false],
    // too long (> 200 chars)
    ["提醒" + "a".repeat(200), false],
  ] as [string, boolean][])("%s → %s", (text, expected) => {
    expect(mightBeReminderIntent(text)).toBe(expected);
  });
});

describe("tryLlmReminderFallback", () => {
  beforeEach(() => {
    mockRunEmbeddedPiAgent.mockReset();
  });

  it("returns null and skips LLM for empty text", async () => {
    const ctx = { ...baseCtx, BodyForCommands: "", CommandBody: "", Body: "" };
    const result = await tryLlmReminderFallback({ ...baseParams, ctx });
    expect(result).toBeNull();
    expect(mockRunEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("returns null and skips LLM when text has no reminder signal", async () => {
    const ctx = {
      ...baseCtx,
      BodyForCommands: "今天天气怎么样",
      CommandBody: "今天天气怎么样",
      Body: "今天天气怎么样",
    };
    const result = await tryLlmReminderFallback({ ...baseParams, ctx });
    expect(result).toBeNull();
    expect(mockRunEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("returns null when LLM says isReminder: false", async () => {
    mockLlm({ isReminder: false });
    expect(await tryLlmReminderFallback(baseParams)).toBeNull();
  });

  it("returns null on invalid JSON response", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ payloads: [{ text: "not json {broken" }] });
    expect(await tryLlmReminderFallback(baseParams)).toBeNull();
  });

  it("returns null on error payload", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      payloads: [{ isError: true, text: "internal error" }],
    });
    expect(await tryLlmReminderFallback(baseParams)).toBeNull();
  });

  it("returns null when isReminder: true but no time field", async () => {
    mockLlm({ isReminder: true, title: "提醒我" });
    expect(await tryLlmReminderFallback(baseParams)).toBeNull();
  });

  it("strips markdown fences from LLM response", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      payloads: [{ text: '```json\n{"isReminder":true,"title":"关灯","triggerAt":"5m"}\n```' }],
    });
    const result = await tryLlmReminderFallback(baseParams);
    expect(result?.action).toBe("call_tool");
  });

  it("builds one-shot triggerAt decision", async () => {
    mockLlm({ isReminder: true, title: "关灯", triggerAt: "30m" });
    const result = await tryLlmReminderFallback(baseParams);
    expect(result?.action).toBe("call_tool");
    if (result?.action !== "call_tool") {
      return;
    }
    expect(result.routeId).toBe("reminder.once");
    expect(result.tool).toBe("create_reminder");
    expect(result.arguments).toMatchObject({
      title: "关灯",
      triggerAt: "30m",
      deleteAfterRun: true,
    });
    expect(result.reason).toBe("matched_one_shot_reminder_llm");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("builds one-shot dateTime decision", async () => {
    mockLlm({ isReminder: true, title: "开会", dateTime: "2026-04-26T09:00:00" });
    const result = await tryLlmReminderFallback(baseParams);
    if (result?.action !== "call_tool") {
      return;
    }
    expect(result.routeId).toBe("reminder.once");
    expect(result.tool).toBe("create_reminder");
    expect(result.arguments).toMatchObject({
      title: "开会",
      dateTime: "2026-04-26T09:00:00",
      deleteAfterRun: true,
    });
  });

  it("builds recurring cronExpr decision", async () => {
    mockLlm({ isReminder: true, title: "打卡", cronExpr: "0 9 * * 1-5" });
    const result = await tryLlmReminderFallback(baseParams);
    if (result?.action !== "call_tool") {
      return;
    }
    expect(result.routeId).toBe("reminder.recurring");
    expect(result.tool).toBe("create_recurring_reminder");
    expect(result.arguments).toMatchObject({ title: "打卡", cronExpr: "0 9 * * 1-5" });
    expect(result.reason).toBe("matched_recurring_reminder_llm");
  });

  it("builds recurring every decision", async () => {
    mockLlm({ isReminder: true, title: "喝水", every: "1h" });
    const result = await tryLlmReminderFallback(baseParams);
    if (result?.action !== "call_tool") {
      return;
    }
    expect(result.routeId).toBe("reminder.recurring");
    expect(result.tool).toBe("create_recurring_reminder");
    expect(result.arguments).toMatchObject({ title: "喝水", every: "1h" });
  });

  it("populates delivery fields from ctx", async () => {
    mockLlm({ isReminder: true, title: "喝水", triggerAt: "10m" });
    const result = await tryLlmReminderFallback(baseParams);
    if (result?.action !== "call_tool") {
      return;
    }
    expect(result.arguments).toMatchObject({
      deliveryChannel: "openclaw-weixin",
      deliveryTarget: "user-1",
      accountId: "acct-1",
      agentId: "codex",
    });
  });

  it("includes dedupe key with session and title", async () => {
    mockLlm({ isReminder: true, title: "喝水", triggerAt: "10m" });
    const result = await tryLlmReminderFallback(baseParams);
    if (result?.action !== "call_tool") {
      return;
    }
    expect(result.dedupeKey).toContain("reminder.once");
    expect(result.dedupeKey).toContain("喝水");
  });
});
