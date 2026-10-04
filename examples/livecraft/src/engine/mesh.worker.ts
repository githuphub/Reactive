/// <reference lib="webworker" />
/**
 * Mesh worker. Messages:
 * - {type: 'table', table}: block table snapshot (sent on start and after registry changes)
 * - {type: 'mesh', id, blocks, light, wx, wy, wz}: padded 18³ section → {id, mesh}
 */
import type { BlockTable } from './block-table';
import { meshSection, type MeshArrays, type SectionMesh } from './mesher';

declare const self: DedicatedWorkerGlobalScope;

export interface MeshRequest {
  type: 'mesh';
  id: number;
  blocks: Uint16Array;
  light: Uint8Array;
  wx: number;
  wy: number;
  wz: number;
}

export interface MeshResponse {
  id: number;
  mesh: SectionMesh | null;
}

let table: BlockTable | null = null;

self.onmessage = (e: MessageEvent<MeshRequest | { type: 'table'; table: BlockTable }>) => {
  const msg = e.data;
  if (msg.type === 'table') {
    table = msg.table;
    return;
  }
  if (!table) {
    self.postMessage({ id: msg.id, mesh: null } satisfies MeshResponse);
    return;
  }
  const mesh = meshSection(table, msg.blocks, msg.light, msg.wx, msg.wy, msg.wz);
  const transfer: Transferable[] = [];
  const add = (m: MeshArrays | null) => {
    if (m) transfer.push(m.positions.buffer, m.uvs.buffer, m.lights.buffer, m.indices.buffer);
  };
  add(mesh.opaque);
  add(mesh.cutout);
  add(mesh.transparent);
  self.postMessage({ id: msg.id, mesh } satisfies MeshResponse, transfer);
};
