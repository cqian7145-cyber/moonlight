import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TableEntryView } from "./table-entry-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe("customer table entry page content", () => {
  it("shows the current activity and delegates participation state to the customer control", () => {
    const html = renderToStaticMarkup(createElement(TableEntryView, {
      entry: { status: "ready", venueName: "月光小馆", activityTitle: "今晚的微醺灵感", questionCount: 3 },
      tableCode: "Abcdefghijklmnopqrstuvwxzy0123456789_-Abcdefghijklmnop",
    }));
    expect(html).toContain("月光小馆");
    expect(html).toContain("今晚的微醺灵感");
    expect(html).toContain("3 个小选择");
    expect(html).toContain("正在确认参与状态");
    expect(html).not.toContain('href="/play/demo"');
    expect(html).toContain("后续版本开放");
    expect(html).toContain("答案会逐题保存");
    expect(html).not.toContain("participantToken");
    expect(html).not.toContain("playGroupId");
  });

  it("renders the same non-sensitive unavailable message for database errors", () => {
    const html = renderToStaticMarkup(createElement(TableEntryView, {
      entry: { status: "unavailable" },
    }));
    expect(html).toContain("现在暂时无法载入");
    expect(html).toContain("当前请求不会创建或保存参与记录");
    expect(html).not.toContain("connection");
  });

  it("allows an existing anonymous session to continue when no publication is active, without offering a new start", () => {
    const html = renderToStaticMarkup(createElement(TableEntryView, {
      entry: { status: "no_activity" },
      tableCode: "Abcdefghijklmnopqrstuvwxzy0123456789_-Abcdefghijklmnop",
    }));
    expect(html).toContain("如果你已有进行中的参与，可以继续完成");
    expect(html).toContain("正在确认参与状态");
    expect(html).not.toContain("自己玩");
  });
});
