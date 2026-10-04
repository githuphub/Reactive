/** The Forge screen's result card for a blueprint: scroll icon, name, summary, size, materials, how to use it. */
import { pixelsToCanvas } from '../forge/pixel';
import { blueprintPixels, type LcBlueprint } from './registry';

export function blueprintCard(bp: LcBlueprint): HTMLElement[] {
  const out: HTMLElement[] = [];
  const px = blueprintPixels(bp.id);
  if (px) out.push(pixelsToCanvas(px));
  const info = document.createElement('div');
  const h = document.createElement('h3');
  h.textContent = `📐 ${bp.name}`;
  const fl = document.createElement('div');
  fl.className = 'lcx-flavor';
  fl.textContent = bp.summary;
  const solid = bp.blocks.filter((b) => b.block !== 'air');
  const span = (k: 'x' | 'y' | 'z') => (solid.length ? Math.max(...solid.map((b) => b[k])) - Math.min(...solid.map((b) => b[k])) + 1 : 0);
  const top = Object.entries(bp.materials).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${v} ${k}`).join(', ');
  const stats = document.createElement('div');
  stats.className = 'lcx-stats';
  for (const [k, v] of [['blocks', String(solid.length)], ['size', `${span('x')}×${span('y')}×${span('z')} (w×h×d)`], ['materials', top || '—'], ['source', bp.source], ['cost', 'free']] as const) {
    const a = document.createElement('span');
    a.textContent = k;
    const b = document.createElement('span');
    b.textContent = v;
    stats.append(a, b);
  }
  const how = document.createElement('div');
  how.className = 'lcx-hint';
  how.textContent = 'Hold it: the ghost shows where it goes · R rotates 90° · right-click builds (reusable)';
  info.append(h, fl, stats, how);
  out.push(info);
  return out;
}
