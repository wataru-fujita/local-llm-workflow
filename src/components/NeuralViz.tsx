"use client";

/**
 * Phase 6.5 - "a window into the pipeline".
 *
 * Local generation is slow, so the wait should be time you can spend turning a
 * 3D diagram around and learning how the pipeline actually works.
 *
 * Six modules, left → right, each an honest picture of that step's mechanism.
 * The presentation takes its cue from watching 3Blue1Brown - dark ground, few
 * but exact objects, things labelled in place, a consistent colour code, and
 * geometry that carries the meaning rather than decorating it. That reading is
 * ours, not a method 3Blue1Brown publishes. Depth is used where the idea is
 * genuinely 3D (a vector's direction, the cosine-similarity cone, the stack of
 * saved turns).
 *
 * Colour code, kept across every module:
 *   blue   = data flowing through      green = a computed result
 *   amber  = stored / remembered       cyan  = the step running right now
 *
 * Camera: zoomed in on the active module is the default; each stage change eases
 * the camera to the next module. The user can override any time - tap a module,
 * tap a tab, or the 拡大/俯瞰 button (which toggles a whole-pipeline overview).
 * A drag/pinch grabs the camera and the auto-follow yields until released.
 *
 * Explanatory animation, not a view of model internals (docs/01 4.6).
 */

import { useEffect, useRef, useState } from "react";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
// Side-effect: registers ray/picking implementations on Scene & Camera prototypes.
// ArcRotateCamera.attachControl routes pointer events through scene picking, which
// throws "Ray needs to be imported" in a tree-shaken build without this.
import "@babylonjs/core/Culling/ray";

export type VizStage =
  | "idle"
  | "input"
  | "embed"
  | "retrieve"
  | "prompt"
  | "generate"
  | "persist"
  | "compact"
  | "done";

export const STAGE_INFO: Record<VizStage, { ja: string; en: string }> = {
  idle: { ja: "待機", en: "idle" },
  input: { ja: "入力受付", en: "input" },
  embed: { ja: "ベクトル化", en: "embedding" },
  retrieve: { ja: "知識検索", en: "retrieval (RAG)" },
  prompt: { ja: "プロンプト構成", en: "prompt assembly" },
  generate: { ja: "応答生成", en: "generation" },
  persist: { ja: "履歴保存", en: "persist" },
  compact: { ja: "文脈圧縮", en: "context compaction" },
  done: { ja: "完了", en: "done" },
};
export const STAGE_LABEL: Record<VizStage, string> = Object.fromEntries(
  Object.entries(STAGE_INFO).map(([k, v]) => [k, v.ja]),
) as Record<VizStage, string>;

export const STAGE_LAYER: Record<VizStage, number> = {
  idle: -1,
  input: 0,
  embed: 1,
  retrieve: 2,
  prompt: 3,
  generate: 4,
  persist: 5,
  compact: 5,
  done: 5,
};

const MODULES = [
  {
    ja: "入力受付",
    en: "Input",
    desc: "文章を受け取り長さを測ります。文字の並びは、この先モデル側で「トークン」という塊に区切られます。",
  },
  {
    ja: "ベクトル化",
    en: "Embedding",
    desc: "bge-m3 が文章全体を 1024 個の数値にします。その数値の並びは空間の「矢印」1 本で、意味が近い文ほど矢印の向きが揃います。",
  },
  {
    ja: "知識検索",
    en: "Retrieval (RAG)",
    desc: "似ているかどうかは矢印どうしの「角度」で測ります（コサイン距離）。質問の矢印を軸にした円錐の内側＝しきい値内、そこから近い順に最大 3 件。",
  },
  {
    ja: "プロンプト構成",
    en: "Prompt assembly",
    desc: "採用した知識・過去の要約・直近の会話・質問を、この順に 1 本のトークン列としてつなぎ、文脈枠（num_ctx=4096）に収めます。",
  },
  {
    ja: "応答生成",
    en: "Generation",
    desc: "次に来るトークンの確率を全語彙ぶん計算し、選んだ 1 個を文脈の末尾に足して、また次を計算。この繰り返し（自己回帰）が最も時間を使います。",
  },
  {
    ja: "出力",
    en: "Output",
    desc: "できた文章を表示し、会話履歴に積みます。履歴が長くなりすぎたら古い部分を要約に圧縮します。",
  },
];

/** Module spacing - wide enough that a focused view isn't crowded by neighbours. */
const PITCH = 12;
const DIM = new Color3(0.13, 0.2, 0.36);
const DATA = new Color3(0.32, 0.6, 1.0); // blue - data
const RESULT = new Color3(0.42, 0.95, 0.62); // green - computed result
const STORED = new Color3(1.0, 0.72, 0.28); // amber - remembered
const LIVE = new Color3(0.6, 0.93, 1.0); // cyan - running now

const CAM_ALPHA = -Math.PI / 2 - 0.35;
const CAM_BETA = Math.PI / 2 - 0.16;
const OVERVIEW_R = 44;
/** Wide enough to frame a whole module (they span roughly y -2.9 … +2.3). */
const FOCUS_R = 10.5;

function parseNums(s: string | undefined): number[] {
  if (!s) return [];
  return (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

type Mats = {
  dim: StandardMaterial;
  data: StandardMaterial;
  result: StandardMaterial;
  stored: StandardMaterial;
  live: StandardMaterial;
};
type Upd = { dt: number; beat: number; active: boolean; done: boolean; nums: number[]; detail: string };
type Module = { update: (u: Upd) => void };
export type StageLogEntry = { stage: VizStage; ms?: number; detail?: string };

function emissive(scene: Scene, name: string, c: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = Color3.Black();
  m.emissiveColor = c.clone();
  m.disableLighting = true;
  return m;
}

/** A camera-facing text label - annotation sits on the thing it names. */
function label(
  scene: Scene,
  parent: TransformNode,
  text: string,
  pos: Vector3,
  scale = 1,
  colour = "#cfe8ff",
): Mesh {
  const dt = new DynamicTexture(`lbl${text}`, { width: 256, height: 64 }, scene, false);
  dt.hasAlpha = true;
  const ctx = dt.getContext();
  ctx.clearRect(0, 0, 256, 64);
  dt.drawText(text, null, 44, "bold 34px monospace", colour, "transparent", true);
  const mat = new StandardMaterial(`lblm${text}`, scene);
  mat.diffuseTexture = dt;
  mat.emissiveTexture = dt;
  mat.opacityTexture = dt;
  mat.disableLighting = true;
  mat.backFaceCulling = false;
  const plane = MeshBuilder.CreatePlane(`lblp${text}`, { width: 2 * scale, height: 0.5 * scale }, scene);
  plane.parent = parent;
  plane.position.copyFrom(pos);
  plane.material = mat;
  plane.billboardMode = 7; // BILLBOARDMODE_ALL - always faces the camera
  plane.isPickable = false;
  return plane;
}

/** An arrow (shaft + head) from the origin along `dir` - a vector, drawn as one. */
function arrow(scene: Scene, parent: TransformNode, name: string, mat: StandardMaterial) {
  const node = new TransformNode(name, scene);
  node.parent = parent;
  const shaft = MeshBuilder.CreateCylinder(`${name}s`, { diameter: 0.07, height: 1 }, scene);
  shaft.parent = node;
  shaft.material = mat;
  const head = MeshBuilder.CreateCylinder(`${name}h`, { diameterTop: 0, diameterBottom: 0.24, height: 0.34 }, scene);
  head.parent = node;
  head.material = mat;
  /** Point the arrow along `dir`, its length being the vector's magnitude. */
  const set = (dir: Vector3) => {
    const len = Math.max(0.001, dir.length());
    shaft.scaling.y = len;
    shaft.position.set(0, len / 2, 0);
    head.position.set(0, len, 0);
    // Align the mesh's +Y axis with `dir` (yaw about Y, then pitch off vertical)
    const d = dir.normalizeToNew();
    node.rotation.set(
      Math.acos(Math.max(-1, Math.min(1, d.y))),
      Math.atan2(d.x, d.z),
      0,
    );
  };
  return { node, shaft, head, set, setMat: (m: StandardMaterial) => { shaft.material = m; head.material = m; } };
}

/** Faint coordinate axes, so directions in space read as directions. */
function axes(scene: Scene, parent: TransformNode, len = 1.6) {
  const col = new Color3(0.32, 0.42, 0.58);
  (
    [
      [new Vector3(-len, 0, 0), new Vector3(len, 0, 0)],
      [new Vector3(0, -len, 0), new Vector3(0, len, 0)],
      [new Vector3(0, 0, -len), new Vector3(0, 0, len)],
    ] as const
  ).forEach((pts, i) => {
    const l = MeshBuilder.CreateLines(`ax${parent.name}${i}`, { points: [...pts] }, scene);
    l.parent = parent;
    l.color = col;
    l.alpha = 0.5;
    l.isPickable = false;
  });
}

// ---------------------------------------------------------------------------
// 1. Input - characters arrive, get grouped into tokens
// ---------------------------------------------------------------------------
function buildInput(scene: Scene, root: TransformNode, mats: Mats): Module {
  // characters as small plates in a row
  const CH = 14;
  const chars = Array.from({ length: CH }, (_, i) => {
    const b = MeshBuilder.CreateBox(`ic${i}`, { width: 0.2, height: 0.5, depth: 0.08 }, scene);
    b.parent = root;
    b.position.set(-3 + i * 0.28, 0.9, 0);
    b.material = mats.data;
    return b;
  });
  // token groups below: brackets that gather 2-3 characters each
  const groups = [
    { from: 0, to: 2 },
    { from: 3, to: 5 },
    { from: 6, to: 7 },
    { from: 8, to: 11 },
    { from: 12, to: 13 },
  ];
  const toks = groups.map((g, i) => {
    const w = (g.to - g.from + 1) * 0.28;
    const b = MeshBuilder.CreateBox(`it${i}`, { width: w - 0.05, height: 0.5, depth: 0.5 }, scene);
    b.parent = root;
    b.position.set(-3 + ((g.from + g.to) / 2) * 0.28, -0.4, 0);
    b.material = mats.dim;
    return { mesh: b, i };
  });
  label(scene, root, "文字列", new Vector3(-3.6, 1.7, 0), 0.9);
  label(scene, root, "トークン", new Vector3(-3.4, -1.3, 0), 0.9);
  return {
    update({ active, done, beat }) {
      chars.forEach((c, i) => {
        c.material = active ? mats.live : done ? mats.data : mats.dim;
        c.visibility = active ? 0.6 + 0.4 * Math.sin(beat * 4 - i * 0.35) : done ? 0.6 : 0.3;
      });
      toks.forEach((t, i) => {
        // groups "snap" in one after another while the step runs
        const on = active ? (beat * 1.4 + i * 0.4) % 3 > 0.5 : done;
        t.mesh.material = on ? mats.result : mats.dim;
        t.mesh.visibility = on ? 0.95 : active || done ? 0.35 : 0.2;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Embedding - tokens → encoder → ONE vector, drawn as an arrow in space
// ---------------------------------------------------------------------------
function buildEmbed(scene: Scene, root: TransformNode, mats: Mats): Module {
  const toks = Array.from({ length: 5 }, (_, i) => {
    const b = MeshBuilder.CreateBox(`et${i}`, { size: 0.34 }, scene);
    b.parent = root;
    b.position.set(-3.4, (i - 2) * 0.5, 0);
    b.material = mats.data;
    return b;
  });
  // encoder: two layers with pulses (the only NN motif here)
  const cols: Vector3[][] = [4, 5].map((n, li) =>
    Array.from({ length: n }, (_, k) => {
      const p = new Vector3(-2.4 + li * 1.0, (k - (n - 1) / 2) * 0.55, 0);
      const s = MeshBuilder.CreateSphere(`en${li}_${k}`, { diameter: 0.22, segments: 8 }, scene);
      s.parent = root;
      s.position.copyFrom(p);
      s.material = mats.dim;
      return p;
    }),
  );
  const encNodes = root.getChildMeshes().filter((m) => m.name.startsWith("en"));
  const edges: { from: Vector3; to: Vector3 }[] = [];
  cols[0].forEach((a, ai) =>
    cols[1].forEach((b, bi) => {
      if ((ai + bi) % 2 !== 0) return;
      const l = MeshBuilder.CreateLines(`ee${ai}_${bi}`, { points: [a, b] }, scene);
      l.parent = root;
      l.color = new Color3(0.22, 0.36, 0.62);
      l.alpha = 0.3;
      l.isPickable = false;
      edges.push({ from: a, to: b });
    }),
  );
  const pulses = Array.from({ length: 5 }, (_, i) => {
    const m = MeshBuilder.CreateSphere(`ep${i}`, { diameter: 0.2, segments: 6 }, scene);
    m.parent = root;
    m.material = mats.live;
    return { mesh: m, edge: edges[i % edges.length], t: Math.random(), spd: 0.9 + Math.random() * 0.5 };
  });
  // the vector itself: a column of numbers (bars)
  const NB = 12;
  const bars = Array.from({ length: NB }, (_, i) => {
    const b = MeshBuilder.CreateBox(`eb${i}`, { width: 0.9, height: 0.12, depth: 0.12 }, scene);
    b.parent = root;
    b.position.set(-0.4, (i - (NB - 1) / 2) * 0.19, 0);
    b.material = mats.result;
    return { mesh: b, seed: Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1 };
  });
  label(scene, root, "1024個の数値", new Vector3(-0.4, 1.5, 0), 1.0, "#6bf29e");
  // and the same thing as a direction in space
  const space = new TransformNode("espace", scene);
  space.parent = root;
  space.position.set(2.6, 0, 0);
  axes(scene, space, 1.5);
  const vec = arrow(scene, space, "evec", mats.result);
  const near = arrow(scene, space, "enear", mats.stored);
  label(scene, space, "意味の空間", new Vector3(0, -1.9, 0), 0.9);
  return {
    update({ dt, active, done, beat }) {
      toks.forEach((t, i) => {
        t.material = active ? mats.live : mats.data;
        t.visibility = active ? 0.55 + 0.4 * Math.sin(beat * 4 - i) : done ? 0.45 : 0.25;
      });
      encNodes.forEach((n) => (n.material = active || done ? mats.data : mats.dim));
      pulses.forEach((p) => {
        p.t += dt * p.spd * (active ? 1 : 0.12);
        if (p.t >= 1) {
          p.t -= 1;
          p.edge = edges[Math.floor(Math.random() * edges.length)];
        }
        Vector3.LerpToRef(p.edge.from, p.edge.to, p.t, p.mesh.position);
        p.mesh.visibility = active ? 1 : 0.12;
        p.mesh.scaling.setAll(0.6 + Math.sin(p.t * Math.PI) * 0.6);
      });
      bars.forEach((b) => {
        const v = active ? 0.25 + 0.75 * Math.abs(Math.sin(b.seed * 9 + beat * 2)) : 0.25 + 0.75 * b.seed;
        b.mesh.scaling.x = 0.25 + v * 1.6;
        b.mesh.position.x = -0.9 + (b.mesh.scaling.x * 0.9) / 2;
        b.mesh.visibility = active ? 1 : done ? 0.75 : 0.15;
      });
      const wob = active ? Math.sin(beat * 0.8) * 0.12 : 0;
      vec.set(new Vector3(0.9 + wob, 1.0, 0.55));
      near.set(new Vector3(1.05, 0.82 + wob, 0.75));
      vec.node.setEnabled(active || done);
      near.node.setEnabled(active || done);
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Retrieval - cosine similarity is an ANGLE, so the threshold is a CONE
// ---------------------------------------------------------------------------
function buildRetrieve(scene: Scene, root: TransformNode, mats: Mats): Module {
  axes(scene, root, 2.2);
  const query = arrow(scene, root, "rq", mats.result);
  const qDir = new Vector3(1.0, 0.85, 0.5).normalize().scale(2.0);
  query.set(qDir);
  label(scene, root, "質問", new Vector3(1.9, 1.5, 0.9), 0.8, "#6bf29e");

  // threshold cone around the query direction (cosine distance ≤ 0.75)
  const cone = MeshBuilder.CreateCylinder("rcone", { diameterTop: 2.6, diameterBottom: 0, height: 2.0, tessellation: 28 }, scene);
  cone.parent = root;
  const coneMat = emissive(scene, "rconem", new Color3(0.25, 0.55, 0.8));
  coneMat.wireframe = true;
  coneMat.alpha = 0.3;
  cone.material = coneMat;
  cone.isPickable = false;
  {
    const d = qDir.normalizeToNew();
    cone.rotation.set(Math.acos(Math.max(-1, Math.min(1, d.y))), Math.atan2(d.x, d.z), 0);
    cone.position.copyFrom(d.scale(1.0));
  }
  label(scene, root, "しきい値 0.75", new Vector3(-2.4, 1.9, 1.2), 0.85);

  // stored knowledge vectors: three inside the cone, several outside
  const dirs = [
    new Vector3(1.05, 0.9, 0.42), // in
    new Vector3(0.9, 0.95, 0.62), // in
    new Vector3(1.1, 0.72, 0.6), // in
    new Vector3(-0.9, 0.6, 1.0),
    new Vector3(0.2, -1.0, 0.9),
    new Vector3(-1.0, -0.4, -0.7),
    new Vector3(0.5, 0.2, -1.1),
  ];
  const stored = dirs.map((d, i) => {
    const a = arrow(scene, root, `rs${i}`, mats.dim);
    a.set(d.normalizeToNew().scale(1.7));
    return { a, inside: i < 3 };
  });
  label(scene, root, "保存済み知識", new Vector3(-1.2, -2.4, -0.6), 0.85, "#ffb84d");
  return {
    update({ active, done, beat, nums }) {
      const hits = active || done ? Math.max(0, Math.min(3, Math.round(nums[0] ?? 0))) : 0;
      query.setMat(active ? mats.live : mats.result);
      query.node.setEnabled(true);
      cone.visibility = active ? 0.85 : done ? 0.35 : 0.15;
      cone.rotation.y += 0.0;
      let hitSeen = 0;
      stored.forEach((s) => {
        const on = s.inside && hitSeen < hits;
        if (on) hitSeen++;
        s.a.setMat(on ? mats.stored : mats.dim);
        s.a.node.scaling.setAll(on && active ? 1.06 + Math.sin(beat * 6) * 0.05 : 1);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Prompt assembly - the parts become ONE token strip inside the context box
// ---------------------------------------------------------------------------
function buildPrompt(scene: Scene, root: TransformNode): Module {
  // context window as a labelled wireframe box the strip must fit inside
  const box = MeshBuilder.CreateBox("pbox", { width: 6.4, height: 1.1, depth: 1.1 }, scene);
  box.parent = root;
  const boxMat = emissive(scene, "pboxm", new Color3(0.3, 0.45, 0.7));
  boxMat.wireframe = true;
  boxMat.alpha = 0.45;
  box.material = boxMat;
  box.isPickable = false;
  label(scene, root, "文脈枠 4096", new Vector3(0, 1.2, 0), 1.0);

  const parts = [
    { c: STORED, w: 1.5, name: "知識" },
    { c: new Color3(0.8, 0.6, 1.0), w: 1.1, name: "要約" },
    { c: DATA, w: 2.4, name: "履歴" },
    { c: LIVE, w: 1.0, name: "質問" },
  ];
  let cursor = -3.1;
  const segs = parts.map((p, i) => {
    const b = MeshBuilder.CreateBox(`pp${i}`, { width: p.w, height: 0.85, depth: 0.85 }, scene);
    b.parent = root;
    b.material = emissive(scene, `ppm${i}`, p.c);
    const homeX = cursor + p.w / 2;
    cursor += p.w + 0.05;
    label(scene, root, p.name, new Vector3(homeX, -1.15, 0), 0.85);
    return { mesh: b, homeX, fromZ: -3 - i * 0.9 };
  });
  return {
    update({ dt, active, done, beat, nums }) {
      const msgs = active || done ? Math.max(2, Math.min(4, Math.round(nums[0] ?? 4))) : 4;
      box.visibility = active ? 0.7 : done ? 0.4 : 0.2;
      segs.forEach((s, i) => {
        const placed = i < msgs && (active || done);
        const tz = placed ? 0 : s.fromZ;
        s.mesh.position.x = s.homeX;
        s.mesh.position.z += (tz - s.mesh.position.z) * Math.min(dt * 3, 1);
        s.mesh.visibility = i < msgs ? (active ? 0.85 + Math.sin(beat * 4 + i) * 0.15 : done ? 0.8 : 0.28) : 0.06;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Generation - next-token probabilities → pick one → append → repeat
// ---------------------------------------------------------------------------
function buildGenerate(scene: Scene, root: TransformNode, mats: Mats): Module {
  // context strip that grows as tokens are appended
  const SLOTS = 14;
  const slots = Array.from({ length: SLOTS }, (_, i) => {
    const b = MeshBuilder.CreateBox(`gs${i}`, { width: 0.34, height: 0.34, depth: 0.34 }, scene);
    b.parent = root;
    b.position.set(-2.4 + i * 0.38, -2.1, 0);
    b.material = mats.dim;
    return b;
  });
  label(scene, root, "文脈（トークン列）", new Vector3(-1.6, -2.7, 0), 1.0);

  // transformer stack
  const LY = 4;
  const nodes: Vector3[][] = [];
  for (let l = 0; l < LY; l++) {
    const row: Vector3[] = [];
    for (let g = 0; g < 4; g++) {
      const p = new Vector3(-1.9 + g * 0.62, -0.9 + l * 0.62, 0);
      const s = MeshBuilder.CreateSphere(`gn${l}_${g}`, { diameter: 0.22, segments: 6 }, scene);
      s.parent = root;
      s.position.copyFrom(p);
      s.material = mats.dim;
      row.push(p);
    }
    nodes.push(row);
  }
  const stackNodes = root.getChildMeshes().filter((m) => m.name.startsWith("gn"));
  const edges: { from: Vector3; to: Vector3 }[] = [];
  for (let l = 0; l < LY - 1; l++)
    nodes[l].forEach((a, ai) =>
      nodes[l + 1].forEach((b, bi) => {
        if ((ai + bi) % 2 !== 0) return;
        const line = MeshBuilder.CreateLines(`ge${l}_${ai}_${bi}`, { points: [a, b] }, scene);
        line.parent = root;
        line.color = new Color3(0.24, 0.38, 0.64);
        line.alpha = 0.28;
        line.isPickable = false;
        edges.push({ from: a, to: b });
      }),
    );
  const pulses = Array.from({ length: 6 }, (_, i) => {
    const m = MeshBuilder.CreateSphere(`gp${i}`, { diameter: 0.2, segments: 6 }, scene);
    m.parent = root;
    m.material = mats.live;
    return { mesh: m, edge: edges[i % edges.length], t: Math.random(), spd: 1 + Math.random() * 0.5 };
  });
  label(scene, root, "Transformer", new Vector3(-1.2, 1.5, 0), 1.0);

  // probability bars over candidate next tokens - the actual output of the model
  const NB = 7;
  const bars = Array.from({ length: NB }, (_, i) => {
    const b = MeshBuilder.CreateBox(`gb${i}`, { width: 0.26, height: 1, depth: 0.26 }, scene);
    b.parent = root;
    b.position.set(1.4 + i * 0.34, 0, 0);
    b.material = mats.data;
    return { mesh: b, p: 0.1 };
  });
  label(scene, root, "次トークンの確率", new Vector3(2.5, 1.9, 0), 1.1);

  const flying = MeshBuilder.CreateBox("gfly", { size: 0.34 }, scene);
  flying.parent = root;
  flying.material = mats.result;
  flying.visibility = 0;

  let filled = 4;
  let phase = 0; // 0..1 compute, 1..2 fly to strip
  let best = 0;
  const roll = () => {
    let s = 0;
    bars.forEach((b) => {
      b.p = Math.random() ** 2;
      s += b.p;
    });
    bars.forEach((b) => (b.p /= s || 1));
    best = bars.reduce((m, b, i) => (b.p > bars[m].p ? i : m), 0);
  };
  roll();

  return {
    update({ dt, active, done, beat, nums }) {
      stackNodes.forEach((n) => (n.material = active || done ? mats.data : mats.dim));
      pulses.forEach((p) => {
        p.t += dt * p.spd * (active ? 1 : 0.1);
        if (p.t >= 1) {
          p.t -= 1;
          p.edge = edges[Math.floor(Math.random() * edges.length)];
        }
        Vector3.LerpToRef(p.edge.from, p.edge.to, p.t, p.mesh.position);
        p.mesh.visibility = active ? 1 : 0.1;
      });

      const tps = nums[1] ?? 8;
      if (active) phase += dt * Math.max(0.5, Math.min(3.2, tps / 8));
      bars.forEach((b, i) => {
        const h = 0.15 + b.p * 2.6;
        b.mesh.scaling.y = h;
        b.mesh.position.y = h / 2 - 0.6;
        b.mesh.material = i === best && active ? mats.result : mats.data;
        b.mesh.visibility = active ? 1 : done ? 0.4 : 0.12;
      });

      if (active && phase >= 1) {
        // the chosen token flies down and is appended to the context strip
        const u = Math.min(phase - 1, 1);
        const from = new Vector3(1.4 + best * 0.34, bars[best].mesh.position.y + 0.4, 0);
        const to = new Vector3(-2.4 + Math.min(filled, SLOTS - 1) * 0.38, -2.1, 0);
        Vector3.LerpToRef(from, to, u, flying.position);
        flying.position.y += Math.sin(u * Math.PI) * 0.8; // arc
        flying.visibility = 1;
        if (phase >= 2) {
          phase = 0;
          filled = Math.min(filled + 1, SLOTS);
          if (filled >= SLOTS) filled = 4;
          roll();
        }
      } else {
        flying.visibility = 0;
      }

      slots.forEach((s, i) => {
        const on = i < filled;
        s.material = on ? (i === filled - 1 && active ? mats.result : mats.data) : mats.dim;
        s.visibility = active || done ? (on ? 1 : 0.18) : 0.12;
        s.scaling.setAll(i === filled - 1 && active ? 1 + Math.sin(beat * 8) * 0.08 : 1);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 6. Output - reply shown, turn stacked into history, compaction badge
// ---------------------------------------------------------------------------
function buildOutput(scene: Scene, root: TransformNode, mats: Mats): Module {
  const panel = MeshBuilder.CreateBox("opnl", { width: 3.2, height: 1.9, depth: 0.12 }, scene);
  panel.parent = root;
  panel.position.set(0, 0.9, 0);
  panel.material = mats.data;
  // text lines on the panel
  const lines = Array.from({ length: 4 }, (_, i) => {
    const w = 2.4 - (i % 2) * 0.7;
    const b = MeshBuilder.CreateBox(`ol${i}`, { width: w, height: 0.12, depth: 0.06 }, scene);
    b.parent = root;
    b.position.set(-0.3 + (2.4 - w) / 2, 1.5 - i * 0.32, 0.1);
    b.material = mats.result;
    return b;
  });
  label(scene, root, "応答", new Vector3(0, 2.2, 0), 1.0, "#6bf29e");
  // history stack going back in depth = older turns
  const hist = Array.from({ length: 5 }, (_, i) => {
    const b = MeshBuilder.CreateBox(`oh${i}`, { width: 2.6, height: 0.16, depth: 1.3 }, scene);
    b.parent = root;
    b.position.set(0, -0.9 - i * 0.26, -0.25 - i * 0.3);
    b.material = mats.stored;
    return b;
  });
  label(scene, root, "会話履歴", new Vector3(-1.9, -1.4, 0), 0.95, "#ffb84d");
  const badge = MeshBuilder.CreateBox("obg", { size: 0.34 }, scene);
  badge.parent = root;
  badge.position.set(1.9, -1.5, 0.3);
  badge.material = emissive(scene, "obgm", new Color3(1, 0.55, 0.3));
  const badgeLbl = label(scene, root, "圧縮", new Vector3(1.9, -2.0, 0.3), 0.8, "#ff9a4d");
  return {
    update({ active, done, beat, detail }) {
      const grow = active ? 0.35 + 0.65 * Math.min(1, (Math.sin(beat * 2) + 1) / 2 + 0.3) : done ? 1 : 0.12;
      panel.scaling.y = grow;
      panel.material = active ? mats.live : done ? mats.data : mats.dim;
      panel.visibility = active || done ? 1 : 0.14;
      lines.forEach((l, i) => {
        l.visibility = active ? (Math.sin(beat * 3 - i * 0.8) + 1) / 2 : done ? 0.9 : 0;
      });
      hist.forEach((h, i) => {
        h.material = i === 0 && (active || done) ? mats.live : mats.stored;
        h.visibility = active || done ? (i === 0 ? 1 : 0.5 - i * 0.07) : 0.16;
      });
      const compacted = /要約/.test(detail) && !/不要/.test(detail);
      const v = compacted && (active || done) ? 0.6 + Math.sin(beat * 7) * 0.4 : 0;
      badge.visibility = v;
      badgeLbl.visibility = v;
    },
  };
}

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

export default function NeuralViz({
  stage = "idle",
  detail = "",
  log = [],
  height = 300,
}: {
  stage?: VizStage;
  detail?: string;
  log?: StageLogEntry[];
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<VizStage>(stage);
  const detailRef = useRef<string>(detail);

  // Zoomed in is the default: the camera rides the pipeline, framing whichever
  // module is running. 俯瞰 (overview) is a manual choice, and the next stage
  // change takes the camera back to the new active module.
  const [focus, setFocus] = useState<number | null>(
    STAGE_LAYER[stage] >= 0 ? STAGE_LAYER[stage] : null,
  );
  const [seenStage, setSeenStage] = useState<VizStage>(stage);
  if (stage !== seenStage) {
    setSeenStage(stage);
    const next = STAGE_LAYER[stage];
    if (next >= 0) setFocus(next);
  }
  const focusRef = useRef<number | null>(null);
  const transitionUntilRef = useRef(0);
  const pickRef = useRef<(i: number | null) => void>(() => {});

  useEffect(() => {
    pickRef.current = (i) => setFocus(i);
  }, []);

  useEffect(() => {
    stageRef.current = stage;
    detailRef.current = detail;
  }, [stage, detail]);

  useEffect(() => {
    focusRef.current = focus;
    transitionUntilRef.current = performance.now() + 1400;
  }, [focus]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // preserveDrawingBuffer keeps the frame readable after render, so the canvas
    // can be saved (右クリック→画像を保存 / toDataURL). Kept antialias on - the
    // diagram is mostly thin lines and needs the smoothing.
    const engine = new Engine(canvas, true, {
      antialias: true,
      preserveDrawingBuffer: true,
    });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 0);

    const moduleX = MODULES.map((_, i) => i * PITCH - ((MODULES.length - 1) * PITCH) / 2);

    const camera = new ArcRotateCamera("cam", CAM_ALPHA, CAM_BETA, OVERVIEW_R, new Vector3(0, 0, 0), scene);
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 4;
    camera.upperRadiusLimit = 80;
    camera.lowerBetaLimit = 0.15;
    camera.upperBetaLimit = Math.PI - 0.15;
    camera.panningSensibility = 600;
    camera.wheelPrecision = 24;
    camera.pinchPrecision = 50;
    camera.useNaturalPinchZoom = true;

    new HemisphericLight("l", new Vector3(0, 1, 0), scene).intensity = 0.2;
    const glow = new GlowLayer("glow", scene);
    glow.intensity = 0.7;

    const mats: Mats = {
      dim: emissive(scene, "m-dim", DIM),
      data: emissive(scene, "m-data", DATA),
      result: emissive(scene, "m-result", RESULT),
      stored: emissive(scene, "m-stored", STORED),
      live: emissive(scene, "m-live", LIVE),
    };

    const rail = MeshBuilder.CreateCylinder("rail", { diameter: 0.05, height: PITCH * (MODULES.length - 1) + 5 }, scene);
    rail.rotation.z = Math.PI / 2;
    rail.position.set(0, -3.8, 0);
    rail.material = mats.dim;
    rail.isPickable = false;
    const packet = MeshBuilder.CreateSphere("packet", { diameter: 0.45, segments: 12 }, scene);
    packet.material = mats.live;
    packet.position.set(moduleX[0], -3.8, 0);
    packet.isPickable = false;

    const builders = [buildInput, buildEmbed, buildRetrieve, buildPrompt, buildGenerate, buildOutput];
    const modules: Module[] = builders.map((build, i) => {
      const node = new TransformNode(`mod${i}`, scene);
      node.position.set(moduleX[i], 0, 0);
      return build(scene, node, mats);
    });

    // tap → focus the nearest module (screen-space; no Ray side-effect needed)
    let downX = 0;
    let downY = 0;
    let downT = 0;
    const onDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
      downT = performance.now();
    };
    const onUp = (e: PointerEvent) => {
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (moved > 12 || performance.now() - downT > 600) return;
      const viewport = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
      const transform = scene.getTransformMatrix();
      let best = 0;
      let bestD = Infinity;
      moduleX.forEach((x, i) => {
        const p = Vector3.Project(new Vector3(x, 0, 0), Matrix.Identity(), transform, viewport);
        const d = Math.hypot(p.x - scene.pointerX, p.y - scene.pointerY);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      pickRef.current(best);
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);

    let lastMs = performance.now();
    let beat = 0;

    engine.runRenderLoop(() => {
      const now = performance.now();
      const dt = Math.min((now - lastMs) / 1000, 0.05);
      lastMs = now;
      beat += dt;

      const s = stageRef.current;
      const nums = parseNums(detailRef.current);
      const activeIdx = STAGE_LAYER[s];

      modules.forEach((m, i) => {
        m.update({
          dt,
          beat,
          active: i === activeIdx,
          done: activeIdx >= 0 && i < activeIdx,
          nums: i === activeIdx ? nums : [],
          detail: i === activeIdx ? detailRef.current : "",
        });
      });

      const packetTargetX = activeIdx >= 0 ? moduleX[activeIdx] : moduleX[0];
      packet.position.x += (packetTargetX - packet.position.x) * Math.min(dt * 4, 1);
      packet.scaling.setAll(activeIdx >= 0 ? 1 + Math.sin(beat * 6) * 0.15 : 0.5);
      packet.visibility = activeIdx >= 0 ? 1 : 0.3;

      // Camera eases toward the framing for the current focus (a module, or the
      // whole pipeline). Always active, but yields the moment the user grabs it.
      const dragging =
        Math.abs(camera.inertialAlphaOffset) > 1e-4 ||
        Math.abs(camera.inertialBetaOffset) > 1e-4 ||
        Math.abs(camera.inertialRadiusOffset) > 1e-4 ||
        Math.abs(camera.inertialPanningX) > 1e-4 ||
        Math.abs(camera.inertialPanningY) > 1e-4;
      if (!dragging) {
        const f = focusRef.current;
        const tX = f == null ? 0 : moduleX[f];
        const tR = f == null ? OVERVIEW_R : FOCUS_R;
        const settling = now < transitionUntilRef.current;
        const k = Math.min(dt * (settling ? 3.2 : 1.4), 1);
        Vector3.LerpToRef(camera.target, new Vector3(tX, 0, 0), k, camera.target);
        camera.radius += (tR - camera.radius) * k;
        if (settling) {
          camera.alpha += (CAM_ALPHA - camera.alpha) * k * 0.5;
          camera.beta += (CAM_BETA - camera.beta) * k * 0.5;
        }
      }

      scene.render();
    });

    const ro = new ResizeObserver(() => engine.resize());
    ro.observe(canvas);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      ro.disconnect();
      engine.stopRenderLoop();
      scene.dispose();
      engine.dispose();
    };
  }, []);

  const activeIdx = STAGE_LAYER[stage];
  const shownIdx = focus ?? (activeIdx >= 0 ? activeIdx : 0);
  const mod = MODULES[shownIdx];
  const shownDetail =
    shownIdx === activeIdx
      ? detail
      : (log.find((l) => STAGE_LAYER[l.stage] === shownIdx)?.detail ?? "");
  const shownMs = log.find((l) => STAGE_LAYER[l.stage] === shownIdx)?.ms;

  return (
    <div
      className="viz-window relative w-full overflow-hidden rounded-xl border border-sky-500/25 bg-[#05070d] font-mono text-sky-100 shadow-[inset_0_0_50px_rgba(0,0,0,0.7)]"
      style={{ height }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between border-b border-sky-500/15 bg-black/45 px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-sky-300/80">
        <span>pipeline&nbsp;view</span>
        <span>
          {String(shownIdx + 1).padStart(2, "0")} / 06 · {mod.en}
        </span>
      </div>

      <canvas ref={canvasRef} className="h-full w-full" style={{ touchAction: "none" }} />

      <div className="pointer-events-none absolute left-3 top-9 z-10 max-w-[72%] text-[11px] leading-relaxed">
        <div className="text-sky-300">
          ▸ {mod.ja} <span className="text-sky-200/45">/ {mod.en}</span>
          {shownDetail ? <span className="text-sky-200/70"> — {shownDetail}</span> : null}
          {shownMs != null ? <span className="text-sky-200/50"> ({shownMs}ms)</span> : null}
        </div>
        <p className="mt-1 text-zinc-400">{mod.desc}</p>
      </div>

      <div className="absolute inset-x-0 bottom-0 z-10 flex divide-x divide-sky-500/10 border-t border-sky-500/15 bg-black/45 text-[10px]">
        {MODULES.map((m, i) => {
          const st = i === activeIdx ? "active" : i < activeIdx ? "done" : "wait";
          return (
            <button
              key={m.en}
              onClick={() => setFocus(i)}
              className={`flex-1 px-1 py-1.5 leading-tight transition-colors ${
                focus === i ? "bg-sky-500/20" : ""
              } ${st === "active" ? "text-sky-300" : st === "done" ? "text-sky-100/50" : "text-zinc-500"}`}
            >
              <span className="mr-1 text-[8px] opacity-60">
                {st === "done" ? "✓" : st === "active" ? "▶" : "·"}
              </span>
              {m.ja}
              <span className="block text-[8px] opacity-45">{m.en}</span>
            </button>
          );
        })}
      </div>

      <button
        onClick={() => setFocus(focus == null ? (activeIdx >= 0 ? activeIdx : 0) : null)}
        className="absolute right-2 top-9 z-10 rounded border border-sky-500/30 bg-black/50 px-2 py-0.5 text-[10px] text-sky-300"
      >
        {focus == null ? "拡大" : "俯瞰"}
      </button>
    </div>
  );
}
