"use client";

import Link from "next/link";
import Image from "next/image";
import QRCode from "qrcode";
import { useState } from "react";

type Table = { id: string; name: string; isEnabled: boolean; createdAt: string };
type OneTimeCode = { table: Table; tableCode: string; printUrl: string; qr: string };

export function TableControls({ venueId, initialTables, owner }: { venueId: string; initialTables: Table[]; owner: boolean }) {
  const [tables, setTables] = useState(initialTables);
  const [tableName, setTableName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [oneTimeCode, setOneTimeCode] = useState<OneTimeCode | null>(null);

  async function createTable() {
    setBusy(true); setMessage(""); setOneTimeCode(null);
    try {
      const response = await fetch(`/api/merchant/venues/${venueId}/tables`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: tableName }) });
      const body = await response.json();
      if (!response.ok) throw new Error("桌位创建失败，请检查桌号后重试。");
      const qr = await QRCode.toDataURL(body.printUrl, { errorCorrectionLevel: "M", margin: 3, width: 360 });
      setTables((items) => [...items, body.table].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")));
      setTableName("");
      setOneTimeCode({ ...body, qr });
      setMessage("桌码已生成。明文只显示这一次，请立即下载或打印；刷新后不能再次查看。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "桌位创建失败，请重试。"); }
    finally { setBusy(false); }
  }

  async function setEnabled(table: Table, enabled: boolean) {
    setBusy(true); setMessage(""); setOneTimeCode(null);
    try {
      const response = await fetch(`/api/merchant/venues/${venueId}/tables/${table.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
      const body = await response.json();
      if (!response.ok) throw new Error("桌位状态更新失败，请刷新后重试。");
      setTables((items) => items.map((item) => item.id === table.id ? { ...item, isEnabled: body.table.isEnabled } : item));
    } catch (error) { setMessage(error instanceof Error ? error.message : "桌位状态更新失败。"); }
    finally { setBusy(false); }
  }

  async function rotate(table: Table) {
    if (!window.confirm(`确认轮换“${table.name}”的二维码？旧二维码会立刻失效，现有进行中的参与可继续使用原题包。`)) return;
    setBusy(true); setMessage(""); setOneTimeCode(null);
    try {
      const response = await fetch(`/api/merchant/venues/${venueId}/tables/${table.id}/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
      const body = await response.json();
      if (!response.ok) throw new Error("二维码轮换失败，请重试。");
      const qr = await QRCode.toDataURL(body.printUrl, { errorCorrectionLevel: "M", margin: 3, width: 360 });
      setOneTimeCode({ ...body, qr });
      setMessage("新二维码只显示这一次，请立即下载或打印。旧码已失效。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "二维码轮换失败。"); }
    finally { setBusy(false); }
  }

  return (
    <section className="merchantManageSection" aria-labelledby="table-management-title">
      <div className="merchantSectionHeading"><div><p className="demoKicker">桌位</p><h2 id="table-management-title">桌码管理</h2></div><Link className="merchantInlineLink" href={`/staff?venueId=${venueId}`}>返回工作台</Link></div>
      <p className="merchantFormHint">数据库只保存桌码哈希。已有二维码不回显；遗失时需经确认轮换，旧二维码随即失效。</p>
      {owner && <div className="merchantCreateTable"><label className="merchantField">桌号或展示名<input maxLength={80} value={tableName} onChange={(event) => setTableName(event.target.value)} /></label><button className="merchantActionButton" type="button" disabled={busy || !tableName.trim()} onClick={createTable}>创建桌位并生成二维码</button></div>}
      {message && <p className="merchantStatusMessage" role="status">{message}</p>}
      {oneTimeCode && <div className="merchantQrPrint" aria-label="一次性桌码打印预览"><h3>{oneTimeCode.table.name} · Moonlight</h3><Image src={oneTimeCode.qr} width={360} height={360} alt="一次性桌位二维码" unoptimized /><p>扫描进入本桌当前活动</p><a href={oneTimeCode.printUrl}>{oneTimeCode.printUrl}</a><div className="merchantQrActions"><button type="button" className="merchantActionButton" onClick={() => window.print()}>打印二维码</button><a className="merchantInlineLink" href={oneTimeCode.qr} download={`${oneTimeCode.table.name.replace(/[^\p{L}\p{N}_-]/gu, "_")}-moonlight-qr.png`}>下载二维码图片</a><button className="merchantTextButton" type="button" onClick={() => setOneTimeCode(null)}>我已保存</button></div></div>}
      <ul className="merchantManageList merchantTableList">
        {tables.map((table) => <li key={table.id}><div><strong>{table.name}</strong><p>{table.isEnabled ? "已启用" : "已停用"} · 桌码不会在此页显示</p></div><div className="merchantActionRow">
          {owner && <><button type="button" className="merchantTextButton" disabled={busy} onClick={() => setEnabled(table, !table.isEnabled)}>{table.isEnabled ? "停用" : "启用"}</button><button type="button" className="merchantTextButton" disabled={busy} onClick={() => rotate(table)}>确认轮换二维码</button></>}
        </div></li>)}
      </ul>
    </section>
  );
}
