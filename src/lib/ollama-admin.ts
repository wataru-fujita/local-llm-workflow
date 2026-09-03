/**
 * Ollama health + restart helpers (phase 5, admin panel).
 *
 * `restartOllama()` shells out (child_process). This is a local, single-user
 * home app; phase 6 puts it behind auth. The command is fixed or taken from
 * OLLAMA_RESTART_CMD - nothing from the HTTP request reaches the shell.
 */

import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";

const exec = promisify(execCb);

const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const SLOW_MS = 1500;

/**
 * Default: kill the server AND its `llama-server` model workers, then let the
 * Ollama tray app respawn a clean `ollama serve`. The workers MUST be killed
 * too - a force-kill of just `ollama.exe` orphans them and they keep holding
 * their model's VRAM, so the next model load OOMs on an 8GB GPU.
 * The tray app ("ollama app") is left running so it does the respawn.
 */
const RESTART_CMD =
  process.env.OLLAMA_RESTART_CMD ??
  'powershell -NoProfile -Command "Get-Process ollama,llama-server,ollama_llama_server -ErrorAction SilentlyContinue | Stop-Process -Force"';
const OLLAMA_BIN =
  process.env.OLLAMA_BIN ??
  `${process.env.LOCALAPPDATA ?? ""}\\Programs\\Ollama\\ollama.exe`;

export type LoadedModel = { name: string; vramMB: number };
export type OllamaHealth = {
  status: "ok" | "slow" | "down";
  latencyMs: number | null;
  models: LoadedModel[];
  checkedAt: string;
  error?: string;
};

export async function checkHealth(): Promise<OllamaHealth> {
  const checkedAt = new Date().toISOString();
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      return {
        status: "down",
        latencyMs,
        models: [],
        checkedAt,
        error: `HTTP ${res.status}`,
      };
    }

    let models: LoadedModel[] = [];
    try {
      const ps = await fetch(`${BASE_URL}/api/ps`, {
        signal: AbortSignal.timeout(5000),
      });
      if (ps.ok) {
        const d = (await ps.json()) as {
          models?: { name: string; size_vram?: number }[];
        };
        models = (d.models ?? []).map((m) => ({
          name: m.name,
          vramMB: Math.round((m.size_vram ?? 0) / 1e6),
        }));
      }
    } catch {
      /* ps is best-effort */
    }

    return {
      status: latencyMs > SLOW_MS ? "slow" : "ok",
      latencyMs,
      models,
      checkedAt,
    };
  } catch (err) {
    return {
      status: "down",
      latencyMs: null,
      models: [],
      checkedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function waitUntilUp(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) return true;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export type RestartResult = {
  ok: boolean;
  steps: string[];
  health: OllamaHealth;
};

export async function restartOllama(): Promise<RestartResult> {
  const steps: string[] = [];

  try {
    await exec(RESTART_CMD, { timeout: 15000, windowsHide: true });
    steps.push("停止コマンドを実行しました。");
  } catch {
    // Stop-Process throws when there was nothing to stop - that's fine.
    steps.push("停止コマンドを実行しました（対象プロセスなし、または既に停止）。");
  }

  if (await waitUntilUp(12000)) {
    steps.push("サーバーが自動復帰しました。");
    return { ok: true, steps, health: await checkHealth() };
  }

  // Tray app didn't respawn it - start the server ourselves, detached.
  try {
    await exec(
      `powershell -NoProfile -Command "Start-Process -FilePath '${OLLAMA_BIN}' -ArgumentList 'serve' -WindowStyle Hidden"`,
      { timeout: 10000, windowsHide: true },
    );
    steps.push(`\`ollama serve\` を起動しました（${OLLAMA_BIN}）。`);
  } catch (err) {
    steps.push(
      `\`ollama serve\` の起動に失敗: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const up = await waitUntilUp(15000);
  steps.push(up ? "サーバーが応答しました。" : "サーバーがまだ応答しません。");
  return { ok: up, steps, health: await checkHealth() };
}
