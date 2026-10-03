/**
 * Terrain shader: atlas texture × baked vertex light (sky scaled by daylight, warm block light),
 * AO/face shade, animated atlas frames and distance fog to the sky colour.
 */
import * as THREE from 'three';
import { ATLAS_SIZE, SLOT_SIZE } from './constants';

/** Uniforms shared by all chunk materials (update once per frame). */
export interface ChunkUniforms {
  map: { value: THREE.Texture };
  uTime: { value: number };
  uDaylight: { value: number };
  uSkyTint: { value: THREE.Color };
  uFogColor: { value: THREE.Color };
  uFogNear: { value: number };
  uFogFar: { value: number };
  uSlotU: { value: number };
  uMinLight: { value: number };
}

const vertex = /* glsl */ `
attribute vec4 light;
uniform float uTime;
uniform float uDaylight;
uniform vec3 uSkyTint;
uniform float uSlotU;
uniform float uMinLight;
varying vec2 vUv;
varying vec3 vLight;
varying float vDist;

float curve(float l) {
  return l * l * (3.0 - 2.0 * l) * 0.75 + l * 0.25;
}

void main() {
  vec2 tuv = uv;
  float frames = floor(light.w * 255.0 + 0.5);
  if (frames > 1.5) tuv.x += mod(floor(uTime * 5.0), frames) * uSlotU;
  vUv = tuv;
  float sky = clamp(light.x - (1.0 - uDaylight) * 0.72, 0.0, 1.0);
  vec3 skyCol = uSkyTint * curve(sky);
  vec3 blkCol = vec3(1.0, 0.86, 0.66) * curve(light.y);
  vec3 lit = max(max(skyCol, blkCol), vec3(uMinLight));
  vLight = lit * light.z;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const fragment = /* glsl */ `
uniform sampler2D map;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec2 vUv;
varying vec3 vLight;
varying float vDist;

void main() {
  vec4 tex = texture2D(map, vUv);
#ifdef CUTOUT
  if (tex.a < 0.5) discard;
#endif
  vec3 c = tex.rgb * vLight;
  float f = smoothstep(uFogNear, uFogFar, vDist);
#ifdef TRANSPARENT_PASS
  gl_FragColor = vec4(mix(c, uFogColor, f), tex.a * (1.0 - f * 0.5));
#else
  gl_FragColor = vec4(mix(c, uFogColor, f), 1.0);
#endif
}
`;

export interface ChunkMaterials {
  uniforms: ChunkUniforms;
  opaque: THREE.ShaderMaterial;
  cutout: THREE.ShaderMaterial;
  transparent: THREE.ShaderMaterial;
}

export function createChunkMaterials(atlas: THREE.Texture): ChunkMaterials {
  const uniforms: ChunkUniforms = {
    map: { value: atlas },
    uTime: { value: 0 },
    uDaylight: { value: 1 },
    uSkyTint: { value: new THREE.Color(1, 1, 1) },
    uFogColor: { value: new THREE.Color(0.6, 0.75, 0.95) },
    uFogNear: { value: 60 },
    uFogFar: { value: 96 },
    uSlotU: { value: SLOT_SIZE / ATLAS_SIZE },
    uMinLight: { value: 0.045 },
  };
  const u = uniforms as unknown as Record<string, THREE.IUniform>;
  const opaque = new THREE.ShaderMaterial({ uniforms: u, vertexShader: vertex, fragmentShader: fragment });
  const cutout = new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: vertex,
    fragmentShader: fragment,
    defines: { CUTOUT: 1 },
    side: THREE.DoubleSide,
  });
  const transparent = new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: vertex,
    fragmentShader: fragment,
    defines: { TRANSPARENT_PASS: 1 },
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
  });
  return { uniforms, opaque, cutout, transparent };
}
