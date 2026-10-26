"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Preview = { venueName: string; activityTitle: string; expiresAt: string };
type View = { kind: "loading" } | { kind: "ready"; preview: Preview } | { kind: "error"; message: string };

export function JoinInvitation() {
  const router = useRouter();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [invitationToken, setInvitationToken] = useState("");
  const [consent, setConsent] = useState(false);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    const match = window.location.hash.match(/^#invite=([A-Za-z0-9_-]{43})$/);
    const token = match?.[1];
    window.history.replaceState(null, "", window.location.pathname);
    Promise.resolve().then(() => {
      if (!token) { setView({ kind: "error", message: "邀请链接无效或缺少邀请凭证，请朋友重新分享。" }); return null; }
      setInvitationToken(token);
      return fetch("/api/play-groups/invitation", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ invitationToken: token }),
      });
    }).then(async (response) => {
      if (!response) return;
      if (!response.ok) throw new Error(response.status === 410 ? "邀请已过期，请房主重新创建。" : "无法读取邀请信息，请朋友确认链接仍有效。");
      setView({ kind: "ready", preview: await response.json() as Preview });
    }).catch((error: unknown) => setView({ kind: "error", message: error instanceof Error ? error.message : "邀请暂时不可用。" }));
  }, []);

  async function join() {
    if (!consent || joining || !invitationToken || view.kind !== "ready") return;
    setJoining(true);
    try {
      const response = await fetch("/api/play-groups/join", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ invitationToken, consent: true }),
      });
      if (!response.ok) {
        let error = "";
        try { error = (await response.json() as { error?: string }).error ?? ""; } catch { /* generic failure */ }
        if (response.status === 409 && error === "group_full") throw new Error("房间已满，只能有两位参与者。");
        if (response.status === 409 && error === "group_session_in_use") throw new Error("本设备已有另一间双人参与，请先回到原房间完成或退出。");
        if (response.status === 410) throw new Error("邀请已过期，请房主重新创建。");
        if (response.status === 503) throw new Error("服务暂时不可用，加入结果未确认，请检查连接后重试。");
        throw new Error("加入失败，邀请可能已被使用或房间已关闭。");
      }
      setInvitationToken("");
      router.push("/play/together");
    } catch (error) {
      setView({ kind: "error", message: error instanceof Error ? error.message : "暂时无法加入房间。" });
      setJoining(false);
    }
  }

  return <main className="soloPlayShell"><header className="soloPlayHeader"><Link className="demoBrand" href="/">moonlight<span>.</span></Link><Link className="backLink" href="/">返回首页</Link></header>
    <section className="soloPlayMessage duoIntro"><p className="demoKicker">MOONLIGHT · 邀请加入</p>
      {view.kind === "loading" && <><h1>正在确认邀请</h1><p role="status">邀请凭证只在本页短暂使用，不会写入浏览器存储。</p></>}
      {view.kind === "error" && <><h1>暂时无法加入</h1><p role="alert">{view.message}</p><Link className="button buttonQuiet" href="/">回到首页</Link></>}
      {view.kind === "ready" && <><h1>和朋友一起完成三个小选择</h1><p>门店：<strong>{view.preview.venueName}</strong></p><p>玩法：<strong>{view.preview.activityTitle}</strong></p>
        <p>加入后，你和朋友会各自获得独立的匿名会话。只有双方都完成后，彼此才会看到选择。邀请链接可被转发，也不能证明你们在同一张桌边。</p>
        <label className="duoConsent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />我自愿加入，并同意双方完成后互相展示答案。</label>
        <button className="button buttonPrimary" type="button" disabled={!consent || joining} onClick={() => void join()}>{joining ? "正在加入…" : "同意并加入"}</button>
      </>}
    </section>
  </main>;
}
