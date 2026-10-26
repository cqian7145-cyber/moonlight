"use client";

import { useEffect, useState } from "react";

type State = { kind: "loading" } | { kind: "ready"; rating: number | null } | { kind: "saving"; rating: number } | { kind: "saved"; rating: number } | { kind: "error"; message: string; rating: number | null };

export function FeedbackControl({ duo = false }: { duo?: boolean }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const endpoint = duo ? "/api/play-groups/feedback" : "/api/attempts/feedback";
  useEffect(() => {
    let active = true;
    fetch(endpoint, { credentials: "same-origin", cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("暂时无法读取反馈状态。");
      const value = await response.json() as { rating: number | null };
      if (active) setState({ kind: "ready", rating: value.rating });
    }).catch(() => { if (active) setState({ kind: "error", message: "反馈暂时不可用，不影响查看本次结果。", rating: null }); });
    return () => { active = false; };
  }, [endpoint]);

  async function submit(rating: number) {
    if (state.kind === "saving" || state.kind === "saved") return;
    setState({ kind: "saving", rating });
    try {
      const response = await fetch(endpoint, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ rating }) });
      if (response.status === 409) throw new Error("已有不同评分，当前版本不会覆盖它。");
      if (!response.ok) throw new Error("提交失败，可以稍后重试。");
      const value = await response.json() as { rating: number };
      setState({ kind: "saved", rating: value.rating });
    } catch (error) { setState({ kind: "error", message: error instanceof Error ? error.message : "提交失败，可以稍后重试。", rating: null }); }
  }

  return <section className="feedbackCard" aria-labelledby="feedback-title"><h2 id="feedback-title">愿意为这次体验打个分吗？</h2><p>自愿评价，跳过也可以继续查看结果。</p>
    {state.kind === "loading" ? <p role="status">正在读取评分状态…</p> : state.rating !== null && state.kind !== "error" ? <p role="status">你已提交 {state.rating} 分，感谢反馈。</p> : <>
      <div className="feedbackChoices" role="group" aria-label="体验评分 1 到 5 分">{[1, 2, 3, 4, 5].map((rating) => <button key={rating} className="feedbackChoice" type="button" disabled={state.kind === "saving"} aria-label={`${rating} 分`} onClick={() => void submit(rating)}>{rating}</button>)}</div>
      {state.kind === "saving" && <p role="status">正在提交…</p>}{state.kind === "error" && <p className="feedbackError" role="alert">{state.message}<button className="feedbackRetry" type="button" onClick={() => setState({ kind: "ready", rating: null })}>重试</button></p>}
    </>}
  </section>;
}
