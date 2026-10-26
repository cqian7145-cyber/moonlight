"use client";

import Link from "next/link";
import { useState } from "react";

type Template = { id: string; title: string; draftContent: { cues: readonly { key: string; prompt: string; choices: readonly string[] }[] } | null };
type Publication = { id: string; status: "active" | "inactive"; versionNo: number; title: string; activatedAt: string; deactivatedAt: string | null };

export function PublicationControls({ venueId, templates, initialCurrentId, publications }: {
  venueId: string; templates: Template[]; initialCurrentId: string | null; publications: Publication[];
}) {
  const [currentId, setCurrentId] = useState(initialCurrentId);
  const [selectedTemplate, setSelectedTemplate] = useState(templates.find((template) => template.draftContent)?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState(publications);

  async function publish() {
    if (!selectedTemplate) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/merchant/venues/${venueId}/activities/${selectedTemplate}/publish`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedCurrentPublicationId: currentId }),
      });
      const body = await response.json();
      if (response.status === 409) throw new Error("当前活动已被其他操作更改。请刷新页面后确认再发布。");
      if (!response.ok) throw new Error("发布失败。请确认题包草稿完整，并刷新后重试。");
      const row = { id: body.publication.id, status: "active" as const, versionNo: body.versionNo, title: templates.find((item) => item.id === selectedTemplate)?.title ?? "新活动", activatedAt: body.publication.activatedAt, deactivatedAt: null };
      setHistory((items) => [{ ...row, id: row.id }, ...items.map((item) => item.status === "active" ? { ...item, status: "inactive" as const, deactivatedAt: row.activatedAt } : item)]);
      setCurrentId(row.id);
      setMessage(`已发布 v${row.versionNo}。新参与会使用此版本，已开始的参与保留原版本。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "发布失败，请重试。"); }
    finally { setBusy(false); }
  }

  async function unpublish() {
    if (!currentId || !window.confirm("确认下架当前活动？已开始的顾客仍可按原题包继续；普通下架不会紧急撤回正在进行的题目。")) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/merchant/venues/${venueId}/publication`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedCurrentPublicationId: currentId }),
      });
      const body = await response.json();
      if (response.status === 409) throw new Error("当前活动已改变。请刷新后再试。");
      if (!response.ok) throw new Error("下架失败，请重试。");
      setHistory((items) => items.map((item) => item.id === currentId ? { ...item, status: "inactive", deactivatedAt: new Date().toISOString() } : item));
      setCurrentId(null);
      setMessage(body.notice);
    } catch (error) { setMessage(error instanceof Error ? error.message : "下架失败，请重试。"); }
    finally { setBusy(false); }
  }

  const current = history.find((item) => item.id === currentId);
  return (
    <section className="merchantManageSection" aria-labelledby="publication-controls-title">
      <div className="merchantSectionHeading"><div><p className="demoKicker">当前活动</p><h2 id="publication-controls-title">发布与下架</h2></div><Link className="merchantInlineLink" href={`/admin/venues/${venueId}/activities`}>管理题包</Link></div>
      <div className="merchantCurrentPublication">
        <strong>{current ? `${current.title} · v${current.versionNo} 正在上架` : "当前没有上架活动"}</strong>
        <p>切换会在同一数据库事务中停用旧版本并发布新版本。已开始的参与仍绑定原题包；普通下架不保证立即撤回进行中的题目。</p>
      </div>
      <label className="merchantField">选择可发布的草稿
        <select value={selectedTemplate} onChange={(event) => setSelectedTemplate(event.target.value)}>
          <option value="">请选择题包</option>
          {templates.filter((template) => template.draftContent?.cues.length === 3).map((template) => <option key={template.id} value={template.id}>{template.title}</option>)}
        </select>
      </label>
      <div className="merchantActionRow">
        <button className="merchantActionButton" type="button" disabled={busy || !selectedTemplate} onClick={publish}>{busy ? "处理中…" : current ? "发布新版本并替换" : "上架当前草稿"}</button>
        {current && <button className="merchantActionButton merchantSecondaryButton" type="button" disabled={busy} onClick={unpublish}>下架当前活动</button>}
      </div>
      {message && <p className="merchantStatusMessage" role="status">{message}</p>}
      <h3>发布历史</h3>
      {history.length === 0 ? <p className="merchantEmptyState">尚无已发布版本。</p> : <ul className="merchantManageList">{history.map((item) => (
        <li key={item.id}><div><strong>{item.title} · v{item.versionNo}</strong><p>{item.status === "active" ? "当前上架" : "已下架"}</p></div></li>
      ))}</ul>}
    </section>
  );
}
