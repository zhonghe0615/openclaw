import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  routeDeleteReminderIntent,
  routeListRemindersIntent,
  routeReminderIntent,
} from "./reminder.js";

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

function routeList(text: string) {
  return routeListRemindersIntent({
    cfg,
    agentId: "codex",
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

describe("routeListRemindersIntent", () => {
  it.each([
    ["查一下现在的任务", "upcoming"],
    ["列一下现在的任务", "upcoming"],
    ["列出当前提醒", "upcoming"],
    ["看看现有任务", "upcoming"],
    ["现在有哪些任务", "upcoming"],
    ["当前提醒", "upcoming"],
    ["列一下所有任务", "all"],
    ["查看今天的提醒", "today"],
  ] as [string, "today" | "upcoming" | "all"][])("%s", (text, filter) => {
    const decision = routeList(text);
    expect(decision).toMatchObject({
      action: "call_tool",
      routeId: "reminder.list",
      tool: "list_reminders",
      arguments: { filter },
    });
  });

  it("passes unrelated text", () => {
    expect(routeList("今天下午天气怎么样")).toBeNull();
  });
});

describe("routeDeleteReminderIntent", () => {
  it("routes explicit delete-by-name requests", () => {
    const decision = routeDeleteReminderIntent({
      cfg,
      ctx: {
        CommandAuthorized: true,
        Body: "删除买咖啡回魂这个任务",
        CommandBody: "删除买咖啡回魂这个任务",
        BodyForCommands: "删除买咖啡回魂这个任务",
      },
    } as Parameters<typeof routeDeleteReminderIntent>[0]);
    expect(decision).toMatchObject({
      action: "delete_reminder",
      targetHint: "买咖啡回魂",
    });
  });

  it("normalizes quoted delete targets", () => {
    const decision = routeDeleteReminderIntent({
      cfg,
      ctx: {
        CommandAuthorized: true,
        Body: "删除 “测试任务”",
        CommandBody: "删除 “测试任务”",
        BodyForCommands: "删除 “测试任务”",
      },
    } as Parameters<typeof routeDeleteReminderIntent>[0]);
    expect(decision).toMatchObject({
      action: "delete_reminder",
      targetHint: "测试任务",
    });
  });

  it("routes quoted delete requests without reminder nouns", () => {
    const decision = routeDeleteReminderIntent({
      cfg,
      ctx: {
        CommandAuthorized: true,
        Body: "取消“去上厕所”",
        CommandBody: "取消“去上厕所”",
        BodyForCommands: "取消“去上厕所”",
      },
    } as Parameters<typeof routeDeleteReminderIntent>[0]);
    expect(decision).toMatchObject({
      action: "delete_reminder",
      targetHint: "去上厕所",
    });
  });

  it("drops relative-time phrasing from delete targets", () => {
    const decision = routeDeleteReminderIntent({
      cfg,
      ctx: {
        CommandAuthorized: true,
        Body: "取消10分钟后的这个测试任务",
        CommandBody: "取消10分钟后的这个测试任务",
        BodyForCommands: "取消10分钟后的这个测试任务",
      },
    } as Parameters<typeof routeDeleteReminderIntent>[0]);
    expect(decision).toMatchObject({
      action: "delete_reminder",
      targetHint: "测试",
    });
  });

  it("routes reply-based delete requests", () => {
    const decision = routeDeleteReminderIntent({
      cfg,
      ctx: {
        CommandAuthorized: true,
        Body: "这个任务删掉吧",
        CommandBody: "这个任务删掉吧",
        BodyForCommands: "这个任务删掉吧",
        ReplyToBody: "看一下 雨小了就提醒",
      },
    } as Parameters<typeof routeDeleteReminderIntent>[0]);
    expect(decision).toMatchObject({
      action: "delete_reminder",
      referencedText: "看一下 雨小了就提醒",
    });
  });

  it("asks for clarification when delete target is missing", () => {
    const decision = routeDeleteReminderIntent({
      cfg,
      ctx: {
        CommandAuthorized: true,
        Body: "删除这个提醒",
        CommandBody: "删除这个提醒",
        BodyForCommands: "删除这个提醒",
      },
    } as Parameters<typeof routeDeleteReminderIntent>[0]);
    expect(decision).toMatchObject({
      action: "clarify",
      missing: ["reminder_target"],
    });
  });
});
