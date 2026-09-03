import Link from "next/link";
import type { Metadata } from "next";
import {
  conversationConfig,
  MAX_MESSAGES_IN_PROMPT,
} from "@/lib/conversation";
import { knowledgeConfig } from "@/lib/knowledge";
import { ollamaConfig } from "@/lib/ollama";
import { embedConfig } from "@/lib/embeddings";
import { isAuthEnabled } from "@/lib/auth";

export const metadata: Metadata = {
  title: "説明書 | ローカルLLM ワークフロー",
};

/**
 * In-app operating manual. Server component: the live values below are read
 * from the same config the pipeline uses, so the manual can't drift from the
 * running app the way a hand-written copy would.
 */
export default function ManualPage() {
  const facts: [string, string][] = [
    ["応答生成モデル", ollamaConfig.chatModel],
    ["要約モデル", ollamaConfig.summaryModel],
    ["埋め込みモデル", embedConfig.model],
    ["文脈長 (num_ctx)", String(ollamaConfig.chatNumCtx)],
    ["思考モード", ollamaConfig.chatThink ? "ON" : "OFF"],
    ["圧縮しきい値", `${conversationConfig.triggerTokens} tokens（概算）`],
    ["圧縮後に残すターン", String(conversationConfig.keepRecentTurns)],
    ["プロンプトの履歴上限", `${MAX_MESSAGES_IN_PROMPT} 件`],
    ["RAG しきい値", `距離 ${knowledgeConfig.maxDistance} 以内`],
    ["RAG 採用件数", `上位 ${knowledgeConfig.topK} 件`],
    ["認証", isAuthEnabled() ? "有効（共有パスワード）" : "無効"],
    ["Ollama", ollamaConfig.baseUrl],
  ];

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-8">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-400">
            operating manual
          </p>
          <h1 className="text-xl font-semibold sm:text-2xl">説明書</h1>
          <p className="text-sm text-zinc-500">
            いま何ができるか。値はすべて動作中の設定から読んでいます。
          </p>
        </div>
        <Link
          href="/"
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-black/[.04] dark:border-zinc-700 dark:hover:bg-white/[.06]"
        >
          ← チャットへ
        </Link>
      </header>

      {/* live config */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800">
        <h2 className="border-b border-zinc-200 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-400 dark:border-zinc-800">
          現在の設定
        </h2>
        <dl className="grid grid-cols-1 gap-px bg-zinc-200 sm:grid-cols-2 dark:bg-zinc-800">
          {facts.map(([k, v]) => (
            <div key={k} className="bg-white px-4 py-2.5 dark:bg-zinc-950">
              <dt className="text-[11px] text-zinc-400">{k}</dt>
              <dd className="font-mono text-[13px] break-all">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Section title="1通が通る6工程">
        <p>
          送信するたびにこの順で処理されます。生成中に出る図の 6
          モジュールは、この工程そのものです。
        </p>
        <ol className="flex list-none flex-col gap-3 p-0">
          {[
            [
              "入力受付",
              "input",
              "メッセージを受け取り長さを測ります。実際のトークン分割はモデル側です。",
            ],
            [
              "ベクトル化",
              "embed",
              `質問文を ${embedConfig.model} で 1024 次元のベクトル1本にします。ウォーム時 100〜200ms 程度。`,
            ],
            [
              "知識検索",
              "retrieve",
              `保存済み知識とコサイン距離を比較し、${knowledgeConfig.maxDistance} 以内で近い順に最大 ${knowledgeConfig.topK} 件を採用。0件でも回答は続きます。`,
            ],
            [
              "プロンプト構成",
              "prompt",
              "知識 → 過去の要約 → 直近の会話 → 今回の質問、の順に1本のメッセージ列へ。",
            ],
            [
              "応答生成",
              "generate",
              "次トークンの確率を計算 → 1つ選ぶ → 末尾に足す、の繰り返し（自己回帰）。待ち時間のほぼ全部がここ。約 22 tok/s、初回はモデル読み込みで +20秒ほど。",
            ],
            [
              "出力・保存",
              "persist / compact",
              "回答を表示して履歴に保存。長くなっていれば続けて自動圧縮が走ります。",
            ],
          ].map(([ja, en, desc], i) => (
            <li key={en} className="grid grid-cols-[28px_1fr] gap-3">
              <span className="pt-0.5 font-mono text-xs text-zinc-400 tabular-nums">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <p className="font-medium">
                  {ja}
                  <span className="ml-2 font-mono text-[11px] font-normal text-zinc-400">
                    {en}
                  </span>
                </p>
                <p className="text-sm text-zinc-500">{desc}</p>
              </div>
            </li>
          ))}
        </ol>
        <Note>
          知識検索がこけても RAG なしで回答を続けます。一過性の不調や 5xx
          は最大2回リトライ、モデルが空文字を返した場合ももう一度だけ生成し直します。
        </Note>
      </Section>

      <Section title="長期知識（RAG）">
        <p>
          会話をリセットしても消えない「覚えておいてほしい事実」の置き場です。保存先は{" "}
          <Code>data/lancedb/</Code>（LanceDB、別サーバー不要のアプリ内蔵型）。
        </p>
        <h3 className="text-sm font-semibold">入れ方は2通り</h3>
        <ul>
          <li>
            <Code>manual</Code> — チャット画面の「長期知識」パネルを開いて、事実を1行入れて「追加」
          </li>
          <li>
            <Code>auto</Code> — 文脈圧縮が走るたび、要約モデルが「長期的に覚えるべき事実」を
            最大5件まで抜き出して自動保存
          </li>
        </ul>
        <h3 className="text-sm font-semibold">使われ方</h3>
        <p>
          質問するたびに毎回検索され、ヒットしたものは <Code>system</Code>{" "}
          メッセージとしてプロンプト先頭に差し込まれます。「関係なければ無視してください」と
          添えてあるので、無関係な知識が混ざっても回答は壊れません。返信のメタ欄に
          「参照知識 N件」として何件効いたか出ます。
        </p>
        <h3 className="text-sm font-semibold">消し方</h3>
        <p>
          知識パネル、または管理画面の「全消去」。
          <strong>個別削除は未実装</strong>で、消すときは全部です。
        </p>
      </Section>

      <Section title="文脈の自動圧縮">
        <p>毎回の返信後にチェックし、どちらかを超えたら圧縮します。</p>
        <ul>
          <li>生ログの概算トークン数が {conversationConfig.triggerTokens} を超えた</li>
          <li>
            メッセージ数が {conversationConfig.keepRecentTurns * 2 + 4} 件を超えた
          </li>
        </ul>
        <p>圧縮では、直近 {conversationConfig.keepRecentTurns} ターンをそのまま残し、
          それより古い部分を要約モデルが1つの要約にまとめます（前回の要約があれば統合）。
          そこから恒常的な事実を最大5件抜き出して長期知識へ移送し、以後のプロンプトは
          「要約(system) + 直近ターン」の形になります。
        </p>
        <p>
          画面のトランスクリプトは全部残ります。圧縮されるのは
          <strong>モデルに送る中身だけ</strong>です。圧縮済みの要約は
          チャット画面の「圧縮済みの会話要約」から読めます。
        </p>
        <h3 className="text-sm font-semibold">手動で今すぐ圧縮</h3>
        <p>
          「応答が重い・おかしい」と感じたときの緊急用。チャット画面の「今すぐ圧縮」か、
          管理画面の「緊急圧縮」。こちらは<strong>直近1ターンだけ残して</strong>
          あとは全部要約に畳みます。
        </p>
      </Section>

      <Section title="画面">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[
            ["/", "チャット", "会話、長期知識パネル、今すぐ圧縮、会話リセット。生成中は処理の可視化。"],
            ["/viz", "可視化（単体）", "6工程を手動で切り替えて見る展示モード。ドラッグで回転、ピンチで拡大。"],
            ["/admin", "管理", "Ollama の死活・再起動、状態表示、緊急圧縮、各種リセット。5秒ごと自動更新。"],
            ["/manual", "説明書", "このページ。"],
          ].map(([path, name, desc]) => (
            <div
              key={path}
              className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
            >
              <span className="font-mono text-xs text-sky-600 dark:text-sky-400">
                {path}
              </span>
              <p className="text-sm font-medium">{name}</p>
              <p className="text-sm text-zinc-500">{desc}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="触らないほうが安全な設定">
        <Note tone="warn">
          <p>
            <Code>OLLAMA_CHAT_NUM_CTX={ollamaConfig.chatNumCtx}</Code> — 既定の 16384
            だと VRAM から溢れて CPU に 12% 落ち、22 tok/s が 13 tok/s まで下がります。
          </p>
          <p className="mt-2">
            <Code>OLLAMA_CHAT_THINK=false</Code> — qwen3.5 は思考モデルなので、有効だと
            思考だけでトークン予算を使い切り、<strong>空の回答が約50秒かけて返ります</strong>。
          </p>
        </Note>
        <Note tone="warn">
          <p>
            <strong>Ollama 再起動はプロセスツリーごと。</strong>
            <Code>ollama.exe</Code> だけを強制終了すると子プロセスの{" "}
            <Code>llama-server.exe</Code> が取り残されて VRAM を掴んだままになり、
            次のモデル読み込みが 8GB GPU で失敗します
            （<Code>failed to allocate Vulkan0 buffer</Code>）。管理画面の再起動は
            まとめて落とすようにしてあります。
          </p>
        </Note>
      </Section>

      <Section title="起動・データ">
        <pre className="overflow-x-auto rounded-lg border border-zinc-200 bg-black/[.04] p-3 text-[13px] dark:border-zinc-800 dark:bg-white/[.04]">
          <code>{`npm start          # 起動
npm run build      # コードを変えたあと（→ npm start）`}</code>
        </pre>
        <ul>
          <li>
            <Code>data/conversation.json</Code> — 会話履歴と要約。サーバー再起動でも残る
          </li>
          <li>
            <Code>data/lancedb/</Code> — 長期知識のベクトルDB
          </li>
          <li>
            <Code>README.md</Code> / <Code>docs/</Code> — セットアップ・設計思想・調査結果・開発記録
          </li>
        </ul>
        <p className="text-sm text-zinc-500">
          どちらも Git 管理外です。ビルドが <Code>EPERM</Code> で落ちる場合は、
          サーバーを止めて <Code>.next</Code> を消してからもう一度。
        </p>
      </Section>

      <Section title="既知の制約">
        <ul>
          <li>
            <strong>応答はストリーミングしません。</strong>
            生成が終わるまで本文は出ません（進捗だけ流れます）。体感速度を上げたいならここが一番効きます
          </li>
          <li>
            <strong>自動抽出の事実は完璧ではありません。</strong>
            小型モデル任せなので、将来の予定を現在形で覚えることがあります
          </li>
          <li><strong>知識の個別削除がありません。</strong>いまは全消去のみ</li>
          <li><strong>会話は1本だけ。</strong>複数スレッドの切り替えはありません</li>
          <li><strong>同時送信のガードなし。</strong>2画面から同時に送ると履歴が競合しえます</li>
          <li>
            <strong>トークン数は概算。</strong>
            圧縮の発火判定は文字数ベースの見積もりです
          </li>
        </ul>
      </Section>

      <footer className="border-t border-zinc-200 pt-4 font-mono text-xs text-zinc-400 dark:border-zinc-800">
        実装から起こした説明書 · 詳細は README.md と docs/
      </footer>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="border-b border-zinc-200 pb-2 text-lg font-semibold dark:border-zinc-800">
        {title}
      </h2>
      <div className="flex flex-col gap-3 text-[15px] leading-relaxed [&_li]:mb-1 [&_ul]:list-disc [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}

function Note({
  children,
  tone = "info",
}: {
  children: React.ReactNode;
  tone?: "info" | "warn";
}) {
  return (
    <div
      className={`rounded-r-lg border border-l-[3px] p-3 text-sm ${
        tone === "warn"
          ? "border-zinc-200 border-l-red-500 bg-red-50/40 dark:border-zinc-800 dark:border-l-red-500 dark:bg-red-950/20"
          : "border-zinc-200 border-l-amber-500 bg-amber-50/40 dark:border-zinc-800 dark:border-l-amber-500 dark:bg-amber-950/20"
      }`}
    >
      {children}
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded border border-zinc-200 bg-black/[.05] px-1 py-0.5 font-mono text-[0.85em] dark:border-zinc-800 dark:bg-white/[.06]">
      {children}
    </code>
  );
}
