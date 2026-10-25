"use client";

import { useEffect, useRef, useState } from "react";

type AttemptResponse = {
  status: "created" | "resumed" | "current";
  attempt: { status: "in_progress" | "completed" | "abandoned"; startedAt: string; completedAt: string | null; answeredCount: number };
  activity: { title: string; questionCount: number };
};

export type AttemptViewState = { kind: "idle" | "loading" }
  | { kind: "saved"; data: AttemptResponse }
  | { kind: "error"; message: string };

const START_LOCK_NAME = "moonlight-solo-start";

async function requestCurrent(tableCode: string): Promise<AttemptResponse | null> {
  const response = await fetch(`/api/attempts/current?tableCode=${encodeURIComponent(tableCode)}`, {
    method: "GET", credentials: "same-origin", cache: "no-store",
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(response.status === 503 ? "暂时无法连接服务，请稍后重试。" : "当前参与状态暂时无法读取。" );
  return await response.json() as AttemptResponse;
}

export function SoloAttemptView({ state, onStart }: { state: AttemptViewState; onStart: () => void }) {
  if (state.kind === "loading") {
    return <div className="entryStartStatus" role="status" aria-live="polite">正在确认参与状态…</div>;
  }

  if (state.kind === "saved") {
    const { attempt, activity } = state.data;
    const message = attempt.status === "in_progress"
      ? "参与已保存"
      : attempt.status === "completed" ? "本次参与已完成" : "这次参与已结束";
    return (
      <section className="entrySaved" aria-live="polite">
        <p className="entrySavedLabel">{message}</p>
        <p className="entrySavedTitle">{activity.title}</p>
        <p className="entryStartNote">正式答题将在 M-008 接入；目前还没有提交答案。</p>
      </section>
    );
  }

  return (
    <div className="entryStartGroup">
      <button className="entryPrimaryButton" type="button" onClick={onStart}>
        自己玩
      </button>
      {state.kind === "error"
        ? <p className="entryStartError" role="alert">{state.message}</p>
        : <p className="entryStartNote">点击后会保存一条匿名参与记录，可在本设备恢复。</p>}
    </div>
  );
}

export function SoloAttemptControl({ tableCode }: { tableCode: string }) {
  const [state, setState] = useState<AttemptViewState>({ kind: "loading" });
  const inFlight = useRef(false);

  useEffect(() => {
    let active = true;
    requestCurrent(tableCode).then((current) => {
      if (active) setState(current ? { kind: "saved", data: current } : { kind: "idle" });
    }).catch(() => {
      if (active) setState({ kind: "error", message: "暂时无法读取参与状态，请稍后重试。" });
    });
    return () => { active = false; };
  }, [tableCode]);

  async function createOrRestore() {
    if (inFlight.current || state.kind === "loading") return;
    inFlight.current = true;
    setState({ kind: "loading" });

    const startLocked = async () => {
      const current = await requestCurrent(tableCode);
      if (current) return current;
      const response = await fetch("/api/attempts/start", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tableCode }),
      });
      if (!response.ok) {
        if (response.status === 503) throw new Error("服务暂时不可用，请稍后重试。没有创建参与记录。");
        if (response.status === 409) throw new Error("门店当前玩法已暂停或下架，请稍后再来。");
        if (response.status === 401) throw new Error("无法恢复当前参与，请重新点击开始。");
        if (response.status === 403) throw new Error("请求未能通过同源安全检查，请刷新页面后重试。");
        throw new Error("暂时无法开始，请检查桌码后重试。");
      }
      return await response.json() as AttemptResponse;
    };

    try {
      if (!("locks" in navigator)) {
        throw new Error("当前浏览器不支持跨标签防重复，请使用较新的浏览器后重试。");
      }
      const result = await navigator.locks.request(START_LOCK_NAME, startLocked);
      setState({ kind: "saved", data: result });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "暂时无法开始，请稍后重试。" });
    } finally {
      inFlight.current = false;
    }
  }

  return <SoloAttemptView state={state} onStart={createOrRestore} />;
}
