"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type LoadedModel = { name: string; vramMB: number };
type Health = {
  status: "ok" | "slow" | "down";
  latencyMs: number | null;
  models: LoadedModel[];
  checkedAt: string;
  error?: string;
};
type Status = {
  ollama: Health;
  conversation: {
    messageCount: number;
    turnCount: number;
    approxTokens: number;
    hasSummary: boolean;
    compactions: number;
  };
  knowledge: { count: number };
};

const STATUS_LABEL: Record<Health["status"], string> = {
  ok: "稼働中",
  slow: "応答遅延",
  down: "停止／不通",
};
const STATUS_COLOR: Record<Health["status"], string> = {
  ok: "bg-green-500",
  slow: "bg-amber-500",
  down: "bg-red-500",
};

export default function AdminPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<"" | "restart" | "compact" | "reset" | "kclear">("");
  const [log, setLog] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      setStatus(await res.json());
    } catch {
      /* leave previous status */
    }
  }, []);

  useEffect(() => {
    // setStatus only fires after an await inside refresh() - not a sync cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  function note(line: string) {
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 8));
  }

  async function restart() {
    if (busy) return;
    if (!confirm("Ollama サーバーを再起動します。実行中の生成は中断されます。よろしいですか？")) return;
    setBusy("restart");
    note("再起動を開始…");
    try {
      const res = await fetch("/api/ollama/restart", { method: "POST" });
      const data = await res.json();
      (data.steps ?? [data.error ?? "不明な結果"]).forEach((s: string) => note(s));
      note(data.ok ? "再起動完了。" : "再起動は完了しませんでした。");
    } catch {
      note("再起動リクエストに失敗しました。");
    } finally {
      setBusy("");
      refresh();
    }
  }

  async function compact() {
    if (busy) return;
    setBusy("compact");
    note("緊急圧縮を実行…");
    try {
      const res = await fetch("/api/conversation/compact", { method: "POST" });
      const data = await res.json();
      if (!res.ok) note(data.error ?? "圧縮に失敗しました。");
      else if (data.compacted)
        note(
          `圧縮完了：${data.result.summarizedMessages} 件を要約` +
            (data.result.factsSaved?.length
              ? `（長期知識へ ${data.result.factsSaved.length} 件）`
              : ""),
        );
      else note("圧縮対象がありませんでした。");
    } catch {
      note("圧縮リクエストに失敗しました。");
    } finally {
      setBusy("");
      refresh();
    }
  }

  async function resetConversation() {
    if (busy) return;
    if (!confirm("会話履歴と要約を全消去します。よろしいですか？")) return;
    setBusy("reset");
    try {
      await fetch("/api/conversation", { method: "DELETE" });
      note("会話をリセットしました。");
    } finally {
      setBusy("");
      refresh();
    }
  }

  async function clearKnowledge() {
    if (busy) return;
    if (!confirm("長期知識ベースを全消去します。よろしいですか？")) return;
    setBusy("kclear");
    try {
      await fetch("/api/knowledge", { method: "DELETE" });
      note("長期知識を消去しました。");
    } finally {
      setBusy("");
      refresh();
    }
  }

  const h = status?.ollama;
  const c = status?.conversation;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 px-4 py-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">管理画面</h1>
        <div className="flex items-baseline gap-4 text-sm">
          <Link href="/manual" className="text-zinc-500 hover:underline">
            説明書
          </Link>
          <Link href="/" className="text-zinc-500 hover:underline">
            ← チャットへ
          </Link>
          <button
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              router.replace("/login");
              router.refresh();
            }}
            className="text-zinc-400 hover:underline"
          >
            ログアウト
          </button>
        </div>
      </header>

      {/* Ollama */}
      <section className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Ollama サーバー</h2>
          <button
            onClick={() => void restart()}
            disabled={busy !== ""}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-black/[.04] disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-white/[.06]"
          >
            {busy === "restart" ? "再起動中…" : "再起動"}
          </button>
        </div>
        <div className="mt-3 flex items-center gap-2 text-sm">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${
              h ? STATUS_COLOR[h.status] : "bg-zinc-400"
            }`}
          />
          <span>{h ? STATUS_LABEL[h.status] : "確認中…"}</span>
          {h?.latencyMs != null && (
            <span className="text-zinc-400">· {h.latencyMs} ms</span>
          )}
          {h?.error && <span className="text-red-500">· {h.error}</span>}
        </div>
        <div className="mt-2 text-xs text-zinc-500">
          ロード中のモデル:{" "}
          {h && h.models.length
            ? h.models.map((m) => `${m.name} (${m.vramMB} MB)`).join("、 ")
            : "なし"}
        </div>
      </section>

      {/* Conversation */}
      <section className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">会話コンテキスト</h2>
          <div className="flex gap-2">
            <button
              onClick={() => void compact()}
              disabled={busy !== ""}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-black/[.04] disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-white/[.06]"
            >
              {busy === "compact" ? "圧縮中…" : "緊急圧縮"}
            </button>
            <button
              onClick={() => void resetConversation()}
              disabled={busy !== ""}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-zinc-700 dark:text-red-400 dark:hover:bg-red-950/30"
            >
              リセット
            </button>
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <Stat label="直近ターン" value={c?.turnCount} />
          <Stat label="生ログ" value={c?.messageCount} />
          <Stat label="概算 tokens" value={c?.approxTokens} />
          <Stat label="圧縮回数" value={c?.compactions} />
        </dl>
        <p className="mt-2 text-xs text-zinc-500">
          要約: {c?.hasSummary ? "あり" : "なし"}
        </p>
      </section>

      {/* Knowledge */}
      <section className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">長期知識ベース</h2>
          <button
            onClick={() => void clearKnowledge()}
            disabled={busy !== ""}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-zinc-700 dark:text-red-400 dark:hover:bg-red-950/30"
          >
            全消去
          </button>
        </div>
        <p className="mt-3 text-sm">
          蓄積件数:{" "}
          <span className="font-medium">{status?.knowledge.count ?? "…"}</span>
        </p>
      </section>

      {log.length > 0 && (
        <section className="rounded-xl border border-zinc-200 p-3 text-xs text-zinc-500 dark:border-zinc-800">
          {log.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap">
              {l}
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div>
      <dt className="text-xs text-zinc-400">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value ?? "…"}</dd>
    </div>
  );
}
