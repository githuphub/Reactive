/// <reference lib="webworker" />
/**
 * Terrain generation worker. Request: {id, seed, cx, cz, diffs?}. Response: {id, cx, cz, blocks,
 * light, biomes} with the arrays transferred.
 */
import { generateChunk } from './gen';

declare const self: DedicatedWorkerGlobalScope;

export interface GenRequest {
  id: number;
  seed: number;
  cx: number;
  cz: number;
  diffs?: Uint32Array;
}

export interface GenResponse {
  id: number;
  cx: number;
  cz: number;
  blocks: Uint16Array;
  light: Uint8Array;
  biomes: Uint8Array;
}

self.onmessage = (e: MessageEvent<GenRequest>) => {
  const { id, seed, cx, cz, diffs } = e.data;
  const r = generateChunk(seed, cx, cz, diffs);
  const res: GenResponse = { id, cx, cz, blocks: r.blocks, light: r.light, biomes: r.biomes };
  self.postMessage(res, [r.blocks.buffer, r.light.buffer, r.biomes.buffer]);
};
