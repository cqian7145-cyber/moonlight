import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TableEntryView } from "./table-entry-view";

describe("customer table entry page content", () => {
  it("shows the current activity and clearly labels the personal demo as unsaved", () => {
    const html = renderToStaticMarkup(createElement(TableEntryView, {
      entry: { status: "ready", venueName: "月光小馆", activityTitle: "今晚的微醺灵感", questionCount: 3 },
    }));
    expect(html).toContain("月光小馆");
    expect(html).toContain("今晚的微醺灵感");
    expect(html).toContain("3 个小选择");
    expect(html).toContain('href="/play/demo"');
    expect(html).toContain("演示，不会保存记录。");
    expect(html).toContain("后续版本开放");
    expect(html).toContain("不会创建或保存参与记录");
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
});
