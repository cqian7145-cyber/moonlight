"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { calculateSoloResult, type SoloResult } from "./calculate-solo-result";
import { soloQuestions } from "./questions";

export function SoloDemo() {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<number[]>([]);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [result, setResult] = useState<SoloResult | null>(null);

  const question = soloQuestions[step];

  function continueDemo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedAnswer === null) return;

    const nextAnswers = [...answers, selectedAnswer];
    setAnswers(nextAnswers);

    if (step === soloQuestions.length - 1) {
      setResult(calculateSoloResult(nextAnswers));
      return;
    }

    setStep((currentStep) => currentStep + 1);
    setSelectedAnswer(null);
  }

  function restart() {
    setStep(0);
    setAnswers([]);
    setSelectedAnswer(null);
    setResult(null);
  }

  return (
    <main className="demoPage">
      <div className="demoShell">
        <header className="demoHeader">
          <Link className="backLink" href="/">返回首页</Link>
          <Link className="demoBrand" href="/" aria-label="Moonlight 首页">moonlight<span>.</span></Link>
        </header>

        <div className="demoIntro">
          <p className="demoKicker">个人玩法 · 演示数据</p>
          <h1>给今晚挑一点灵感。</h1>
          <p>跟着直觉选就好。三个小问题，没有标准答案。</p>
        </div>

        <div aria-live="polite" aria-atomic="true">
          {result ? (
            <section className="resultCard" aria-labelledby="result-title">
              <div className="resultTop">
                <p className="resultLabel">你的今晚小签</p>
                <span className="resultMark" aria-hidden="true">+</span>
              </div>
              <h2 id="result-title">{result.title}</h2>
              <p className="resultDescription">{result.description}</p>
              <div className="suggestionBox">
                <span>今晚可以试试</span>
                <p>{result.suggestion}</p>
              </div>
              <p className="resultDisclaimer">这份结果只根据本轮三个选择生成，是轻松的玩法反馈，不是人格诊断或性格测试。</p>
              <div className="resultActions">
                <button className="button buttonPrimary" type="button" onClick={restart}>重新开始</button>
                <Link className="button buttonQuiet" href="/">回到首页</Link>
              </div>
            </section>
          ) : (
            <section className="questionCard" aria-labelledby="question-title">
              <div className="progressHead">
                <span>个人小玩法</span>
                <strong>第 {step + 1} 题 / 共 {soloQuestions.length} 题</strong>
              </div>
              <div
                className="progressTrack"
                role="progressbar"
                aria-label="答题进度"
                aria-valuemin={0}
                aria-valuemax={soloQuestions.length}
                aria-valuenow={step + 1}
              >
                <div className="progressValue" style={{ width: `${((step + 1) / soloQuestions.length) * 100}%` }} />
              </div>

              <form className="questionForm" onSubmit={continueDemo}>
                <fieldset>
                  <legend id="question-title">{question.prompt}</legend>
                  <div className="choiceList">
                    {question.choices.map((choice) => {
                      const id = `answer-${step}-${choice.value}`;
                      return (
                        <label className="choiceOption" htmlFor={id} key={choice.value}>
                          <input
                            id={id}
                            type="radio"
                            name={`question-${step}`}
                            value={choice.value}
                            checked={selectedAnswer === choice.value}
                            onChange={() => setSelectedAnswer(choice.value)}
                          />
                          <span className="choiceMark" aria-hidden="true" />
                          <span className="choiceText">{choice.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
                <div className="questionActions">
                  <span className="selectionHint">选择一项后继续，答案不会保存。</span>
                  <button className="continueButton" type="submit" disabled={selectedAnswer === null}>
                    {step === soloQuestions.length - 1 ? "看今晚小签" : "确认这一题"}
                  </button>
                </div>
              </form>
            </section>
          )}
        </div>
        <p className="demoPrivacy">本轮选择只在当前页面生成结果，不会发送给外部服务。</p>
      </div>
    </main>
  );
}
