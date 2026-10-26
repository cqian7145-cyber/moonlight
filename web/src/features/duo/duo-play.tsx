"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { FeedbackControl } from "@/features/feedback/feedback-control";

type RoomState = {
  status: "waiting" | "ready" | "completed";
  ownStatus: "in_progress" | "completed";
  ownAnsweredCount: number;
  otherJoined: boolean;
  otherCompleted: boolean;
  expiresAt: string;
};
type Question = { cueKey: string; prompt: string; choices: string[] };
type Questions = {
  status: "in_progress" | "completed";
  attempt: { status: "in_progress" | "completed"; answeredCount: number };
  activity: { title: string };
  questions: Question[];
  submissions: { cueKey: string; optionIndex: number; createdAt: string }[];
};
type DuoResult = { matchedCount: number; total: number; message: string; questions: { cueKey: string; matched: boolean; yourOptionIndex: number; friendOptionIndex: number }[] };
type View =
  | { kind: "loading" }
  | { kind: "consent" }
  | { kind: "room"; state: RoomState; questions: Questions; selectedIndex: number | null; submitting: boolean; message?: string }
  | { kind: "waiting"; state: RoomState; activityTitle: string }
  | { kind: "result"; state: RoomState; result: DuoResult; questions: Questions }
  | { kind: "error"; message: string };

const roomLock = "moonlight-duo-create";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  if (!response.ok) {
    let code = "";
    try { code = (await response.json() as { error?: string }).error ?? ""; } catch { /* use generic copy */ }
    if (response.status === 503) throw new Error("服务暂时不可用，未确认的操作没有显示为成功。请稍后重试。");
    if (response.status === 401) throw new Error("没有找到本设备的双人参与会话，请从桌码入口重新开始或打开有效邀请。");
    if (response.status === 404 || code === "invitation_unavailable") throw new Error("邀请链接无效或已失效，请朋友重新创建邀请。");
    if (response.status === 410) throw new Error("这条邀请已过期，请房主重新创建房间。");
    if (code === "group_full") throw new Error("房间已满，邀请只允许一位朋友加入。");
    if (code === "group_session_in_use") throw new Error("本设备已有另一间双人参与，请先回到那间房间完成或退出。");
    if (code === "result_not_ready") throw new Error("双方都完成三道题后才会共同揭晓。");
    if (code === "same_origin_required") throw new Error("请求未通过来源安全检查，请刷新页面后重试。");
    if (code === "activity_unavailable") throw new Error("门店互动已暂停，当前房间无法继续读取。");
    if (code === "answer_conflict") throw new Error("这道题已经保存过不同答案，不能覆盖原选择。");
    if (code === "group_closed" || code === "attempt_closed") throw new Error("这间房间已结束或过期，请回到桌码入口选择其他玩法。");
    throw new Error("暂时无法读取双人参与，请检查网络后重试。");
  }
  return response.json() as Promise<T>;
}

async function readRoom() {
  return api<RoomState>("/api/play-groups/current");
}

async function readQuestions() {
  return api<Questions>("/api/play-groups/questions");
}

async function readResult() {
  const payload = await api<{ status: "completed"; result: DuoResult }>("/api/play-groups/result");
  return payload.result;
}

function safeInviteFromHash(): string | null {
  const match = window.location.hash.match(/^#invite=([A-Za-z0-9_-]{43})$/);
  return match?.[1] ?? null;
}

export function DuoPlay({ tableCode }: { tableCode?: string }) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [inviteUrl, setInviteUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [consent, setConsent] = useState(false);
  const [minutesRemaining, setMinutesRemaining] = useState(15);
  const inFlight = useRef(false);
  const isRoomActive = view.kind === "room" || view.kind === "waiting";
  const activeExpiry = view.kind === "room" || view.kind === "waiting" ? view.state.expiresAt : null;

  const sync = useCallback(async (showLoading = false) => {
    if (showLoading) setView({ kind: "loading" });
    try {
      const state = await readRoom();
      setMinutesRemaining(Math.max(0, Math.ceil((new Date(state.expiresAt).getTime() - Date.now()) / 60_000)));
      if (state.status === "completed") {
        const questions = await readQuestions();
        const result = await readResult();
        setView({ kind: "result", state, result, questions });
        return;
      }
      const questions = await readQuestions();
      if (state.ownStatus === "completed") {
        setView({ kind: "waiting", state, activityTitle: questions.activity.title });
        return;
      }
      setView((current) => ({
        kind: "room", state, questions,
        selectedIndex: current.kind === "room" ? current.selectedIndex : null,
        submitting: false,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "暂时无法恢复双人参与。";
      if (message.includes("没有找到本设备") || message.includes("房间已结束或过期")) {
        setView(tableCode ? { kind: "consent" } : { kind: "error", message });
      } else {
        setView({ kind: "error", message });
      }
    }
  }, [tableCode]);

  useEffect(() => {
    const token = safeInviteFromHash();
    Promise.resolve().then(() => {
      if (token) setInviteUrl(`${window.location.origin}/join#invite=${token}`);
      return sync(true);
    });
  }, [sync]);

  useEffect(() => {
    if (!isRoomActive) return;
    const timer = window.setInterval(async () => {
      try {
        const state = await readRoom();
        setMinutesRemaining(Math.max(0, Math.ceil((new Date(state.expiresAt).getTime() - Date.now()) / 60_000)));
        if (state.status === "completed") {
          const [result, questions] = await Promise.all([readResult(), readQuestions()]);
          setView({ kind: "result", state, result, questions });
          return;
        }
        setView((current) => {
          if (current.kind === "waiting") return { ...current, state };
          if (current.kind === "room") return { ...current, state };
          return current;
        });
      } catch { /* transient polling failures do not discard the participant's saved answers */ }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [isRoomActive]);

  useEffect(() => {
    if (!activeExpiry) return;
    const countdown = window.setInterval(() => {
      setMinutesRemaining(Math.max(0, Math.ceil((new Date(activeExpiry).getTime() - Date.now()) / 60_000)));
    }, 10_000);
    return () => window.clearInterval(countdown);
  }, [activeExpiry]);

  async function createRoom() {
    if (!tableCode || !consent || inFlight.current) return;
    inFlight.current = true;
    setView({ kind: "loading" });
    try {
      const start = async () => {
        const current = await fetch("/api/play-groups/current", { credentials: "same-origin", cache: "no-store" });
        if (current.ok) return { resumed: true as const, room: await current.json() as RoomState };
        if (current.status !== 401) throw new Error("当前双人参与状态暂时无法读取。");
        const created = await api<{ status: string; invitationToken: string; expiresAt: string }>("/api/play-groups", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tableCode, consent: true }),
        });
        return { resumed: false as const, invitationToken: created.invitationToken };
      };
      const result = "locks" in navigator ? await navigator.locks.request(roomLock, start) : await start();
      if (result.resumed) {
        await sync(true);
      } else {
        const token = result.invitationToken;
        setMinutesRemaining(15);
        window.history.replaceState(null, "", `${window.location.pathname}#invite=${token}`);
        setInviteUrl(`${window.location.origin}/join#invite=${token}`);
        await sync(true);
      }
    } catch (error) {
      setView({ kind: "error", message: error instanceof Error ? error.message : "房间暂时无法创建。" });
    } finally {
      inFlight.current = false;
    }
  }

  async function submitAnswer() {
    if (view.kind !== "room" || view.selectedIndex === null || view.submitting) return;
    const question = view.questions.questions.find((item) => !view.questions.submissions.some((saved) => saved.cueKey === item.cueKey));
    if (!question) return;
    const current = view;
    setView({ ...current, submitting: true, message: undefined });
    try {
      await api("/api/play-groups/answer", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ cueKey: question.cueKey, optionIndex: current.selectedIndex }),
      });
      await sync(true);
    } catch (error) {
      setView({ ...current, submitting: false, message: error instanceof Error ? error.message : "答案暂未确认保存，请重试。" });
    }
  }

  async function leave() {
    try {
      await api("/api/play-groups/leave", { method: "POST" });
      setInviteUrl("");
      setView({ kind: "error", message: "你已退出这间双人房间。可以回到桌码入口选择个人模式。" });
    } catch (error) {
      setView({ kind: "error", message: error instanceof Error ? error.message : "暂时无法退出，请稍后重试。" });
    }
  }

  async function copyInvite() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  if (view.kind === "loading") return <main className="soloPlayShell"><section className="soloPlayMessage" role="status"><p className="demoKicker">MOONLIGHT · 双人默契</p><h1>正在恢复房间</h1><p>从本设备的 HttpOnly 会话读取进度。</p></section></main>;

  if (view.kind === "consent") return <main className="soloPlayShell">
    <header className="soloPlayHeader"><Link className="demoBrand" href="/">moonlight<span>.</span></Link><Link className="backLink" href={tableCode ? `/t/${encodeURIComponent(tableCode)}` : "/"}>返回</Link></header>
    <section className="soloPlayMessage duoIntro"><p className="demoKicker">MOONLIGHT · 双人默契</p><h1>邀请一位朋友，一起完成三个小选择</h1>
      <p>只有双方都主动加入并完成后，彼此的选择才会揭晓。邀请链接可被转发，不能证明你们在同一张桌边。</p>
      <label className="duoConsent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />我同意创建仅限两人的临时房间，并在双方完成后向彼此展示答案。</label>
      <button className="button buttonPrimary" type="button" disabled={!consent} onClick={() => void createRoom()}>同意并创建房间</button>
    </section>
  </main>;

  if (view.kind === "error") return <main className="soloPlayShell"><section className="soloPlayMessage"><p className="demoKicker">MOONLIGHT · 双人默契</p><h1>暂时无法继续</h1><p role="alert">{view.message}</p>
    <div className="resultActions"><button className="button buttonPrimary" type="button" onClick={() => void sync(true)}>重新读取</button><Link className="button buttonQuiet" href={tableCode ? `/t/${encodeURIComponent(tableCode)}` : "/"}>回到入口</Link></div>
  </section></main>;

  if (view.kind === "result") return <main className="soloPlayShell"><header className="soloPlayHeader"><Link className="demoBrand" href="/">moonlight<span>.</span></Link><span className="backLink">共同揭晓</span></header>
    <article className="resultCard soloResultCard duoResultCard"><p className="resultLabel">双人共同结果</p><h1>{view.result.matchedCount} / {view.result.total} 道选择相同</h1><p className="resultDescription">{view.result.message}</p>
      <div className="duoComparisons">{view.result.questions.map((question, index) => <section className="duoCompareRow" key={question.cueKey}><div><span>第 {index + 1} 题</span><strong>{question.matched ? "相同" : "不同"}</strong></div><p>你：{view.questions.questions[index]?.choices[question.yourOptionIndex] ?? `选项 ${question.yourOptionIndex + 1}`}<br />朋友：{view.questions.questions[index]?.choices[question.friendOptionIndex] ?? `选项 ${question.friendOptionIndex + 1}`}</p></section>)}</div>
      <div className="suggestionBox"><span>可以从这里聊起</span><p>{view.result.message}</p></div><p className="resultDisclaimer">这是基于本次选择的轻松互动，不是人格测量或关系诊断。</p>
      <FeedbackControl duo />
      <div className="resultActions"><button className="button buttonQuiet" type="button" onClick={() => void leave()}>结束并退出房间</button><Link className="button buttonPrimary" href={tableCode ? `/t/${encodeURIComponent(tableCode)}` : "/"}>回到入口</Link></div>
    </article></main>;

  if (view.kind === "waiting") return <main className="soloPlayShell"><header className="soloPlayHeader"><Link className="demoBrand" href="/">moonlight<span>.</span></Link><span className="backLink">{view.state.otherCompleted ? "正在揭晓" : "等待朋友完成"}</span></header>
    <section className="soloPlayMessage"><p className="demoKicker">{view.activityTitle}</p><h1>{view.state.otherCompleted ? "朋友已完成" : "你的三道题已保存"}</h1><p role="status">{view.state.otherCompleted ? "正在读取共同结果…" : "在朋友完成前，双方的具体选择都会保持隐藏。你可以稍后刷新继续等待。"}</p><button className="button buttonPrimary" type="button" onClick={() => void sync(true)}>刷新状态</button></section>
    <div className="resultActions"><button className="button buttonQuiet" type="button" onClick={() => void leave()}>退出房间</button><Link className="button buttonQuiet" href={tableCode ? `/t/${encodeURIComponent(tableCode)}` : "/"}>个人模式入口</Link></div>
  </main>;

  const answered = view.questions.submissions.length;
  const currentQuestion = view.questions.questions.find((item) => !view.questions.submissions.some((saved) => saved.cueKey === item.cueKey));
  if (!currentQuestion) return <main className="soloPlayShell"><section className="soloPlayMessage"><p role="alert">进度暂时不完整，请重新读取服务端状态。</p><button className="button buttonPrimary" type="button" onClick={() => void sync(true)}>重新读取</button></section></main>;
  return <main className="soloPlayShell"><header className="soloPlayHeader"><Link className="demoBrand" href="/">moonlight<span>.</span></Link><button className="backLink duoTextButton" type="button" onClick={() => void leave()}>退出房间</button></header>
    <section className="demoIntro soloIntro"><p className="demoKicker">{view.questions.activity.title} · 双人默契</p><h1>{view.state.otherJoined ? "你们各自完成三个小选择" : "房间已创建，等待朋友加入"}</h1><p>每个人的选择独立保存。双方完成前，不会显示朋友的答案。</p></section>
    {tableCode && inviteUrl && <section className="duoInviteCard"><div><strong>邀请一位朋友</strong><p>链接仅用于申请加入，约 {minutesRemaining} 分钟后失效。加入后，房间最多两人。</p></div><div className="duoInviteAction"><input aria-label="邀请链接" readOnly value={inviteUrl} onFocus={(event) => event.currentTarget.select()} /><button className="button buttonPrimary" type="button" onClick={() => void copyInvite()}>{copied ? "已复制" : "复制邀请"}</button></div></section>}
    <article className="questionCard"><div className="progressHead"><span>个人进度 · 朋友 {view.state.otherCompleted ? "已完成" : view.state.otherJoined ? "已加入" : "未加入"}</span><strong>第 {answered + 1} / 3 题</strong></div>
      <div className="progressTrack" role="progressbar" aria-label="个人答题进度" aria-valuemin={0} aria-valuemax={3} aria-valuenow={answered}><div className="progressValue" style={{ width: `${answered / 3 * 100}%` }} /></div>
      <form className="questionForm" onSubmit={(event) => { event.preventDefault(); void submitAnswer(); }}><fieldset disabled={view.submitting}><legend>{currentQuestion.prompt}</legend><div className="choiceList">{currentQuestion.choices.map((choice, index) => <label className="choiceOption" key={`${currentQuestion.cueKey}-${index}`}><input type="radio" name="duo-answer" value={index} checked={view.selectedIndex === index} onChange={() => setView({ ...view, selectedIndex: index, message: undefined })} /><span className="choiceMark" aria-hidden="true" /><span className="choiceText">{choice}</span></label>)}</div></fieldset>
        <div className="questionActions"><p className="selectionHint" aria-live="polite">{view.message ?? (view.submitting ? "正在保存你的选择…" : "选择提交后不能更改。")}</p><button className="continueButton" type="submit" disabled={view.selectedIndex === null || view.submitting}>{view.submitting ? "正在保存…" : answered === 2 ? "完成并等待揭晓" : "保存并继续"}</button></div>
        {view.message && <p className="soloAnswerError" role="alert">{view.message}</p>}</form><p className="demoPrivacy">答案只在双方完成后向彼此展示。</p></article>
  </main>;
}
