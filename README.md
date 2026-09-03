# local-llm-workflow

Ollama（ローカルLLM）で動く、**チャットではなくワークフロー型**のアプリ。1通のメッセージが
`入力 → ベクトル化 → 知識検索 → プロンプト構成 → 応答生成 → 出力` の6工程を通って返る。
長期知識（RAG）、文脈の自動圧縮、Ollama の管理画面、そして待ち時間に処理を触って学べる3D可視化つき。
フロントからバックまで **TypeScript / Node.js のみ**、Python 不要。

📝 **作った経緯と、待ち時間をどう設計したかの記録** →
[非力な自宅PCでローカルLLMを構築。手持ちの TypeScript だけで『待ち時間』まで自分なりに設計した記録](docs/article.md)

> 引き継ぐ人へ：このREADMEを一読すれば動かせる。設計の「なぜ」は [`docs/01_仕様書.md`](docs/01_仕様書.md) の「0. 設計思想」、
> ハマりどころは [`docs/02_調査結果.md`](docs/02_調査結果.md) の「5. 運用上の落とし穴」、続きの進め方は [`docs/03_実行計画書.md`](docs/03_実行計画書.md)。

---

## 設計思想（3行）

- **チャットではなくワークフロー。** 各ステップは独立した非同期関数。ノードUIではなくコード上のパイプライン。
- **軽量モデルを役割で分ける。** 応答生成・要約・埋め込みで別モデル。1モデルに全部やらせない。
- **遅さを学びの時間に変える。** 非力なGPUで生成は遅い。その待ち時間に、各処理を正確に図解した3Dの「窓」を回して仕組みを学べる。体感待ち時間の短縮が狙い。

## 必要なもの

| | |
|---|---|
| Node.js | 24 系（`@types/node ^24` を使用） |
| Ollama | 常時起動。GPU 推奨（このプロジェクトは 8GB VRAM / Vulkan で検証） |
| OS | Windows で検証（Ollama 再起動が PowerShell 依存。他OSは `OLLAMA_RESTART_CMD` で差し替え） |

### モデルを pull

```bash
ollama pull qwen3.5:9b   # 応答生成
ollama pull qwen3.5:2b   # 要約・事実抽出
ollama pull bge-m3       # 埋め込み（1024次元）
```

3モデルの同時常駐は 8GB VRAM では不可。Ollama が keep-alive でスワップする（圧縮が走る回だけ待ちが伸びる）。

## セットアップ

```bash
npm install
cp .env.example .env.local     # 必要なら値を編集
npm run dev                    # http://localhost:3000
```

初回アクセスは `.env.local` の `APP_PASSWORD` でログイン（空にすると認証無効）。

### 本番

```bash
npm run build
npm start -- -H 0.0.0.0 -p 3000   # Tailscale 等でスマホから見るなら 0.0.0.0
```

## 触ってはいけない2つの設定

8GB VRAM 環境での実測に基づく。理由は [`docs/02_調査結果.md`](docs/02_調査結果.md#3-モデル選定軽量帯) 参照。

- **`OLLAMA_CHAT_NUM_CTX=4096`** — Ollama 既定の 16384 だと `qwen3.5:9b` が VRAM から溢れ、12% が CPU に落ちて 22 tok/s → 13 tok/s に低下。
- **`OLLAMA_CHAT_THINK=false`** — qwen3.5 は思考モデル。有効だと思考だけでトークン予算を使い切り、**空の応答が約50秒かけて返る**。

## 画面

| ルート | 内容 |
|---|---|
| `/` | チャット / ワークフロー。長期知識パネル、今すぐ圧縮、リセット。生成中は処理の可視化 |
| `/viz` | 処理ビジュアライゼーション（単体）。ドラッグで回転、ピンチで拡大、タップで各工程へ寄る |
| `/admin` | Ollama の死活・再起動、会話と知識の状態、緊急圧縮、各種リセット。5秒ごと自動更新 |
| `/manual` | アプリ内説明書。「現在の設定」は実コードから読むのでズレない |
| `/login` | 共有パスワード1つ。Cookie 30日 |

## アーキテクチャ

```
Next.js 16 (App Router / src/ / Turbopack)
 ├─ src/proxy.ts                 共有パスワードで全ルート保護（middleware の Next16 改名版）
 ├─ src/app/api/chat/route.ts    6ステージのパイプライン本体。NDJSON で進捗をストリーム
 ├─ src/lib/ollama.ts            chat() / summaryComplete()。モデル・num_ctx・think の扱い
 ├─ src/lib/conversation.ts      会話マネージャー。永続化・圧縮・事実抽出
 ├─ src/lib/knowledge.ts         LanceDB（data/lancedb/）。cosine 上位3件・≤0.75
 ├─ src/lib/embeddings.ts        Ollama /api/embed ラッパー
 ├─ src/lib/ollama-admin.ts      死活チェック・再起動（プロセスツリーごと kill）
 ├─ src/lib/retry.ts             一過性エラーの2回リトライ
 └─ src/components/NeuralViz.tsx  Babylon.js の可視化（next/dynamic で必要時のみロード）
```

- **ベクトルDB**：LanceDB（`@lancedb/lancedb`、アプリ内蔵、別サーバー不要）。`next.config.ts` の `serverExternalPackages` に登録が必要。
- **可視化**：Babylon.js（`@babylonjs/core`）。ニューロン演出は実際にNNを使う「ベクトル化」「応答生成」の2工程だけ。他は固有の図（コサイン類似度の円錐、次トークン確率の棒、など）。
- **データ**：`data/conversation.json`（履歴＋要約）、`data/lancedb/`（知識）。どちらも Git 管理外。

## 設定一覧（`.env.local`）

| キー | 既定 | 意味 |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama の場所 |
| `OLLAMA_CHAT_MODEL` | `qwen3.5:9b` | 応答生成モデル |
| `OLLAMA_SUMMARY_MODEL` | `qwen3.5:2b` | 要約・事実抽出モデル |
| `OLLAMA_EMBED_MODEL` | `bge-m3` | 埋め込みモデル |
| `OLLAMA_CHAT_NUM_CTX` | `4096` | chat の文脈長。上げるとVRAMから溢れる |
| `OLLAMA_CHAT_THINK` | `false` | 思考モード。true にすると空応答の危険 |
| `OLLAMA_SUMMARY_NUM_CTX` | `4096` | 要約モデルの文脈長 |
| `CONVO_COMPRESS_TRIGGER_TOKENS` | `1400` | 自動圧縮の発火しきい値（概算トークン） |
| `CONVO_KEEP_RECENT_TURNS` | `4` | 圧縮後に生で残すターン数 |
| `APP_PASSWORD` | （空） | 共有パスワード。空で認証無効 |
| `OLLAMA_RESTART_CMD` | （既定は PowerShell） | 再起動コマンドの上書き。非Windows はここで差し替え |

コード固定値：RAG の `TOP_K=3` / `MAX_DISTANCE=0.75`（`src/lib/knowledge.ts`）、履歴上限 24 件 / 事実抽出上限 5 件（`src/lib/conversation.ts`）。

## ハマりどころ（先に知っておくと詰まらない）

- **Ollama 再起動はプロセスツリーごと。** `ollama.exe` だけ kill すると子の `llama-server.exe` が取り残されて VRAM を掴み、次のモデルロードが 8GB GPU で OOM する。管理画面の再起動はまとめて落とす。手動なら `Get-Process ollama,llama-server -EA SilentlyContinue | Stop-Process -Force`。
- **OneDrive 配下だとビルドが `EPERM` で落ちる。** サーバーを止めて `.next` を消してからビルド。
- **Windows シェル + `curl` + 日本語は文字化けする。** API の確認はブラウザで。
- **Next.js 16** は `middleware` → `proxy` に改名済み。route handler の細部も変わっているので `node_modules/next/dist/docs/` を見る習慣。

## 次にやるなら（優先度順）

1. **応答のストリーミング表示** — 体感速度の最大の改善。いまは生成完了まで本文が出ない
2. 長期知識の個別削除（いまは全消去のみ）
3. 圧縮の発火判定を文字数概算 → 実トークン数へ
4. 複数会話スレッド（いまは1本）
5. 同時送信のガード（会話マネージャーに mutex）

## ライセンス

MIT（[LICENSE](LICENSE)）。
