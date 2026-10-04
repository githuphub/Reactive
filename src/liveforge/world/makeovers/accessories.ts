/**
 * Local accessory blueprints for villager makeovers (the instant-rules looks table), authored as Liveforge Blueprint
 * v1 in villager units (1 = one block; the head spans y 0..0.625 above its pivot and faces -z; the robe hangs
 * y -0.875..0 below the body pivot). Built with `@liveforge/three` `buildBlueprint`, like the server's accessories.
 */
import type { Blueprint, BlueprintPart } from '@liveforge/sdk';

const H = Math.PI / 2;

type P = Omit<BlueprintPart, 'rotation' | 'material'> & { rotation?: [number, number, number]; color: string; metal?: number; rough?: number; glow?: string };

function bp(name: string, parts: P[], palette: string[]): Blueprint {
  return {
    v: 1,
    kind: 'npc_accessory',
    name,
    palette,
    attachments: [],
    source: 'designer',
    parts: parts.map((p) => ({
      role: p.role,
      shape: p.shape,
      size: p.size,
      offset: p.offset,
      rotation: p.rotation ?? [0, 0, 0],
      material: {
        color: p.color,
        roughness: p.rough ?? 0.8,
        metalness: p.metal ?? 0,
        flatShading: true,
        ...(p.glow ? { emissive: p.glow, emissiveIntensity: 1.2 } : {}),
      },
      ...(p.anim ? { anim: p.anim } : {}),
    })),
  };
}

/** Where an accessory goes on the villager model. */
export interface AccessoryFit {
  /** Model part ('head', 'body'). */
  part: string;
  /** Offset from the part pivot (blocks). */
  at: [number, number, number];
  /** Scale the blueprint so its longest side is this long (server blueprints); omit for authored ones. */
  length?: number;
  /** Built-in parts to hide while it is worn (the profession hat under a helmet). */
  hide?: string[];
}

export interface LocalAccessory {
  id: string;
  label: string;
  fit: AccessoryFit;
  blueprint: Blueprint;
}

const HATS = ['hat', 'hatBrim', 'hatTop', 'hatBand', 'plume', 'partyHat'];

export const ACCESSORIES: Record<string, LocalAccessory> = {
  hard_hat: {
    id: 'hard_hat', label: "a builder's hard hat", fit: { part: 'head', at: [0, 0, 0], hide: HATS },
    blueprint: bp("Builder's hard hat", [
      { role: 'helm', shape: 'sphere', size: [0.62, 0.4, 0.62], offset: [0, 0.64, 0], color: '#f2c230', rough: 0.45 },
      { role: 'rim', shape: 'cylinder', size: [0.74, 0.04, 0.74], offset: [0, 0.63, 0], color: '#e0a81e', rough: 0.5 },
      { role: 'trim', shape: 'box', size: [0.06, 0.06, 0.66], offset: [0, 0.83, 0], color: '#d39a14' },
      { role: 'gem', shape: 'cylinder', size: [0.1, 0.06, 0.1], offset: [0, 0.7, -0.31], rotation: [H, 0, 0], color: '#fff6c0', glow: '#fff3a0' },
    ], ['#f2c230', '#e0a81e', '#fff6c0']),
  },
  tool_belt: {
    id: 'tool_belt', label: 'a tool belt', fit: { part: 'body', at: [0, 0, 0] },
    blueprint: bp('Tool belt', [
      { role: 'belt', shape: 'box', size: [0.56, 0.08, 0.42], offset: [0, -0.52, 0], color: '#6b4a2b' },
      { role: 'decor', shape: 'box', size: [0.12, 0.12, 0.06], offset: [-0.16, -0.6, -0.22], color: '#8a6238' },
      { role: 'handle', shape: 'box', size: [0.04, 0.22, 0.04], offset: [0.18, -0.64, -0.22], color: '#5a3c22' },
      { role: 'head', shape: 'box', size: [0.12, 0.05, 0.05], offset: [0.18, -0.53, -0.22], color: '#9aa0a8', metal: 0.8, rough: 0.35 },
    ], ['#6b4a2b', '#9aa0a8']),
  },
  red_scarf: {
    id: 'red_scarf', label: 'a red scarf', fit: { part: 'body', at: [0, 0, 0] },
    blueprint: bp('Red scarf', [
      { role: 'cloth', shape: 'box', size: [0.58, 0.13, 0.44], offset: [0, -0.06, 0], color: '#c0392b' },
      { role: 'cloth', shape: 'box', size: [0.14, 0.34, 0.05], offset: [0.11, -0.27, -0.215], rotation: [0, 0, 0.16], color: '#a93226' },
      { role: 'trim', shape: 'box', size: [0.14, 0.04, 0.052], offset: [0.135, -0.42, -0.216], rotation: [0, 0, 0.16], color: '#f0d9a8' },
    ], ['#c0392b', '#a93226', '#f0d9a8']),
  },
  plumed_helmet: {
    id: 'plumed_helmet', label: 'a plumed helmet', fit: { part: 'head', at: [0, 0, 0], hide: HATS },
    blueprint: bp('Plumed helmet', [
      { role: 'helm', shape: 'box', size: [0.6, 0.42, 0.6], offset: [0, 0.48, 0], color: '#c6c9cf', metal: 0.85, rough: 0.3 },
      { role: 'trim', shape: 'box', size: [0.63, 0.05, 0.63], offset: [0, 0.29, 0], color: '#d4a93a', metal: 0.9, rough: 0.3 },
      { role: 'visor', shape: 'box', size: [0.08, 0.2, 0.06], offset: [0, 0.38, -0.31], color: '#9a9ea8', metal: 0.8 },
      { role: 'decor', shape: 'sphere', size: [0.13, 0.46, 0.54], offset: [0, 0.86, 0.05], color: '#d6332b', anim: { kind: 'wobble', speed: 2, amount: 0.25 } },
    ], ['#c6c9cf', '#d4a93a', '#d6332b']),
  },
  flower_crown: {
    id: 'flower_crown', label: 'a flower crown', fit: { part: 'head', at: [0, 0, 0], hide: ['partyHat'] },
    blueprint: bp('Flower crown', [
      { role: 'ring', shape: 'torus', size: [0.64, 0.64, 0.08], offset: [0, 0.62, 0], rotation: [H, 0, 0], color: '#4f8f3a' },
      ...[0, 1, 2, 3, 4, 5].map((i): P => {
        const a = (i / 6) * Math.PI * 2;
        return { role: 'leaf', shape: 'icosahedron', size: [0.12, 0.12, 0.12], offset: [Math.cos(a) * 0.31, 0.66, Math.sin(a) * 0.31], color: ['#f48fb1', '#ffe066', '#ffffff'][i % 3] };
      }),
    ], ['#4f8f3a', '#f48fb1', '#ffe066']),
  },
  hero_cape: {
    id: 'hero_cape', label: 'a cape in your colours', fit: { part: 'body', at: [0, 0, 0] },
    blueprint: bp('Cape of friendship', [
      { role: 'cape', shape: 'box', size: [0.52, 0.84, 0.04], offset: [0, -0.44, 0.215], rotation: [0.1, 0, 0], color: '#2f8f86' },
      { role: 'trim', shape: 'box', size: [0.54, 0.05, 0.05], offset: [0, -0.02, 0.2], color: '#f5c542', metal: 0.7, rough: 0.4 },
    ], ['#2f8f86', '#f5c542']),
  },
};

/** Fit for a server accessory, from its blueprint tags (crown, helmet, cape, amulet, belt ...). */
export function fitForServer(bpIn: Blueprint, point?: string): AccessoryFit {
  const tag = `${point ?? ''} ${(bpIn.tags ?? []).join(' ')} ${bpIn.name ?? ''}`.toLowerCase();
  if (/head|crown|helm|hat|hood|circlet/.test(tag)) return { part: 'head', at: [0, 0.68, 0], length: 0.66, hide: HATS };
  if (/back|cape|cloak|wing/.test(tag)) return { part: 'body', at: [0, -0.42, 0.24], length: 0.86 };
  if (/neck|amulet|scarf|necklace/.test(tag)) return { part: 'body', at: [0, -0.1, -0.21], length: 0.34 };
  if (/waist|belt/.test(tag)) return { part: 'body', at: [0, -0.52, 0], length: 0.58 };
  if (/shoulder|pauldron/.test(tag)) return { part: 'body', at: [0.28, -0.04, 0], length: 0.3 };
  if (/feet|boot|greave|legs/.test(tag)) return { part: 'leftLeg', at: [0, -0.3, 0], length: 0.3 };
  return { part: 'body', at: [0, -0.32, -0.21], length: 0.5 };
}
