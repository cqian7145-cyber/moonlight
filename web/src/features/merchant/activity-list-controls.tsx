"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

type TemplateSummary = { id: string; title: string; status: "draft" | "archived"; updatedAt: string; versions: { id: string; versionNo: number; title: string; active: boolean }[] };

const starterDraft = {
  title: "今晚的轻松选择",
  cues: [
    { prompt: "今晚想从什么开始？", choices: ["慢慢聊", "听点音乐", "尝个新口味"] },
    { prompt: "更喜欢哪种小惊喜？", choices: ["一段故事", "一首歌", "一道小食"] },
    { prompt: "给今晚留一点什么？", choices: ["放松", "灵感", "笑声"] },
  ],
};

export function ActivityListControls({ venueId, templates }: { venueId: string; templates: TemplateSummary[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function createDraft() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/merchant/venues/${venueId}/activities`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(starterDraft),
      });
      const result = await response.json();
      if (!response.ok || typeof result.template?.id !== "string") throw new Error("无法创建草稿，请刷新后重试。");
      router.push(`/admin/venues/${venueId}/activities/${result.template.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法创建草稿，请刷新后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="merchantManageSection" aria-labelledby="activity-list-title">
      <div className="merchantSectionHeading">
        <div><p className="demoKicker">题包</p><h2 id="activity-list-title">草稿与发布版本</h2></div>
        <button className="merchantActionButton" type="button" disabled={busy} onClick={createDraft}>新建三题草稿</button>
      </div>
      {message && <p className="merchantFormMessage" role="alert">{message}</p>}
      {templates.length === 0 ? <p className="merchantEmptyState">还没有题包草稿。创建草稿后可随时继续编辑。</p> : (
        <ul className="merchantManageList">
          {templates.map((template) => (
            <li key={template.id}>
              <div>
                <strong>{template.title}</strong>
                <p>{template.status === "archived" ? "已归档" : "草稿"} · {template.versions.length} 个已发布版本</p>
                {template.versions.map((version) => <span className="merchantVersionChip" key={version.id}>v{version.versionNo}{version.active ? " · 当前上架" : ""}</span>)}
              </div>
              <Link className="merchantInlineLink" href={`/admin/venues/${venueId}/activities/${template.id}`}>编辑草稿</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
