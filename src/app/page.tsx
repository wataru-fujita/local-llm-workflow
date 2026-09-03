"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { VizStage } from "@/components/NeuralViz";

// Babylon.js is heavy - load it only in the browser, only when first needed.
const NeuralViz = dynamic(() => import("@/components/NeuralViz"), {
  ssr: false,
});

type StageLog = { stage: VizStage; ms?: number; detail?: string };

type Role = "system" | "user" | "assistant";
type Message = { role: Role; content: string };
type Stats = {
  messageCount: number;
  turnCount: number;
  approxTokens: number;
  hasSummary: boolean;
  compactions: number;
};
type ReplyMeta = {
  model: string;
  totalDurationMs: number;
  evalCount: number;
  tokensPerSecond: number | null;
  retrieved: { text: string; distance: number }[];
};
type KnowledgeItem = { text: string; source: string; createdAt: string };

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [summary, setSummary] = useState("");
  const [notice, setNotice] = useState("");
  const [lastMeta, setLastMeta] = useState<ReplyMeta | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [kInput, setKInput] = useState("");
  const [kBusy, setKBusy] = useState(false);

  const [ollamaDown, setOllamaDown] = useState(false);

  // Driven by the real NDJSON progress stream from /api/chat.
  const [vizStage, setVizStage] = useState<VizStage>("idle");
  const [stageLog, setStageLog] = useState<StageLog[]>([]);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    [],
  );

  useEffect(() => {
    fetch("/api/conversation")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.messages)) setMessages(d.messages);
        if (d.stats) setStats(d.stats);
        if (typeof d.summary === "string") setSummary(d.summary);
      })
      .catch(() => {});
    refreshKnowledge();
  }, []);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch("/api/ollama/health", { cache: "no-store" });
        const d = await r.json();
        if (alive) setOllamaDown(d.status === "down");
      } catch {
        if (alive) setOllamaDown(true);
      }
    };
    check();
    const id = setInterval(check, 20000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  function refreshKnowledge() {
    fetch("/api/knowledge")
      .then((r) => r.json())
      .then((d) => setKnowledge(Array.isArray(d.items) ? d.items : []))
      .catch(() => {});
  }

  function refreshConversationMeta() {
    fetch("/api/conversation")
      .then((r) => r.json())
      .then((d) => {
        if (d.stats) setStats(d.stats);
        if (typeof d.summary === "string") setSummary(d.summary);
      })
      .catch(() => {});
  }

  async function compact() {
    if (loading) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/conversation/compact", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "圧縮に失敗しました。");
        return;
      }
      if (data.compacted && data.result) {
        setNotice(
          `緊急圧縮：${data.result.summarizedMessages} 件を要約に圧縮` +
            (data.result.factsSaved.length
              ? `（長期知識へ ${data.result.factsSaved.length} 件移送）`
              : ""),
        );
      } else {
        setNotice("圧縮対象がありませんでした。");
      }
      refreshConversationMeta();
      refreshKnowledge();
    } catch {
      setError("圧縮に失敗しました。");
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    const message = input.trim();
    if (!message || loading) return;

    setLoading(true);
    setError("");
    setNotice("");
    setInput("");
    setMessages((m) => [...m, { role: "user", content: message }]);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setStageLog([]);
    setVizStage("input");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

      // Non-streaming failures (validation, auth) still come back as JSON.
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `エラー (${res.status})`);
        if (res.status === 502) setOllamaDown(true);
        setVizStage("idle");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;

      // NDJSON: one event per line.
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;

          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }

          if (ev.type === "stage") {
            const stage = ev.stage as VizStage;
            if (ev.status === "start") {
              setVizStage(stage);
            } else {
              setStageLog((l) => {
                const next = [...l];
                const existing = next.findIndex((s) => s.stage === stage);
                const entry: StageLog = {
                  stage,
                  ms: (ev.ms as number | undefined) ?? next[existing]?.ms,
                  detail:
                    (ev.detail as string | undefined) ?? next[existing]?.detail,
                };
                if (existing >= 0) next[existing] = entry;
                else next.push(entry);
                return next;
              });
            }
          } else if (ev.type === "done") {
            finished = true;
            setOllamaDown(false);
            setVizStage("done");
            idleTimer.current = setTimeout(() => setVizStage("idle"), 1600);
            setMessages((m) => [
              ...m,
              { role: "assistant", content: ev.reply as string },
            ]);
            setStats((ev.stats as Stats) ?? null);
            setLastMeta({
              model: ev.model as string,
              totalDurationMs: ev.totalDurationMs as number,
              evalCount: ev.evalCount as number,
              tokensPerSecond: ev.tokensPerSecond as number | null,
              retrieved:
                (ev.retrieved as { text: string; distance: number }[]) ?? [],
            });
            const comp = ev.compaction as {
              summarizedMessages: number;
              factsSaved: string[];
            } | null;
            if (comp) {
              setNotice(
                `古い履歴 ${comp.summarizedMessages} 件を要約に圧縮しました` +
                  (comp.factsSaved.length
                    ? `（長期知識へ ${comp.factsSaved.length} 件移送）`
                    : ""),
              );
              refreshConversationMeta();
              refreshKnowledge();
            }
          } else if (ev.type === "error") {
            finished = true;
            setError((ev.error as string) ?? "エラーが発生しました。");
            if (ev.connection) setOllamaDown(true);
            setVizStage("idle");
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "通信に失敗しました。");
      setVizStage("idle");
    } finally {
      setLoading(false);
    }
  }

  async function reset() {
    if (loading) return;
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/conversation", { method: "DELETE" });
      const data = await res.json();
      setMessages([]);
      setStats(data.stats ?? null);
      setSummary("");
      setLastMeta(null);
    } catch {
      setError("リセットに失敗しました。");
    }
  }

  async function addKnowledge() {
    const text = kInput.trim();
    if (!text || kBusy) return;
    setKBusy(true);
    setError("");
    try {
      const res = await fetch("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "知識の登録に失敗しました。");
        return;
      }
      setKInput("");
      refreshKnowledge();
    } catch {
      setError("知識の登録に失敗しました。");
    } finally {
      setKBusy(false);
    }
  }

  async function clearKnowledge() {
    if (kBusy) return;
    setKBusy(true);
    try {
      await fetch("/api/knowledge", { method: "DELETE" });
      setKnowledge([]);
    } finally {
      setKBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <main className="mx-auto flex h-full w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-8">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div>
          <h1 className="text-lg font-semibold sm:text-xl">
            ローカルLLM ワークフロー
          </h1>
          <p className="text-sm text-zinc-500">
            RAG・自動圧縮・管理画面つきの Ollama ワークフロー
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/manual"
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium transition-opacity hover:bg-black/[.04] dark:border-zinc-700 dark:hover:bg-white/[.06]"
          >
            説明書
          </Link>
          <Link
            href="/viz"
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium transition-opacity hover:bg-black/[.04] dark:border-zinc-700 dark:hover:bg-white/[.06]"
          >
            可視化
          </Link>
          <Link
            href="/admin"
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium transition-opacity hover:bg-black/[.04] dark:border-zinc-700 dark:hover:bg-white/[.06]"
          >
            管理
          </Link>
          <button
            onClick={() => void compact()}
            disabled={loading || messages.length === 0}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium transition-opacity hover:bg-black/[.04] disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-white/[.06]"
          >
            今すぐ圧縮
          </button>
          <button
            onClick={() => void reset()}
            disabled={loading || messages.length === 0}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium transition-opacity hover:bg-black/[.04] disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-white/[.06]"
          >
            会話リセット
          </button>
        </div>
      </header>

      <details className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
        <summary className="cursor-pointer select-none text-zinc-500">
          長期知識（{knowledge.length}件）
        </summary>
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              value={kInput}
              onChange={(e) => setKInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addKnowledge();
                }
              }}
              placeholder="覚えさせたい事実を1つ入力…"
              className="flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 outline-none focus:border-zinc-500 dark:border-zinc-700"
            />
            <button
              onClick={() => void addKnowledge()}
              disabled={kBusy || !kInput.trim()}
              className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-zinc-900"
            >
              追加
            </button>
          </div>
          {knowledge.length > 0 && (
            <>
              <ul className="flex flex-col gap-1">
                {knowledge.map((k, i) => (
                  <li
                    key={i}
                    className="rounded bg-black/[.04] px-2 py-1 text-xs dark:bg-white/[.06]"
                  >
                    {k.text}
                  </li>
                ))}
              </ul>
              <button
                onClick={() => void clearKnowledge()}
                disabled={kBusy}
                className="self-start text-xs text-red-600 hover:underline disabled:opacity-40 dark:text-red-400"
              >
                すべて削除
              </button>
            </>
          )}
        </div>
      </details>

      {ollamaDown && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          Ollama サーバーに接続できません。
          <Link href="/admin" className="ml-1 font-medium underline">
            管理画面
          </Link>
          から再起動できます。
        </div>
      )}

      {stats && (
        <p className="text-xs text-zinc-400">
          直近ターン {stats.turnCount} · 生ログ {stats.messageCount} 件 · 概算{" "}
          {stats.approxTokens} tokens
          {stats.hasSummary ? ` · 要約あり（圧縮 ${stats.compactions} 回）` : ""}
        </p>
      )}

      {summary && (
        <details className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
          <summary className="cursor-pointer select-none text-amber-700 dark:text-amber-400">
            圧縮済みの会話要約
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-300">
            {summary}
          </p>
        </details>
      )}

      {notice && (
        <div className="rounded-lg border border-zinc-200 bg-black/[.03] p-2 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-white/[.04]">
          {notice}
        </div>
      )}

      <div
        ref={scrollRef}
        className="flex flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
      >
        {messages.length === 0 && !loading && (
          <p className="m-auto text-sm text-zinc-400">
            メッセージを送ると会話が始まります。
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={
              m.role === "user"
                ? "self-end rounded-2xl rounded-br-sm bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-white dark:text-zinc-900"
                : "self-start rounded-2xl rounded-bl-sm bg-black/[.05] px-3 py-2 text-sm whitespace-pre-wrap dark:bg-white/[.08]"
            }
          >
            {m.content}
          </div>
        ))}
        {vizStage !== "idle" && (
          <div className="w-full">
            <NeuralViz
              stage={vizStage}
              detail={stageLog.find((s) => s.stage === vizStage)?.detail ?? ""}
              log={stageLog}
              height={300}
            />
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder="メッセージを入力…  (Ctrl / ⌘ + Enter で送信)"
          className="w-full resize-y rounded-lg border border-zinc-300 bg-transparent p-3 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-zinc-400">
            {lastMeta &&
              `${lastMeta.model} · ${lastMeta.evalCount} tokens${
                lastMeta.tokensPerSecond
                  ? ` · ${lastMeta.tokensPerSecond} tok/s`
                  : ""
              } · ${(lastMeta.totalDurationMs / 1000).toFixed(1)}s${
                lastMeta.retrieved.length
                  ? ` · 参照知識 ${lastMeta.retrieved.length}件`
                  : ""
              }`}
          </span>
          <button
            onClick={() => void send()}
            disabled={loading || !input.trim()}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-40 dark:bg-white dark:text-zinc-900"
          >
            {loading ? "生成中…" : "送信"}
          </button>
        </div>
      </div>
    </main>
  );
}
