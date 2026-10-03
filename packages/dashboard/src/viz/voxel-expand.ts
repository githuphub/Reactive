// TODO(merge): use @liveforge/protocol expandVoxelPlan (K6). This is a small local stand-in so the Builds panel can
// preview plans before K6 merges: same ops and ordering rules as spec §3, minus K6's alias table and clamps.
import type { VoxelPlanLike } from "../api/brain";

export interface VoxelBlock {
  x: number;
  y: number;
  z: number;
  block: string;
}

export interface ExpandedPlanLike {
  blocks: VoxelBlock[];
  materials: Record<string, number>;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  warnings: string[];
}

type V3 = [number, number, number];
type Op = Record<string, unknown>;

const MAX_BLOCKS = 4000;
const MAX_OPS = 200;

const v3 = (v: unknown, d: V3 = [0, 0, 0]): V3 =>
  Array.isArray(v) && v.length >= 3 ? [Math.round(Number(v[0]) || 0), Math.round(Number(v[1]) || 0), Math.round(Number(v[2]) || 0)] : d;
const lo = (a: V3, b: V3): V3 => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
const hi = (a: V3, b: V3): V3 => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];

/** Deterministic expansion: last write wins; ordered by layer, structure before details, air after solids. */
export function expandVoxelPlan(plan: VoxelPlanLike): ExpandedPlanLike {
  const palette = plan.palette ?? {};
  const first = Object.values(palette)[0] ?? "stone";
  const resolve = (b: unknown): string => {
    const k = typeof b === "string" && b ? b : first;
    return palette[k] ?? k;
  };
  const cells = new Map<string, { x: number; y: number; z: number; block: string; detail: boolean; seq: number }>();
  const warnings: string[] = [];
  let seq = 0;
  let opCount = 0;
  const put = (x: number, y: number, z: number, block: string, detail = false) => {
    if (cells.size >= MAX_BLOCKS && !cells.has(`${x},${y},${z}`)) return;
    cells.set(`${x},${y},${z}`, { x, y, z, block, detail, seq: seq++ });
  };
  const box = (a: V3, b: V3, block: string, test?: (x: number, y: number, z: number, mn: V3, mx: V3) => boolean, detail = false) => {
    const mn = lo(a, b);
    const mx = hi(a, b);
    for (let y = mn[1]; y <= mx[1]; y++) for (let x = mn[0]; x <= mx[0]; x++) for (let z = mn[2]; z <= mx[2]; z++) {
      if (!test || test(x, y, z, mn, mx)) put(x, y, z, block, detail);
    }
  };

  const run = (ops: Op[], off: V3, mirror: ((p: V3) => V3) | null) => {
    for (const op of ops) {
      if (++opCount > MAX_OPS) {
        if (opCount === MAX_OPS + 1) warnings.push(`more than ${MAX_OPS} ops after repeat: the rest were skipped`);
        return;
      }
      const at = (p: V3): V3 => {
        const q: V3 = [p[0] + off[0], p[1] + off[1], p[2] + off[2]];
        return mirror ? mirror(q) : q;
      };
      const block = resolve(op.block);
      const kind = String(op.op ?? "");
      switch (kind) {
        case "box":
          box(at(v3(op.from)), at(v3(op.to)), block);
          break;
        case "fill_air":
          box(at(v3(op.from)), at(v3(op.to)), "air");
          break;
        case "hollow_box":
          box(at(v3(op.from)), at(v3(op.to)), block, (x, y, z, mn, mx) => x === mn[0] || x === mx[0] || y === mn[1] || y === mx[1] || z === mn[2] || z === mx[2]);
          break;
        case "edges":
          box(at(v3(op.from)), at(v3(op.to)), block, (x, y, z, mn, mx) => Number(x === mn[0] || x === mx[0]) + Number(y === mn[1] || y === mx[1]) + Number(z === mn[2] || z === mx[2]) >= 2);
          break;
        case "line": {
          const a = at(v3(op.from));
          const b = at(v3(op.to));
          const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]), 1);
          for (let i = 0; i <= n; i++) put(Math.round(a[0] + ((b[0] - a[0]) * i) / n), Math.round(a[1] + ((b[1] - a[1]) * i) / n), Math.round(a[2] + ((b[2] - a[2]) * i) / n), block);
          break;
        }
        case "cylinder": {
          const c = at(v3(op.center));
          const r = Math.max(1, Math.round(Number(op.radius) || 2));
          const ht = Math.max(1, Math.round(Number(op.height) || 3));
          for (let y = 0; y < ht; y++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
            const d2 = dx * dx + dz * dz;
            if (d2 > r * r + r * 0.8) continue;
            if (op.hollow && d2 < (r - 1) * (r - 1) + (r - 1) * 0.8 && y > 0) continue;
            put(c[0] + dx, c[1] + y, c[2] + dz, block);
          }
          break;
        }
        case "sphere": {
          const c = at(v3(op.center));
          const r = Math.max(1, Math.round(Number(op.radius) || 2));
          for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > r * r + r * 0.6) continue;
            if (op.hollow && d2 < (r - 1) * (r - 1)) continue;
            put(c[0] + dx, c[1] + dy, c[2] + dz, block);
          }
          break;
        }
        case "roof": {
          const mn = lo(at(v3(op.from)), at(v3(op.to)));
          const mx = hi(at(v3(op.from)), at(v3(op.to)));
          const style = String(op.style ?? "gable");
          const w = mx[0] - mn[0];
          const d = mx[2] - mn[2];
          const axis = op.axis === "x" || op.axis === "z" ? op.axis : w >= d ? "x" : "z";
          if (style === "flat") {
            box([mn[0], mn[1], mn[2]], [mx[0], mn[1], mx[2]], block);
            break;
          }
          const half = Math.ceil(((axis === "x" ? d : w) + 1) / 2);
          for (let k = 0; k < half; k++) {
            const y = mn[1] + k;
            if (style === "hip") {
              if (mn[0] + k > mx[0] - k || mn[2] + k > mx[2] - k) break;
              box([mn[0] + k, y, mn[2] + k], [mx[0] - k, y, mx[2] - k], block, (x, _y, z, a, b) => x === a[0] || x === b[0] || z === a[2] || z === b[2]);
            } else if (axis === "x") {
              box([mn[0], y, mn[2] + k], [mx[0], y, mn[2] + k], block);
              box([mn[0], y, mx[2] - k], [mx[0], y, mx[2] - k], block);
            } else {
              box([mn[0] + k, y, mn[2]], [mn[0] + k, y, mx[2]], block);
              box([mx[0] - k, y, mn[2]], [mx[0] - k, y, mx[2]], block);
            }
          }
          break;
        }
        case "door": {
          const p = at(v3(op.at));
          put(p[0], p[1], p[2], "air", true);
          put(p[0], p[1] + 1, p[2], "air", true);
          put(p[0], p[1], p[2], resolve(op.block ?? "door"), true);
          break;
        }
        case "window": {
          const p = at(v3(op.at));
          put(p[0], p[1], p[2], op.block ? block : "glass", true);
          break;
        }
        case "stairs": {
          const a = at(v3(op.from));
          const b = at(v3(op.to));
          const n = Math.max(Math.abs(b[1] - a[1]), 1);
          for (let i = 0; i <= n; i++) put(Math.round(a[0] + ((b[0] - a[0]) * i) / n), a[1] + Math.sign(b[1] - a[1]) * i, Math.round(a[2] + ((b[2] - a[2]) * i) / n), block, true);
          break;
        }
        case "repeat": {
          const count = Math.max(1, Math.min(32, Math.round(Number(op.count) || 1)));
          const step = v3(op.step);
          const sub = Array.isArray(op.ops) ? (op.ops as Op[]) : [];
          for (let i = 0; i < count; i++) run(sub, [off[0] + step[0] * i, off[1] + step[1] * i, off[2] + step[2] * i], mirror);
          break;
        }
        case "mirror": {
          const axis = op.axis === "z" ? 2 : 0;
          const c = Number(op.at) || 0;
          const sub = Array.isArray(op.ops) ? (op.ops as Op[]) : [];
          run(sub, off, mirror);
          run(sub, off, (p) => {
            const q: V3 = [...(mirror ? mirror(p) : p)];
            q[axis] = 2 * c - q[axis];
            return q;
          });
          break;
        }
        default:
          warnings.push(`unknown op "${kind}"`);
      }
    }
  };
  run(Array.isArray(plan.ops) ? plan.ops : [], [0, 0, 0], null);
  if (cells.size >= MAX_BLOCKS) warnings.push(`capped at ${MAX_BLOCKS} blocks`);

  const list = [...cells.values()].sort((a, b) => a.y - b.y || Number(a.detail) - Number(b.detail) || Number(a.block === "air") - Number(b.block === "air") || a.seq - b.seq);
  const blocks = list.map(({ x, y, z, block }) => ({ x, y, z, block }));
  const materials: Record<string, number> = {};
  let min: V3 = [0, 0, 0];
  let max: V3 = [0, 0, 0];
  blocks.forEach((b, i) => {
    if (b.block !== "air") materials[b.block] = (materials[b.block] ?? 0) + 1;
    min = i ? lo(min, [b.x, b.y, b.z]) : [b.x, b.y, b.z];
    max = i ? hi(max, [b.x, b.y, b.z]) : [b.x, b.y, b.z];
  });
  return { blocks, materials, bounds: { min, max }, warnings };
}
