"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import {
  STAGE_LAYER,
  type StageLogEntry,
  type VizStage,
} from "@/components/NeuralViz";

const NeuralViz = dynamic(() => import("@/components/NeuralViz"), { ssr: false });

const STAGES: VizStage[] = [
  "input",
  "embed",
  "retrieve",
  "prompt",
  "generate",
  "done",
];

/** Representative numbers so the demo modules show realistic detail. */
const DEMO: Record<string, { detail: string; ms: number }> = {
  input: { detail: "約 12 tokens", ms: 1 },
  embed: { detail: "1024 次元", ms: 140 },
  retrieve: { detail: "2 件ヒット", ms: 6 },
  prompt: { detail: "4 メッセージ", ms: 1 },
  generate: { detail: "80 tokens · 21.0 tok/s", ms: 3800 },
  done: { detail: "3 件を要約", ms: 20 },
};

export default function VizPage() {
  const [stage, setStage] = useState<VizStage>("input");
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (!auto) return;
    let i = 0;
    const id = setInterval(() => {
      i = (i + 1) % STAGES.length;
      setStage(STAGES[i]);
    }, 2000);
    return () => clearInterval(id);
  }, [auto]);

  // a running log up to the current stage, like the chat page would build
  const log = useMemo<StageLogEntry[]>(() => {
    const upto = STAGES.indexOf(stage);
    return STAGES.slice(0, upto + 1)
      .filter((s) => DEMO[s])
      .map((s) => ({ stage: s, detail: DEMO[s].detail, ms: DEMO[s].ms }));
  }, [stage]);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">処理ビジュアライゼーション</h1>
        <div className="flex items-baseline gap-4 text-sm">
          <Link href="/manual" className="text-zinc-500 hover:underline">
            説明書
          </Link>
          <Link href="/" className="text-zinc-500 hover:underline">
            ← チャットへ
          </Link>
        </div>
      </header>
      <p className="text-sm text-zinc-500">
        6 つの処理を、それぞれが「何をしているか」の図で表しています。
        <br />
        ドラッグで回転、ホイール・ピンチで拡大。図の中や下のタブをタップすると
        その処理に寄れます（「全体表示」で戻る）。
        <br />
        図はしくみの説明用で、モデル内部そのものの再現ではありません。
      </p>

      <NeuralViz stage={stage} detail={DEMO[stage]?.detail ?? ""} log={log} height={440} />

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setAuto((a) => !a)}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700"
        >
          {auto ? "自動再生: ON" : "自動再生: OFF"}
        </button>
        {STAGES.map((p) => (
          <button
            key={p}
            onClick={() => {
              setAuto(false);
              setStage(p);
            }}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
              STAGE_LAYER[stage] === STAGE_LAYER[p]
                ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900"
                : "border-zinc-300 dark:border-zinc-700"
            }`}
          >
            {p}
          </button>
        ))}
      </div>
    </main>
  );
}
