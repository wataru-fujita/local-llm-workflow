/**
 * Long-term knowledge store (phase 3): LanceDB-backed vector search.
 *
 * Embedded DB, no separate server (docs/02_調査結果.md). Data lives in
 * `data/lancedb/`. One table, `knowledge`, created lazily on first insert so we
 * don't have to hand-write an Arrow schema.
 *
 * Phase 4 will also write to this store (moving durable facts out of the
 * conversation during compression).
 */

import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { embed } from "./embeddings";

const DB_DIR = path.join(process.cwd(), "data", "lancedb");
const TABLE = "knowledge";

/** Retrieval knobs. Cosine distance = 1 - cosine similarity, so lower is closer. */
const TOP_K = 3;
const MAX_DISTANCE = 0.75;

export type KnowledgeRow = {
  text: string;
  source: string;
  createdAt: string;
};

export type KnowledgeHit = KnowledgeRow & { distance: number };

// Reuse one connection across requests / HMR reloads.
const globalDb = globalThis as unknown as {
  __lancedb?: Promise<lancedb.Connection>;
};
function db(): Promise<lancedb.Connection> {
  return (globalDb.__lancedb ??= lancedb.connect(DB_DIR));
}

async function tableExists(conn: lancedb.Connection): Promise<boolean> {
  const names = await conn.tableNames();
  return names.includes(TABLE);
}

/** Add one piece of knowledge. Creates the table on first call. */
export async function addKnowledge(
  text: string,
  source = "manual",
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty knowledge text");

  const vector = await embed(trimmed);
  const row = {
    vector,
    text: trimmed,
    source,
    createdAt: new Date().toISOString(),
  };

  const conn = await db();
  if (await tableExists(conn)) {
    const tbl = await conn.openTable(TABLE);
    await tbl.add([row]);
  } else {
    await conn.createTable(TABLE, [row]);
  }
}

/**
 * Vector search against an already-computed embedding. Split out from
 * `searchKnowledge` so callers that want to report "embedding" and "searching"
 * as separate pipeline stages can time them independently.
 * Returns [] when the store is empty.
 */
export async function searchKnowledgeByVector(
  vector: number[],
  k = TOP_K,
): Promise<KnowledgeHit[]> {
  const conn = await db();
  if (!(await tableExists(conn))) return [];

  const tbl = await conn.openTable(TABLE);
  const rows = (await tbl
    .vectorSearch(vector)
    .distanceType("cosine")
    .limit(k)
    .toArray()) as Array<KnowledgeRow & { _distance: number }>;

  return rows
    .map((r) => ({
      text: r.text,
      source: r.source,
      createdAt: r.createdAt,
      distance: r._distance,
    }))
    .filter((r) => r.distance <= MAX_DISTANCE);
}

/** Semantic search from raw text (embeds, then searches). */
export async function searchKnowledge(
  query: string,
  k = TOP_K,
): Promise<KnowledgeHit[]> {
  const vector = await embed(query.trim());
  return searchKnowledgeByVector(vector, k);
}

/** All stored rows, newest first (capped). For the admin/knowledge panel. */
export async function listKnowledge(limit = 200): Promise<KnowledgeRow[]> {
  const conn = await db();
  if (!(await tableExists(conn))) return [];

  const tbl = await conn.openTable(TABLE);
  const rows = (await tbl.query().limit(limit).toArray()) as Array<
    KnowledgeRow & Record<string, unknown>
  >;
  return rows
    .map((r) => ({ text: r.text, source: r.source, createdAt: r.createdAt }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function knowledgeCount(): Promise<number> {
  const conn = await db();
  if (!(await tableExists(conn))) return 0;
  const tbl = await conn.openTable(TABLE);
  return tbl.countRows();
}

/** Wipe the whole store. */
export async function clearKnowledge(): Promise<void> {
  const conn = await db();
  if (await tableExists(conn)) await conn.dropTable(TABLE);
}

/** Retrieval settings, surfaced so the in-app manual can't drift from the code. */
export const knowledgeConfig = { topK: TOP_K, maxDistance: MAX_DISTANCE } as const;
