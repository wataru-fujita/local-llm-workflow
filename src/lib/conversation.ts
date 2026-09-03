/**
 * Conversation manager (phases 2 + 4).
 *
 * Holds the single active conversation and persists it to
 * `data/conversation.json` (survives a dev-server restart).
 *
 * Phase 4 - automatic context compression:
 *   - after each turn, if the raw history exceeds a token/turn threshold, the
 *     older messages are summarised by the fast summary model and folded into a
 *     rolling `summary`; only the last N turns stay verbatim.
 *   - durable facts spotted during compression are moved into the RAG store
 *     (@/lib/knowledge) so they outlive the conversation.
 *
 * Single-user home app: one global conversation, no per-session isolation.
 * Requests are effectively serial; a mutex can be added later if needed.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatMessage, ChatRole } from "./ollama";
import { summaryComplete } from "./ollama";
import { addKnowledge } from "./knowledge";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "conversation.json");

/** Compression thresholds (env-tunable). */
const TRIGGER_TOKENS = Number(process.env.CONVO_COMPRESS_TRIGGER_TOKENS ?? 1400);
const KEEP_RECENT_TURNS = Number(process.env.CONVO_KEEP_RECENT_TURNS ?? 4);
/** Hard ceiling on verbatim messages sent, regardless of compression. */
export const MAX_MESSAGES_IN_PROMPT = 24;
/** Cap on auto-extracted facts saved per compression. */
const MAX_FACTS_PER_COMPACTION = 5;

export type ConversationState = {
  messages: ChatMessage[];
  /** Rolling summary of everything already compressed away. */
  summary: string;
  compactions: number;
  createdAt: string;
  updatedAt: string;
};

export type ConversationStats = {
  messageCount: number;
  /** Number of user messages still verbatim. */
  turnCount: number;
  /** Rough estimate of the verbatim history size. */
  approxTokens: number;
  hasSummary: boolean;
  compactions: number;
};

export type CompactionResult = {
  compactions: number;
  summarizedMessages: number;
  factsSaved: string[];
  summary: string;
};

/** Very rough token estimate (mixed CJK/latin). Good enough for a trigger gauge. */
export function approxTokenCount(text: string): number {
  return Math.ceil(text.length / 3);
}

function emptyState(): ConversationState {
  const now = new Date().toISOString();
  return {
    messages: [],
    summary: "",
    compactions: 0,
    createdAt: now,
    updatedAt: now,
  };
}

// Survive Turbopack HMR by stashing the store on globalThis.
const globalStore = globalThis as unknown as {
  __conversationStore?: { state: ConversationState; loaded: boolean };
};
const store = (globalStore.__conversationStore ??= {
  state: emptyState(),
  loaded: false,
});

async function ensureLoaded(): Promise<void> {
  if (store.loaded) return;
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<ConversationState>;
    if (Array.isArray(parsed.messages)) {
      store.state = {
        ...emptyState(),
        ...parsed,
        messages: parsed.messages,
        summary: parsed.summary ?? "",
        compactions: parsed.compactions ?? 0,
      };
    }
  } catch {
    store.state = emptyState();
  }
  store.loaded = true;
}

async function persist(): Promise<void> {
  store.state.updatedAt = new Date().toISOString();
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store.state, null, 2), "utf8");
}

/** Full current conversation state. */
export async function getConversation(): Promise<ConversationState> {
  await ensureLoaded();
  return store.state;
}

/**
 * Messages to send to the model: the rolling summary (as a system message, if
 * any) followed by the trailing verbatim history.
 */
export async function getPromptMessages(): Promise<ChatMessage[]> {
  await ensureLoaded();
  const recent = store.state.messages.slice(-MAX_MESSAGES_IN_PROMPT);
  if (!store.state.summary) return recent;
  return [
    {
      role: "system",
      content: `これまでの会話の要約:\n${store.state.summary}`,
    },
    ...recent,
  ];
}

/** Append one message and persist. */
export async function addMessage(role: ChatRole, content: string): Promise<void> {
  await ensureLoaded();
  store.state.messages.push({ role, content });
  await persist();
}

/** Clear history + summary and start a fresh conversation. */
export async function resetConversation(): Promise<void> {
  store.state = emptyState();
  store.loaded = true;
  await persist();
}

export function statsFor(state: ConversationState): ConversationStats {
  return {
    messageCount: state.messages.length,
    turnCount: state.messages.filter((m) => m.role === "user").length,
    approxTokens: state.messages.reduce(
      (sum, m) => sum + approxTokenCount(m.content),
      0,
    ),
    hasSummary: state.summary.length > 0,
    compactions: state.compactions,
  };
}

function transcriptOf(messages: ChatMessage[]): string {
  return messages
    .map(
      (m) =>
        `${m.role === "user" ? "ユーザー" : m.role === "assistant" ? "アシスタント" : "システム"}: ${m.content}`,
    )
    .join("\n");
}

/** Ask the summary model for durable facts worth keeping past this conversation. */
async function extractFacts(transcript: string): Promise<string[]> {
  const raw = await summaryComplete(
    "次の会話ログから、ユーザーについて今後も長期的に覚えておくべき事実だけを抽出してください。\n" +
      "規則:\n" +
      "- 1行に1件、三人称の短い平叙文（例:「ユーザーの職業はソフトウェアエンジニア」）\n" +
      "- 挨拶・相槌・アシスタントの発言・一時的な話題は含めない\n" +
      "- 名前・職業・居住地・好み・予定・決定事項など恒常的な情報のみ\n" +
      "- 話者名や「〇〇:」のような接頭辞は付けない\n" +
      "- 該当がなければ「なし」とだけ出力\n\n" +
      transcript,
  );
  return raw
    .split("\n")
    .map((l) =>
      l
        .replace(/^[\s*\-・‐–—•>]+/, "") // list markers
        .replace(/^\d+[.)、]\s*/, "") // "1. " / "1) "
        .replace(/^[^:：\n]{1,12}[:：]\s*/, "") // stray "ワタル: " speaker labels
        .trim(),
    )
    .filter(
      (l) =>
        l.length >= 6 &&
        !/^なし[。.]?$/.test(l) &&
        !/(こんにちは|よろしく|ありがとう|お疲れ|了解|承知)/.test(l),
    )
    .slice(0, MAX_FACTS_PER_COMPACTION);
}

/**
 * Compress old turns into the rolling summary.
 * - normal (force=false): only runs when history is over threshold; keeps the
 *   last KEEP_RECENT_TURNS turns verbatim.
 * - emergency (force=true): keeps only the last turn verbatim.
 * Returns null when there was nothing to compress.
 */
export async function compactConversation(
  force = false,
): Promise<CompactionResult | null> {
  await ensureLoaded();
  const s = store.state;

  const keepCount = force ? 2 : KEEP_RECENT_TURNS * 2;
  if (s.messages.length <= keepCount) return null;

  const older = s.messages.slice(0, s.messages.length - keepCount);
  const recent = s.messages.slice(s.messages.length - keepCount);

  const prior = s.summary ? `既存の要約:\n${s.summary}\n\n` : "";
  const newSummary = await summaryComplete(
    `${prior}追加の会話ログ:\n${transcriptOf(older)}\n\n` +
      "上記全体を、後で文脈として使えるように日本語で簡潔に要約してください。" +
      "重要な事実・決定・未解決事項は落とさないでください。箇条書き可。",
  );

  let factsSaved: string[] = [];
  try {
    const facts = await extractFacts(transcriptOf(older));
    for (const f of facts) {
      try {
        await addKnowledge(f, "auto");
        factsSaved.push(f);
      } catch {
        /* knowledge store hiccup - don't abort compression */
      }
    }
  } catch {
    factsSaved = [];
  }

  s.summary = newSummary || s.summary;
  s.messages = recent;
  s.compactions += 1;
  await persist();

  return {
    compactions: s.compactions,
    summarizedMessages: older.length,
    factsSaved,
    summary: s.summary,
  };
}

/** Run compression only if the verbatim history is over the token/turn budget. */
export async function maybeCompact(): Promise<CompactionResult | null> {
  await ensureLoaded();
  const s = store.state;
  const tokens = s.messages.reduce(
    (n, m) => n + approxTokenCount(m.content),
    0,
  );
  const overTokens = tokens > TRIGGER_TOKENS;
  const overCount = s.messages.length > KEEP_RECENT_TURNS * 2 + 4;
  if (!overTokens && !overCount) return null;
  return compactConversation(false);
}

export const conversationConfig = {
  triggerTokens: TRIGGER_TOKENS,
  keepRecentTurns: KEEP_RECENT_TURNS,
} as const;
