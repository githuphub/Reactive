/**
 * Section mesher (runs in mesh workers). Input is a 18³ padded copy of one 16³ section plus a
 * one-block border, so faces, AO and smooth light at the edges are correct. Produces three
 * geometry passes: opaque, cutout (leaves, plants, glass) and transparent (water, ice).
 *
 * Vertex format: position (f32×3, section-local), uv (f32×2, atlas), light (u8×4 normalised:
 * sky, block, shade = AO × face, animation frames / 255).
 */
import {
  PASS_CUTOUT, PASS_OPAQUE, PASS_TRANSPARENT, R_CROSS, R_CUBE, R_DOOR, R_LADDER, R_LIQUID, R_NONE, R_TORCH,
  type BlockTable,
} from './block-table';
import { F_LIQUID, F_OPAQUE } from './blocks';
import { ATLAS_SIZE, ID_MASK, META_SHIFT, SLOT_PAD, SLOT_SIZE } from './constants';

export const PAD = 18;
export const PAD2 = PAD * PAD;
export const PAD_VOLUME = PAD * PAD * PAD;

/** Index into the padded arrays; x, y, z in -1..16. */
export function padIndex(x: number, y: number, z: number): number {
  return x + 1 + (z + 1) * PAD + (y + 1) * PAD2;
}

export interface MeshArrays {
  positions: Float32Array;
  uvs: Float32Array;
  lights: Uint8Array;
  indices: Uint16Array | Uint32Array;
}

export interface SectionMesh {
  opaque: MeshArrays | null;
  cutout: MeshArrays | null;
  transparent: MeshArrays | null;
}

class GeomBuilder {
  pos = new Float32Array(4096 * 3);
  uv = new Float32Array(4096 * 2);
  lt = new Uint8Array(4096 * 4);
  idx = new Uint32Array(4096 * 1.5);
  vc = 0;
  ic = 0;

  reset(): void {
    this.vc = 0;
    this.ic = 0;
  }

  private grow(): void {
    const cap = this.pos.length / 3;
    const n = cap * 2;
    const pos = new Float32Array(n * 3);
    pos.set(this.pos);
    this.pos = pos;
    const uv = new Float32Array(n * 2);
    uv.set(this.uv);
    this.uv = uv;
    const lt = new Uint8Array(n * 4);
    lt.set(this.lt);
    this.lt = lt;
    const idx = new Uint32Array(n * 1.5);
    idx.set(this.idx);
    this.idx = idx;
  }

  vertex(x: number, y: number, z: number, u: number, v: number, sky: number, blk: number, shade: number, anim: number): void {
    if (this.vc * 3 + 3 > this.pos.length) this.grow();
    const i = this.vc++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.uv[i * 2] = u;
    this.uv[i * 2 + 1] = v;
    this.lt[i * 4] = sky;
    this.lt[i * 4 + 1] = blk;
    this.lt[i * 4 + 2] = shade;
    this.lt[i * 4 + 3] = anim;
  }

  /** Adds two triangles for the last 4 vertices. `flip` picks the other diagonal (AO fix). */
  quad(flip: boolean): void {
    const b = this.vc - 4;
    const i = this.ic;
    if (flip) {
      this.idx[i] = b + 1; this.idx[i + 1] = b + 2; this.idx[i + 2] = b + 3;
      this.idx[i + 3] = b + 1; this.idx[i + 4] = b + 3; this.idx[i + 5] = b;
    } else {
      this.idx[i] = b; this.idx[i + 1] = b + 1; this.idx[i + 2] = b + 2;
      this.idx[i + 3] = b; this.idx[i + 4] = b + 2; this.idx[i + 5] = b + 3;
    }
    this.ic += 6;
  }

  finish(): MeshArrays | null {
    if (this.vc === 0) return null;
    return {
      positions: this.pos.slice(0, this.vc * 3),
      uvs: this.uv.slice(0, this.vc * 2),
      lights: this.lt.slice(0, this.vc * 4),
      indices: this.vc > 65535 ? this.idx.slice(0, this.ic) : Uint16Array.from(this.idx.subarray(0, this.ic)),
    };
  }
}

// Face tables ---------------------------------------------------------------------------------

/** Corner positions (0/1) of the 4 vertices of each face, CCW from outside. */
const FACE_VERTS = [
  [1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1], // +X
  [0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0], // -X
  [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0], // +Y
  [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], // -Y
  [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1], // +Z
  [1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0], // -Z
];
const FACE_DIR = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
const FACE_SHADE = [0.72, 0.72, 1.0, 0.55, 0.86, 0.86];
const AO_CURVE = [0.42, 0.62, 0.8, 1.0];
/** Horizontal facing (0 N, 1 E, 2 S, 3 W) of faces 0..5, -1 for top/bottom. */
const FACE_FACING = [1, 3, -1, -1, 2, 0];

const pd = (dx: number, dy: number, dz: number) => dx + dz * PAD + dy * PAD2;
const FACE_NEIGHBOUR = FACE_DIR.map(([x, y, z]) => pd(x, y, z));
/** Per face, per vertex: padded deltas of [side1, side2, corner] relative to the cell. */
const AO_DELTAS: number[][] = [];
for (let f = 0; f < 6; f++) {
  const [nx, ny, nz] = FACE_DIR[f];
  const axis = nx !== 0 ? 0 : ny !== 0 ? 1 : 2;
  const t1 = axis === 0 ? 1 : 0;
  const t2 = axis === 2 ? 1 : 2;
  const row: number[] = [];
  for (let v = 0; v < 4; v++) {
    const c = FACE_VERTS[f].slice(v * 3, v * 3 + 3);
    const o1 = [0, 0, 0];
    const o2 = [0, 0, 0];
    o1[t1] = c[t1] === 1 ? 1 : -1;
    o2[t2] = c[t2] === 1 ? 1 : -1;
    row.push(
      pd(nx + o1[0], ny + o1[1], nz + o1[2]),
      pd(nx + o2[0], ny + o2[1], nz + o2[2]),
      pd(nx + o1[0] + o2[0], ny + o1[1] + o2[1], nz + o1[2] + o2[2]),
    );
  }
  AO_DELTAS.push(row);
}

// Mesher ---------------------------------------------------------------------------------------

const builders = [new GeomBuilder(), new GeomBuilder(), new GeomBuilder()];
const vSky = new Float32Array(4);
const vBlk = new Float32Array(4);
const vShade = new Float32Array(4);

/**
 * Meshes one section. `wx/wy/wz` is the section's world origin (used for plant jitter).
 */
export function meshSection(table: BlockTable, blocks: Uint16Array, light: Uint8Array, wx: number, wy: number, wz: number): SectionMesh {
  for (const b of builders) b.reset();
  const { render, flags, pass, faces, anim, orient, cullSame, stageStart, stageCount, stageSlots, slotsPerRow } = table;
  const n = table.count;

  const slotU = (slot: number) => ((slot % slotsPerRow) * SLOT_SIZE + SLOT_PAD) / ATLAS_SIZE;
  const slotV = (slot: number) => (Math.floor(slot / slotsPerRow) * SLOT_SIZE + SLOT_PAD) / ATLAS_SIZE;
  const TS = 16 / ATLAS_SIZE;
  const isOpaque = (raw: number) => {
    const id = raw & ID_MASK;
    return id < n && (flags[id] & F_OPAQUE) !== 0;
  };

  /** Emits a face of an axis-aligned box (coords relative to the section, in blocks). */
  const emitFace = (
    b: GeomBuilder, f: number,
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
    slot: number, frames: number, flip: boolean,
  ) => {
    const fv = FACE_VERTS[f];
    const bu = slotU(slot);
    const bv = slotV(slot);
    const ox = Math.floor(x0 + 1e-4), oy = Math.floor(y0 + 1e-4), oz = Math.floor(z0 + 1e-4);
    for (let v = 0; v < 4; v++) {
      const px = fv[v * 3] ? x1 : x0;
      const py = fv[v * 3 + 1] ? y1 : y0;
      const pz = fv[v * 3 + 2] ? z1 : z0;
      // Local 0..1 coordinates inside the cell for UV cropping.
      const lx = px - ox, ly = py - oy, lz = pz - oz;
      let u: number, w: number;
      if (f === 0) { u = 1 - lz; w = ly; }
      else if (f === 1) { u = lz; w = ly; }
      else if (f === 2) { u = lx; w = 1 - lz; }
      else if (f === 3) { u = lx; w = lz; }
      else if (f === 4) { u = lx; w = ly; }
      else { u = 1 - lx; w = ly; }
      b.vertex(px, py, pz, bu + u * TS, bv + (1 - w) * TS, vSky[v], vBlk[v], vShade[v], frames);
    }
    b.quad(flip);
  };

  const flatLight = (pi: number, shade: number) => {
    const l = light[pi];
    const s = (l >> 4) * 17, bl = (l & 15) * 17, sh = Math.round(shade * 255);
    for (let v = 0; v < 4; v++) {
      vSky[v] = s;
      vBlk[v] = bl;
      vShade[v] = sh;
    }
  };

  for (let y = 0; y < 16; y++)
    for (let z = 0; z < 16; z++)
      for (let x = 0; x < 16; x++) {
        const pi = x + 1 + (z + 1) * PAD + (y + 1) * PAD2;
        const raw = blocks[pi];
        const id = raw & ID_MASK;
        if (id === 0 || id >= n) continue;
        const rt = render[id];
        if (rt === R_NONE) continue;
        const meta = raw >> META_SHIFT;
        const b = builders[pass[id]];

        if (rt === R_CUBE) {
          const selfCullSame = cullSame[id] === 1;
          for (let f = 0; f < 6; f++) {
            const nraw = blocks[pi + FACE_NEIGHBOUR[f]];
            const nid = nraw & ID_MASK;
            if (nid < n && flags[nid] & F_OPAQUE) continue;
            if (selfCullSame && nid === id) continue;
            // AO + smooth light.
            const np = pi + FACE_NEIGHBOUR[f];
            const ad = AO_DELTAS[f];
            const fs = FACE_SHADE[f];
            const nl = light[np];
            for (let v = 0; v < 4; v++) {
              const p1 = np + ad[v * 3] - FACE_NEIGHBOUR[f];
              const p2 = np + ad[v * 3 + 1] - FACE_NEIGHBOUR[f];
              const p3 = np + ad[v * 3 + 2] - FACE_NEIGHBOUR[f];
              const s1 = isOpaque(blocks[p1]) ? 1 : 0;
              const s2 = isOpaque(blocks[p2]) ? 1 : 0;
              const s3 = isOpaque(blocks[p3]) ? 1 : 0;
              const ao = s1 && s2 ? 0 : 3 - (s1 + s2 + s3);
              let sky = nl >> 4, blk = nl & 15, cnt = 1;
              if (!s1) { sky += light[p1] >> 4; blk += light[p1] & 15; cnt++; }
              if (!s2) { sky += light[p2] >> 4; blk += light[p2] & 15; cnt++; }
              if (!s3 && !(s1 && s2)) { sky += light[p3] >> 4; blk += light[p3] & 15; cnt++; }
              vSky[v] = Math.round((sky / cnt) * 17);
              vBlk[v] = Math.round((blk / cnt) * 17);
              vShade[v] = Math.round(AO_CURVE[ao] * fs * 255);
            }
            let slot = faces[id * 6 + f];
            if (orient[id] && FACE_FACING[f] >= 0) {
              slot = FACE_FACING[f] === (meta & 3) ? faces[id * 6 + 5] : faces[id * 6];
            }
            const flip = vShade[0] + vSky[0] + vBlk[0] + vShade[2] + vSky[2] + vBlk[2] < vShade[1] + vSky[1] + vBlk[1] + vShade[3] + vSky[3] + vBlk[3];
            emitFace(b, f, x, y, z, x + 1, y + 1, z + 1, slot, anim[id * 6 + f], flip);
          }
        } else if (rt === R_LIQUID) {
          const above = blocks[pi + PAD2] & ID_MASK;
          const level = meta & 7;
          const h = above === id ? 1 : Math.max(2, 14 - level * 1.7) / 16;
          for (let f = 0; f < 6; f++) {
            const nid = blocks[pi + FACE_NEIGHBOUR[f]] & ID_MASK;
            if (nid === id) continue;
            if (nid < n && flags[nid] & F_OPAQUE) continue;
            if (f === 3 && nid < n && flags[nid] & F_LIQUID) continue;
            flatLight(f === 2 ? pi : pi + FACE_NEIGHBOUR[f], FACE_SHADE[f]);
            if (f !== 2) {
              const own = light[pi];
              for (let v = 0; v < 4; v++) {
                vSky[v] = Math.max(vSky[v], (own >> 4) * 17);
                vBlk[v] = Math.max(vBlk[v], (own & 15) * 17);
              }
            }
            emitFace(b, f, x, y, z, x + 1, y + h, z + 1, faces[id * 6 + f], anim[id * 6 + f], false);
          }
        } else if (rt === R_CROSS) {
          let slot = faces[id * 6];
          let jx = 0, jz = 0;
          if (stageStart[id] >= 0) slot = stageSlots[stageStart[id] + Math.min(meta, stageCount[id] - 1)];
          else {
            const hsh = Math.imul((wx + x) * 73856093 ^ (wz + z) * 19349663 ^ (wy + y) * 83492791, 0x9e3779b1);
            jx = (((hsh >>> 8) & 15) / 15 - 0.5) * 0.3;
            jz = (((hsh >>> 16) & 15) / 15 - 0.5) * 0.3;
          }
          flatLight(pi, 0.92);
          const bu = slotU(slot), bv = slotV(slot);
          const fr = anim[id * 6];
          const cx0 = x + 0.15 + jx, cx1 = x + 0.85 + jx, cz0 = z + 0.15 + jz, cz1 = z + 0.85 + jz;
          // Diagonal 1
          b.vertex(cx0, y, cz0, bu, bv + TS, vSky[0], vBlk[0], vShade[0], fr);
          b.vertex(cx1, y, cz1, bu + TS, bv + TS, vSky[0], vBlk[0], vShade[0], fr);
          b.vertex(cx1, y + 1, cz1, bu + TS, bv, vSky[0], vBlk[0], vShade[0], fr);
          b.vertex(cx0, y + 1, cz0, bu, bv, vSky[0], vBlk[0], vShade[0], fr);
          b.quad(false);
          // Diagonal 2
          b.vertex(cx1, y, cz0, bu, bv + TS, vSky[0], vBlk[0], vShade[0], fr);
          b.vertex(cx0, y, cz1, bu + TS, bv + TS, vSky[0], vBlk[0], vShade[0], fr);
          b.vertex(cx0, y + 1, cz1, bu + TS, bv, vSky[0], vBlk[0], vShade[0], fr);
          b.vertex(cx1, y + 1, cz0, bu, bv, vSky[0], vBlk[0], vShade[0], fr);
          b.quad(false);
        } else if (rt === R_DOOR) {
          const facing = meta & 3;
          const open = (meta & 4) !== 0;
          const upper = (meta & 8) !== 0;
          const side = open ? (facing + 1) & 3 : facing;
          const [bx0, bz0, bx1, bz1] = DOOR_BOXES[side];
          const slot = stageStart[id] >= 0 ? stageSlots[stageStart[id] + (upper ? 1 : 0)] : faces[id * 6];
          for (let f = 0; f < 6; f++) {
            flatLight(pi, FACE_SHADE[f]);
            emitFace(b, f, x + bx0, y, z + bz0, x + bx1, y + 1, z + bz1, slot, 1, false);
          }
        } else if (rt === R_LADDER) {
          const facing = meta & 3;
          const slot = faces[id * 6];
          flatLight(pi, 0.9);
          const e = 1 / 16;
          if (facing === 0) emitFace(b, 4, x, y, z + e, x + 1, y + 1, z + e, slot, 1, false);
          else if (facing === 1) emitFace(b, 1, x + 1 - e, y, z, x + 1 - e, y + 1, z + 1, slot, 1, false);
          else if (facing === 2) emitFace(b, 5, x, y, z + 1 - e, x + 1, y + 1, z + 1 - e, slot, 1, false);
          else emitFace(b, 0, x + e, y, z, x + e, y + 1, z + 1, slot, 1, false);
        } else if (rt === R_TORCH) {
          const slot = faces[id * 6];
          let ox = 0, oy = 0, oz = 0;
          if (meta >= 1 && meta <= 4) {
            const f = meta - 1;
            ox = [0, 1, 0, -1][f] * (6 / 16);
            oz = [-1, 0, 1, 0][f] * (6 / 16);
            oy = 3 / 16;
          }
          for (let f = 0; f < 6; f++) {
            if (f === 3 && meta === 0) continue;
            flatLight(pi, f === 2 ? 1 : 0.9);
            for (let v = 0; v < 4; v++) vBlk[v] = 255;
            emitFace(b, f, x + 7 / 16 + ox, y + oy, z + 7 / 16 + oz, x + 9 / 16 + ox, y + 10 / 16 + oy, z + 9 / 16 + oz, slot, 1, false);
          }
        }
      }
  return { opaque: builders[PASS_OPAQUE].finish(), cutout: builders[PASS_CUTOUT].finish(), transparent: builders[PASS_TRANSPARENT].finish() };
}

/** Door panel boxes [x0, z0, x1, z1] by side (0 N, 1 E, 2 S, 3 W). */
export const DOOR_BOXES: [number, number, number, number][] = [
  [0, 0, 1, 3 / 16],
  [13 / 16, 0, 1, 1],
  [0, 13 / 16, 1, 1],
  [0, 0, 3 / 16, 1],
];
