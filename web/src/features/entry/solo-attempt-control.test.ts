import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SoloAttemptView, type AttemptViewState } from "./solo-attempt-control";

const saved: AttemptViewState = {
  kind: "saved",
  data: {
    status: "created",
    attempt: { status: "in_progress", startedAt: "2026-10-26T12:00:00.000Z", completedAt: null, answeredCount: 0 },
    activity: { title: "今晚的微醺灵感", questionCount: 3 },
  },
};

describe("solo attempt customer handoff", () => {
  it("shows an explicit start action and states that starting will save anonymous participation", () => {
    const html = renderToStaticMarkup(createElement(SoloAttemptView, {
      state: { kind: "idle" }, tableCode: "table-code-test", onStart: vi.fn(),
    }));
    expect(html).toContain("自己玩");
    expect(html).toContain("点击后会保存一条匿名参与记录");
    expect(html).not.toContain("href=\"/play/demo\"");
  });

  it("offers a link to the real personal flow for the saved attempt", () => {
    const html = renderToStaticMarkup(createElement(SoloAttemptView, { state: saved, tableCode: "table-code-test", onStart: vi.fn() }));
    expect(html).toContain("参与已保存");
    expect(html).toContain("今晚的微醺灵感");
    expect(html).toContain("/play/table-code-test");
    expect(html).toContain("继续答题");
    expect(html).not.toContain("href=\"/play/demo\"");
  });

  it("exposes start errors as an accessible alert", () => {
    const html = renderToStaticMarkup(createElement(SoloAttemptView, {
      state: { kind: "error", message: "服务暂时不可用" }, tableCode: "table-code-test", onStart: vi.fn(),
    }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("服务暂时不可用");
  });
});
