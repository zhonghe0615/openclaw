import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetIntentRouterDedupeForTests, tryRouteIntentToMcp } from "./runtime.js";

const { callConfiguredMcpToolMock, callGatewayToolMock, tryLlmReminderFallbackMock } = vi.hoisted(
  () => ({
    callConfiguredMcpToolMock: vi.fn(),
    callGatewayToolMock: vi.fn(),
    tryLlmReminderFallbackMock: vi.fn(async (_params: unknown) => null),
  }),
);

vi.mock("./mcp.js", () => ({
  callConfiguredMcpTool: (params: unknown) => callConfiguredMcpToolMock(params),
}));

vi.mock("../agents/tools/gateway.js", () => ({
  callGatewayTool: (method: string, opts: unknown, params: unknown) =>
    callGatewayToolMock(method, opts, params),
}));

vi.mock("./reminder.llm.js", () => ({
  tryLlmReminderFallback: (params: unknown) => tryLlmReminderFallbackMock(params),
}));

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

const baseCtx = {
  CommandAuthorized: true as const,
  Provider: "openclaw-weixin",
  Surface: "openclaw-weixin",
  From: "user-1",
  AccountId: "acct-1",
  SessionKey: "agent:codex:openclaw-weixin:user-1",
};

describe("tryRouteIntentToMcp delete reminder flow", () => {
  beforeEach(() => {
    callConfiguredMcpToolMock.mockReset();
    callGatewayToolMock.mockReset();
    tryLlmReminderFallbackMock.mockReset();
    tryLlmReminderFallbackMock.mockResolvedValue(null);
    resetIntentRouterDedupeForTests();
  });

  it("deletes a matching reminder by explicit name", async () => {
    callGatewayToolMock.mockImplementation(async (method: string, _opts: unknown, params: any) => {
      if (method === "cron.list") {
        expect(params).toMatchObject({ includeDisabled: true, limit: 200, offset: 0 });
        return {
          jobs: [
            {
              id: "job-1",
              name: "买咖啡回魂",
              delivery: { channel: "openclaw-weixin", to: "user-1", accountId: "acct-1" },
              payload: { kind: "agentTurn", message: "提醒你：去买咖啡回魂！" },
            },
          ],
          hasMore: false,
        };
      }
      if (method === "cron.remove") {
        expect(params).toEqual({ id: "job-1" });
        return { removed: true };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    });

    const result = await tryRouteIntentToMcp({
      ctx: {
        ...baseCtx,
        Body: "删除买咖啡回魂这个任务",
        CommandBody: "删除买咖啡回魂这个任务",
        BodyForCommands: "删除买咖啡回魂这个任务",
      },
      cfg,
      agentId: "codex",
      workspaceDir: "/tmp/ws",
    });

    expect(result).toMatchObject({
      handled: true,
      reason: "matched_delete_reminder_intent",
      reply: { text: "已删除提醒：买咖啡回魂" },
    });
    expect(callConfiguredMcpToolMock).not.toHaveBeenCalled();
  });

  it("deletes a matching reminder from replied message context", async () => {
    callGatewayToolMock.mockImplementation(async (method: string, _opts: unknown, params: any) => {
      if (method === "cron.list") {
        return {
          jobs: [
            {
              id: "job-2",
              name: "看一下 雨小了就提醒",
              delivery: { channel: "openclaw-weixin", to: "user-1", accountId: "acct-1" },
              payload: { kind: "agentTurn", message: "提醒你：看一下 雨小了就提醒" },
            },
          ],
          hasMore: false,
        };
      }
      if (method === "cron.remove") {
        expect(params).toEqual({ id: "job-2" });
        return { removed: true };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    });

    const result = await tryRouteIntentToMcp({
      ctx: {
        ...baseCtx,
        Body: "这个任务删掉吧",
        CommandBody: "这个任务删掉吧",
        BodyForCommands: "这个任务删掉吧",
        ReplyToBody: "看一下 雨小了就提醒",
      },
      cfg,
      agentId: "codex",
      workspaceDir: "/tmp/ws",
    });

    expect(result).toMatchObject({
      handled: true,
      reason: "matched_delete_reminder_reply_intent",
      reply: { text: "已删除提醒：看一下 雨小了就提醒" },
    });
  });

  it("asks for a narrower target when multiple reminders match", async () => {
    callGatewayToolMock.mockImplementation(async (method: string) => {
      if (method === "cron.list") {
        return {
          jobs: [
            {
              id: "job-1",
              name: "下班提醒",
              delivery: { channel: "openclaw-weixin", to: "user-1", accountId: "acct-1" },
              payload: { kind: "agentTurn", message: "提醒你：下班提醒" },
            },
            {
              id: "job-2",
              name: "下班提醒-备份",
              delivery: { channel: "openclaw-weixin", to: "user-1", accountId: "acct-1" },
              payload: { kind: "agentTurn", message: "提醒你：下班提醒-备份" },
            },
          ],
          hasMore: false,
        };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    });

    const result = await tryRouteIntentToMcp({
      ctx: {
        ...baseCtx,
        Body: "删除下班提醒任务",
        CommandBody: "删除下班提醒任务",
        BodyForCommands: "删除下班提醒任务",
      },
      cfg,
      agentId: "codex",
      workspaceDir: "/tmp/ws",
    });

    expect(result).toMatchObject({
      handled: true,
      reason: "matched_delete_reminder_intent",
    });
    expect(result.handled && result.reply.text).toContain("我找到了多个可能的提醒");
    expect(callGatewayToolMock).toHaveBeenCalledTimes(1);
  });

  it("deletes a quoted reminder name after normalization", async () => {
    callGatewayToolMock.mockImplementation(async (method: string, _opts: unknown, params: any) => {
      if (method === "cron.list") {
        return {
          jobs: [
            {
              id: "job-quoted",
              name: "“测试任务”",
              delivery: { channel: "openclaw-weixin", to: "user-1", accountId: "acct-1" },
              payload: { kind: "agentTurn", message: "提醒你：“测试任务”" },
            },
          ],
          hasMore: false,
        };
      }
      if (method === "cron.remove") {
        expect(params).toEqual({ id: "job-quoted" });
        return { removed: true };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    });

    const result = await tryRouteIntentToMcp({
      ctx: {
        ...baseCtx,
        Body: "删除 “测试任务”",
        CommandBody: "删除 “测试任务”",
        BodyForCommands: "删除 “测试任务”",
      },
      cfg,
      agentId: "codex",
      workspaceDir: "/tmp/ws",
    });

    expect(result).toMatchObject({
      handled: true,
      reason: "matched_delete_reminder_intent",
      reply: { text: "已删除提醒：“测试任务”" },
    });
    expect(callConfiguredMcpToolMock).not.toHaveBeenCalled();
  });

  it("deletes a quoted reminder request without reminder nouns", async () => {
    callGatewayToolMock.mockImplementation(async (method: string, _opts: unknown, params: any) => {
      if (method === "cron.list") {
        return {
          jobs: [
            {
              id: "job-bathroom",
              name: "去上厕所",
              delivery: { channel: "openclaw-weixin", to: "user-1", accountId: "acct-1" },
              payload: { kind: "agentTurn", message: "提醒你：去上厕所" },
            },
          ],
          hasMore: false,
        };
      }
      if (method === "cron.remove") {
        expect(params).toEqual({ id: "job-bathroom" });
        return { removed: true };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    });

    const result = await tryRouteIntentToMcp({
      ctx: {
        ...baseCtx,
        Body: "取消“去上厕所”",
        CommandBody: "取消“去上厕所”",
        BodyForCommands: "取消“去上厕所”",
      },
      cfg,
      agentId: "codex",
      workspaceDir: "/tmp/ws",
    });

    expect(result).toMatchObject({
      handled: true,
      reason: "matched_delete_reminder_intent",
      reply: { text: "已删除提醒：去上厕所" },
    });
    expect(callConfiguredMcpToolMock).not.toHaveBeenCalled();
  });

  it("returns clarify directly without invoking llm fallback", async () => {
    const result = await tryRouteIntentToMcp({
      ctx: {
        ...baseCtx,
        Body: "删除这个提醒",
        CommandBody: "删除这个提醒",
        BodyForCommands: "删除这个提醒",
      },
      cfg,
      agentId: "codex",
      workspaceDir: "/tmp/ws",
    });

    expect(result).toMatchObject({
      handled: true,
      reason: "delete_reminder_target_missing",
      reply: { text: "你想删掉哪个提醒或任务？" },
    });
    expect(tryLlmReminderFallbackMock).not.toHaveBeenCalled();
    expect(callGatewayToolMock).not.toHaveBeenCalled();
    expect(callConfiguredMcpToolMock).not.toHaveBeenCalled();
  });
});
