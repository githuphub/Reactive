/**
 * Third-person player model: a blocky crafter with an original procedural outfit
 * (teal tunic, navy trousers, brown boots and a satchel strap).
 */
import { createBoxModel, shadeNoise, type BoxModel, type FaceName } from '../engine/box-model';

const SKIN = '#c98e6b';
const HAIR = '#4a2f1d';
const TUNIC = '#2f8f86';
const TUNIC_DARK = '#226d66';
const TROUSERS = '#2c3a63';
const BOOTS = '#5a3a22';
const STRAP = '#7a5230';

function head(face: FaceName, ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = SKIN;
  ctx.fillRect(0, 0, w, h);
  shadeNoise(ctx, w, h, 11, 0.06);
  ctx.fillStyle = HAIR;
  if (face === 'top') ctx.fillRect(0, 0, w, h);
  else if (face === 'back') ctx.fillRect(0, 0, w, 6);
  else if (face === 'left' || face === 'right') ctx.fillRect(0, 0, w, 3);
  else if (face === 'front') {
    ctx.fillRect(0, 0, w, 2);
    ctx.fillRect(0, 2, 1, 1);
    ctx.fillRect(w - 1, 2, 1, 1);
    // eyes
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(1, 4, 2, 1);
    ctx.fillRect(5, 4, 2, 1);
    ctx.fillStyle = '#2d5fb3';
    ctx.fillRect(2, 4, 1, 1);
    ctx.fillRect(5, 4, 1, 1);
    // mouth
    ctx.fillStyle = '#8a4a3a';
    ctx.fillRect(3, 6, 2, 1);
  }
}

function body(face: FaceName, ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = TUNIC;
  ctx.fillRect(0, 0, w, h);
  shadeNoise(ctx, w, h, 23, 0.07);
  ctx.fillStyle = TUNIC_DARK;
  ctx.fillRect(0, h - 2, w, 2);
  ctx.fillStyle = '#3a2416';
  ctx.fillRect(0, h - 3, w, 1);
  if (face === 'front' || face === 'back') {
    ctx.fillStyle = STRAP;
    for (let i = 0; i < Math.min(w, h - 3); i++) ctx.fillRect(face === 'front' ? i : w - 1 - i, i, 1, 1);
    if (face === 'front') {
      ctx.fillStyle = SKIN;
      ctx.fillRect(3, 0, 2, 1);
    }
  }
}

function arm(face: FaceName, ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = TUNIC;
  ctx.fillRect(0, 0, w, h);
  shadeNoise(ctx, w, h, 31, 0.07);
  ctx.fillStyle = SKIN;
  if (face === 'bottom') ctx.fillRect(0, 0, w, h);
  else if (face !== 'top') ctx.fillRect(0, h - 4, w, 4);
}

function leg(face: FaceName, ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = TROUSERS;
  ctx.fillRect(0, 0, w, h);
  shadeNoise(ctx, w, h, 41, 0.07);
  ctx.fillStyle = BOOTS;
  if (face === 'bottom') ctx.fillRect(0, 0, w, h);
  else if (face !== 'top') ctx.fillRect(0, h - 3, w, 3);
}

/** Creates a player model instance (feet at origin, facing -Z). */
export function createPlayerModel(): BoxModel {
  return createBoxModel({
    id: 'player',
    parts: [
      { name: 'body', size: [8, 12, 4], pivot: [0, 24, 0], skin: body },
      { name: 'head', size: [8, 8, 8], pivot: [0, 24, 0], offset: [-4, 0, -4], skin: head },
      { name: 'leftArm', size: [4, 12, 4], pivot: [-6, 22, 0], offset: [-2, -10, -2], skin: arm },
      { name: 'rightArm', size: [4, 12, 4], pivot: [6, 22, 0], offset: [-2, -10, -2], skin: arm },
      { name: 'leftLeg', size: [4, 12, 4], pivot: [-2, 12, 0], skin: leg },
      { name: 'rightLeg', size: [4, 12, 4], pivot: [2, 12, 0], skin: leg },
    ],
  });
}
