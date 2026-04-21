import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { routeReminderIntent } from "./reminder.js";

const cfg = {
  agents: { defaults: { userTimezone: "Asia/Shanghai" } },
  mcp: {
    servers: {
      "workspace-reminder": {
        command: "node",
        args: ["reminder-mcp.js"],
      },
    },
  },
} satisfies OpenClawConfig;

function route(text: string, nowMs = Date.parse("2026-04-21T03:00:00.000Z")) {
  return routeReminderIntent({
    cfg,
    agentId: "codex",
    nowMs,
    ctx: {
      CommandAuthorized: true,
      Body: text,
      CommandBody: text,
      BodyForCommands: text,
      Provider: "openclaw-weixin",
      Surface: "openclaw-weixin",
      From: "user-1",
      AccountId: "acct-1",
      SessionKey: "agent:codex:openclaw-weixin:user-1",
    },
  });
}

describe("routeReminderIntent", () => {
  it("routes relative one-shot reminders to create_reminder", () => {
    const decision = route("半小时后提醒我喝水");
    expect(decision.action).toBe("call_tool");
    if (decision.action !== "call_tool") {
      return;
    }
    expect(decision.routeId).toBe("reminder.once");
    expect(decision.tool).toBe("create_reminder");
    expect(decision.arguments).toMatchObject({
      title: "喝水",
      triggerAt: "30m",
      deliveryChannel: "openclaw-weixin",
      deliveryTarget: "user-1",
      accountId: "acct-1",
      agentId: "codex",
    });
  });

  it("routes absolute same-day reminders with local datetime", () => {
    const decision = route("今天下午3点提醒我开会");
    expect(decision.action).toBe("call_tool");
    if (decision.action !== "call_tool") {
      return;
    }
    expect(decision.arguments).toMatchObject({
      title: "开会",
      dateTime: "2026-04-21T15:00:00",
      timezone: "Asia/Shanghai",
    });
  });

  it("rolls implicit past times to tomorrow", () => {
    const decision = route("9点提醒我打卡", Date.parse("2026-04-21T03:00:00.000Z"));
    expect(decision.action).toBe("call_tool");
    if (decision.action !== "call_tool") {
      return;
    }
    expect(decision.arguments).toMatchObject({
      dateTime: "2026-04-22T09:00:00",
    });
  });

  it("asks for clarification when reminder time is missing", () => {
    const decision = route("提醒我开会");
    expect(decision).toMatchObject({
      action: "clarify",
      missing: ["time"],
    });
  });

  it("routes daily recurring reminders to create_recurring_reminder", () => {
    const decision = route("每天早上9点提醒我打卡");
    expect(decision.action).toBe("call_tool");
    if (decision.action !== "call_tool") {
      return;
    }
    expect(decision.routeId).toBe("reminder.recurring");
    expect(decision.tool).toBe("create_recurring_reminder");
    expect(decision.arguments).toMatchObject({
      title: "打卡",
      cronExpr: "0 9 * * *",
    });
  });

  it("routes weekday reminders to weekday cron", () => {
    const decision = route("工作日下午6点提醒我写日报");
    expect(decision.action).toBe("call_tool");
    if (decision.action !== "call_tool") {
      return;
    }
    expect(decision.arguments).toMatchObject({
      title: "写日报",
      cronExpr: "0 18 * * 1-5",
    });
  });

  it("passes non-reminder messages", () => {
    expect(route("今天下午天气怎么样")).toMatchObject({
      action: "pass",
    });
  });
});
