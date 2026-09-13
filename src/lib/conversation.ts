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
import { PROMPT_BUDGET_TOKENS, summaryComplete } from "./ollama";
import { addKnowledge } from "./knowledge";
import { estimateMessageTokens, estimateTokens } from "./tokens";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "conversation.json");

/** Compression thresholds (env-tunable). */
const TRIGGER_TOKENS = Number(process.env.CONVO_COMPRESS_TRIGGER_TOKENS ?? 1400);
const KEEP_RECENT_TURNS = Number(process.env.CONVO_KEEP_RECENT_TURNS ?? 4);
/**
 * Ceiling on the rolling summary itself. Without one it grew every compaction
 * (10 compactions had produced a 3424-character summary - larger than half the
 * whole context window) while `maybeCompact` did not count it at all, so each
 * compaction made the real prompt bigger rather than smaller.
 */
const MAX_SUMMARY_TOKENS = Number(
  process.env.CONVO_MAX_SUMMARY_TOKENS ?? Math.floor(PROMPT_BUDGET_TOKENS * 0.3),
);
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

/**
 * Token estimate for one string. Delegates to the script-aware, self-calibrating
 * estimator; the old `length / 3` here under-counted Japanese by ~1.7x, which is
 * what let the prompt overflow the context window unnoticed.
 */
export function approxTokenCount(text: string): number {
  return estimateTokens(text);
}

/** Tokens the rolling summary costs when sent, or 0 when there is none. */
function summaryTokens(state: ConversationState): number {
  return state.summary ? estimateTokens(state.summary) : 0;
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

// `getPromptMessages()` used to live here: summary + trailing history, with no
// notion of a token budget. That is exactly how the prompt came to overflow the
// context window unnoticed, so it has been replaced by `buildPrompt()` below,
// which fits the prompt to the budget before the model ever sees it.

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

  s.summary = await capSummary(newSummary || s.summary);
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

/**
 * Re-summarise the rolling summary when it outgrows its ceiling, so it cannot
 * creep up on the context budget compaction after compaction.
 */
async function capSummary(summary: string): Promise<string> {
  return capSummaryTo(summary, MAX_SUMMARY_TOKENS);
}

/**
 * Run compression when what we would actually *send* is over budget.
 *
 * The old version summed only `state.messages`, ignoring the rolling summary
 * that every prompt always carries. Since the summary grew with every
 * compaction, compaction reported progress while the real prompt kept growing.
 */
export async function maybeCompact(): Promise<CompactionResult | null> {
  await ensureLoaded();
  const s = store.state;
  const tokens =
    s.messages.reduce((n, m) => n + approxTokenCount(m.content), 0) +
    summaryTokens(s);
  const overTokens = tokens > TRIGGER_TOKENS;
  const overCount = s.messages.length > KEEP_RECENT_TURNS * 2 + 4;
  if (!overTokens && !overCount) return null;
  return compactConversation(false);
}

export type PromptBuild = {
  messages: ChatMessage[];
  /** Estimated size of `messages`, already inside the budget. */
  estimatedTokens: number;
  budgetTokens: number;
  /** Verbatim messages dropped to make it fit. */
  droppedMessages: number;
  /** Reference entries dropped to make it fit. */
  droppedPrefix: number;
  /** Compaction run *before* generating, if one was needed. */
  compaction: CompactionResult | null;
};

/**
 * Assemble the prompt so that it provably fits the budget *before* generating.
 *
 * This is the fix for answers being cut off: previously the prompt was built
 * blind, compaction ran only *after* the reply, and Ollama silently trimmed the
 * overflow off the front of the prompt while the answer competed with the
 * prompt for the same window. Now the prompt is fitted first, and whatever is
 * left of the window belongs to the answer alone.
 *
 * Order of sacrifice, least to most costly: compact old turns -> drop the
 * oldest verbatim turns -> shrink the summary -> drop the weakest RAG hits.
 */
export async function buildPrompt(opts: {
  userMessage: string;
  /** Reference material (RAG), most relevant first. */
  prefix?: ChatMessage[];
  budgetTokens?: number;
}): Promise<PromptBuild> {
  await ensureLoaded();
  const budget = opts.budgetTokens ?? PROMPT_BUDGET_TOKENS;
  let prefix = [...(opts.prefix ?? [])];
  let compaction: CompactionResult | null = null;
  let droppedMessages = 0;

  const userMsg: ChatMessage = { role: "user", content: opts.userMessage };

  const assemble = (history: ChatMessage[]): ChatMessage[] => [
    ...prefix,
    ...(store.state.summary
      ? [
          {
            role: "system" as const,
            content: `これまでの会話の要約:\n${store.state.summary}`,
          },
        ]
      : []),
    ...history,
    userMsg,
  ];

  let history = store.state.messages.slice(-MAX_MESSAGES_IN_PROMPT);
  let messages = assemble(history);

  // 1. Over budget? Fold the old turns into the summary first - that is what
  //    compaction is for, and it keeps the information rather than dropping it.
  if (estimateMessageTokens(messages) > budget) {
    compaction = await compactConversation(false);
    if (compaction) {
      history = store.state.messages.slice(-MAX_MESSAGES_IN_PROMPT);
      messages = assemble(history);
    }
  }

  // 2. Still over? Drop the oldest verbatim messages, always keeping the last
  //    exchange so the model can at least follow the immediate thread.
  while (estimateMessageTokens(messages) > budget && history.length > 2) {
    history = history.slice(1);
    droppedMessages++;
    messages = assemble(history);
  }

  // 3. Still over? The summary is now the biggest movable block.
  if (estimateMessageTokens(messages) > budget && store.state.summary) {
    const withoutSummary = [...prefix, ...history, userMsg];
    const room = Math.max(120, budget - estimateMessageTokens(withoutSummary));
    const shrunk = await capSummaryTo(store.state.summary, room);
    if (shrunk !== store.state.summary) {
      store.state.summary = shrunk;
      await persist();
      messages = assemble(history);
    }
  }

  // 4. Still over? Give up reference material, weakest first.
  let droppedPrefix = 0;
  while (estimateMessageTokens(messages) > budget && prefix.length > 0) {
    prefix = prefix.slice(0, -1);
    droppedPrefix++;
    messages = assemble(history);
  }

  return {
    messages,
    estimatedTokens: estimateMessageTokens(messages),
    budgetTokens: budget,
    droppedMessages,
    droppedPrefix,
    compaction,
  };
}

/** Shrink a summary to roughly `targetTokens`, preferring a real re-summary. */
async function capSummaryTo(summary: string, targetTokens: number): Promise<string> {
  if (!summary || estimateTokens(summary) <= targetTokens) return summary;
  try {
    const tighter = await summaryComplete(
      "次の要約を、重要な事実・決定・未解決事項を落とさずに日本語で凝縮してください。\n" +
        `全体で日本語 ${Math.max(80, Math.floor(targetTokens * 1.5))} 文字以内。箇条書き可。\n\n` +
        summary,
    );
    if (tighter && estimateTokens(tighter) <= targetTokens) return tighter;
  } catch {
    /* fall through */
  }
  const keepChars = Math.max(150, Math.floor(targetTokens * 1.5));
  return `（前略）${summary.slice(-keepChars)}`;
}

export const conversationConfig = {
  triggerTokens: TRIGGER_TOKENS,
  keepRecentTurns: KEEP_RECENT_TURNS,
  maxSummaryTokens: MAX_SUMMARY_TOKENS,
  promptBudgetTokens: PROMPT_BUDGET_TOKENS,
} as const;
