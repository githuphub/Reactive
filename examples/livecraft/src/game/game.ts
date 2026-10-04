/**
 * The Game: owns every subsystem and runs the frame loop. Other lanes extend the game through
 * plugins (`src/<folder>/plugin.ts`, discovered automatically, see game/plugins.ts), events
 * (`game.events`), systems (`game.addSystem`), the entity manager, the UI layer and the save API.
 */
import * as THREE from 'three';
import { TextureAtlas } from '../engine/atlas';
import { BLOCK, blockById, blockByName, findBlock, registerBlock, type BlockDef, type BlockSpec } from '../engine/blocks';
import { createChunkMaterials, type ChunkMaterials } from '../engine/chunk-material';
import { ChunkManager } from '../engine/chunk-manager';
import { EntityManager } from '../engine/entities';
import { computeDrops, findItem, itemByName, registerItem, type ItemDef, type ItemSpec, type ItemStack } from '../engine/items';
import { Sky } from '../engine/sky';
import { WeatherSystem } from '../engine/weather';
import { WorldStore } from '../engine/world-store';
import type { Entity } from '../engine/entity';
import { parseSeed } from '../engine/random';
import { Player } from '../player/player';
import { Input, KEYS } from '../player/input';
import { Inventory } from '../player/inventory';
import { Interaction } from '../player/interaction';
import { HeldItem } from '../player/held-item';
import { createPlayerModel } from '../player/player-model';
import { animateHumanoid, type BoxModel } from '../engine/box-model';
import { SaveManager } from '../save/save';
import { UI } from '../ui/ui';
import { IconRenderer } from '../ui/icons';
import { DebugOverlay, Hotbar, createCrosshair } from '../ui/hud';
import { LoadingScreen, createPauseScreen } from '../ui/screens';
import { FluidSystem } from '../world/fluids';
import { terrainFor, type Terrain, type VillageSite } from '../world/terrain';
import { EventBus, type BlockSource, type GameEvents, type GameMode, type Weather } from './events';
import { loadSettings, saveSettings, type Settings } from './settings';
import { TimeOfDay, type NamedTime } from './time';

export interface GameOptions {
  canvas: HTMLCanvasElement;
  uiRoot: HTMLElement;
  /** Seed text (number or any string). Default 'livecraft'. */
  seed?: string | null;
  /** Start a new world for this seed, discarding its save. */
  fresh?: boolean;
  /** Start in creative mode. */
  creative?: boolean;
}

/** A per-frame updatable system added by other modules. */
export interface GameSystem {
  name: string;
  /** Called every simulated frame (not while paused). */
  update(dt: number): void;
}

export interface BreakOptions {
  source?: BlockSource;
  tool?: ItemStack | null;
  entity?: Entity;
  /** Roll drops (default true). */
  drop?: boolean;
}

export interface BreakResult {
  id: number;
  meta: number;
  drops: ItemStack[];
  dropsHandled: boolean;
}

export class Game {
  readonly events = new EventBus<GameEvents>();
  readonly seedText: string;
  readonly seed: number;
  readonly terrain: Terrain;
  readonly villageSite: VillageSite | null;
  readonly settings: Settings;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly atlas: TextureAtlas;
  readonly materials: ChunkMaterials;
  readonly world: WorldStore;
  readonly chunks: ChunkManager;
  readonly time: TimeOfDay;
  readonly weather: WeatherSystem;
  readonly sky: Sky;
  readonly entities: EntityManager;
  readonly input: Input;
  readonly player: Player;
  readonly inventory: Inventory;
  readonly interaction: Interaction;
  readonly fluids: FluidSystem;
  readonly ui: UI;
  readonly icons: IconRenderer;
  readonly save: SaveManager;
  /** Lights for entity models (MeshLambert); scaled with daylight automatically. */
  readonly hemiLight: THREE.HemisphereLight;
  readonly sunLight: THREE.DirectionalLight;

  /** Registry helpers (same functions as engine/blocks and engine/items). */
  readonly blocks = { byName: blockByName, byId: blockById, find: findBlock, register: (spec: BlockSpec): BlockDef => registerBlock(spec), ids: BLOCK };
  readonly items = { byName: itemByName, find: findItem, register: (spec: ItemSpec): ItemDef => registerItem(spec) };

  /** True while the world simulation is paused (pause menu or other pausing screens). */
  paused = false;
  /** True once the spawn area is loaded and the player is in control. */
  ready = false;
  private readonly systems: GameSystem[] = [];
  private readonly heldItem: HeldItem;
  private readonly debug: DebugOverlay;
  private readonly pauseScreen;
  private playerModel: BoxModel | null = null;
  private last = 0;
  private elapsed = 0;
  private saveTimer = 0;
  private hudVisible = true;

  private constructor(opts: GameOptions, save: SaveManager, seedText: string, seed: number) {
    this.seedText = seedText;
    this.seed = seed;
    this.save = save;
    this.settings = loadSettings();
    this.terrain = terrainFor(seed);
    this.villageSite = this.terrain.villageSite();

    this.renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.info.autoReset = true;
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, window.innerWidth / window.innerHeight, 0.08, 1000);
    this.scene.add(this.camera);

    this.atlas = new TextureAtlas();
    this.materials = createChunkMaterials(this.atlas.texture);
    this.world = new WorldStore(this.events, this.terrain);
    this.world.onEdit = (x, y, z, raw) => this.save.recordBlock(x, y, z, raw);
    this.chunks = new ChunkManager({
      world: this.world,
      materials: this.materials,
      atlas: this.atlas,
      seed,
      diffsFor: (cx, cz) => this.save.diffsFor(cx, cz),
    });
    this.chunks.setRenderDistance(this.settings.renderDistance);
    this.time = new TimeOfDay(this.events);
    this.weather = new WeatherSystem(this.events);
    this.sky = new Sky();
    this.entities = new EntityManager(this);
    this.input = new Input(opts.canvas);
    this.player = new Player(this);
    this.inventory = new Inventory(this.events);
    this.fluids = new FluidSystem(this.world, this.events);
    this.ui = new UI(opts.uiRoot);
    this.icons = new IconRenderer(this.atlas);

    this.hemiLight = new THREE.HemisphereLight(0xdfeaff, 0x5a5040, 1.4);
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
    this.scene.add(this.sky.group, this.chunks.group, this.entities.group, this.weather.group, this.hemiLight, this.sunLight);

    this.interaction = new Interaction(this);
    this.heldItem = new HeldItem(this.atlas);
    this.camera.add(this.heldItem.group);
    this.interaction.onSwing = () => this.heldItem.doSwing();

    // HUD.
    this.ui.mount('center', createCrosshair(), { order: 0 });
    this.ui.mount('bottom-center', new Hotbar(this, this.icons).el, { order: 100 });
    this.debug = new DebugOverlay(this);
    this.ui.mount('top-left', this.debug.el, { order: 0 });
    this.pauseScreen = createPauseScreen(this);

    this.wireInput();
    this.wireSave(opts);
    window.addEventListener('resize', () => this.resize());
  }

  /** Opens the save, builds the game and returns it (call `start()` next). */
  static async create(opts: GameOptions): Promise<Game> {
    const { text, value } = parseSeed(opts.seed);
    const save = await SaveManager.open(text, { fresh: opts.fresh });
    const game = new Game(opts, save, text, value);
    if (opts.creative && !save.has('player')) game.setGameMode('creative');
    return game;
  }

  // -- public API ------------------------------------------------------------------------------

  /** Adds a per-frame system (runs after entities, not while paused). */
  addSystem(system: GameSystem): void {
    this.systems.push(system);
  }

  removeSystem(system: GameSystem): void {
    const i = this.systems.indexOf(system);
    if (i >= 0) this.systems.splice(i, 1);
  }

  /**
   * Breaks a block like a player would: rolls drops (respecting tool tier), sets air and fires
   * `blockBroken`. If the player broke it in survival and no system set `dropsHandled`, the drops
   * go to the inventory. Returns null if nothing was there or the block is unbreakable.
   */
  breakBlock(x: number, y: number, z: number, opts: BreakOptions = {}): BreakResult | null {
    const id = this.world.getBlock(x, y, z);
    if (id === BLOCK.air) return null;
    const def = blockById(id);
    if (def.hardness < 0 && opts.source === 'player') return null;
    const meta = this.world.getMeta(x, y, z);
    const drops = opts.drop === false ? [] : computeDrops(def, meta, opts.tool ?? null);
    let handled = false;
    const off = this.events.on('blockBroken', (e) => {
      if (e.x === x && e.y === y && e.z === z) handled = e.dropsHandled;
    });
    const ok = this.world.setBlock(x, y, z, BLOCK.air, { source: opts.source ?? 'system', drops, tool: opts.tool ?? null, entity: opts.entity });
    off();
    if (!ok) return null;
    if (!handled && opts.source === 'player' && this.player.mode === 'survival' && !this.inventory.infinite) {
      for (const d of drops) this.inventory.add(d);
      handled = true;
    }
    return { id, meta, drops, dropsHandled: handled };
  }

  /** Places a block by name or id (no placement rules; see Interaction for player rules). */
  placeBlock(x: number, y: number, z: number, block: string | number, opts: { meta?: number; source?: BlockSource; entity?: Entity } = {}): boolean {
    const id = typeof block === 'number' ? block : blockByName(block).id;
    return this.world.setBlock(x, y, z, id, { meta: opts.meta, source: opts.source ?? 'system', entity: opts.entity });
  }

  /** Opens or closes a door (both halves). */
  toggleDoor(x: number, y: number, z: number, open?: boolean): void {
    const id = this.world.getBlock(x, y, z);
    if (blockById(id).renderType !== 'door') return;
    const meta = this.world.getMeta(x, y, z);
    const baseY = meta & 8 ? y - 1 : y;
    const lower = this.world.getMeta(x, baseY, z);
    const isOpen = (lower & 4) !== 0;
    const next = open ?? !isOpen;
    if (next === isOpen) return;
    const m = (lower & 3) | (next ? 4 : 0);
    this.world.setBlock(x, baseY, z, id, { meta: m, source: 'player' });
    if (this.world.getBlock(x, baseY + 1, z) === id) this.world.setBlock(x, baseY + 1, z, id, { meta: m | 8, source: 'player' });
  }

  setGameMode(mode: GameMode): void {
    this.player.setMode(mode);
    if (mode === 'creative') this.inventory.infinite = true;
    this.save.markDirty('player');
  }

  /** Changes the weather (V3 drives this). */
  setWeather(kind: Weather): void {
    this.weather.set(kind);
  }

  /** Sets the time of day (0..1 or a named time). */
  setTime(t: number | NamedTime): void {
    this.time.setTime(t);
  }

  /** Updates a setting, applies it immediately and persists it. */
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.settings[key] = value;
    saveSettings(this.settings);
    if (key === 'renderDistance') this.chunks.setRenderDistance(value as number);
    this.events.emit('settingsChanged', { key });
  }

  /** Teleports the player (loads chunks around the destination). */
  teleportPlayer(x: number, y: number | null, z: number): void {
    const gy = y ?? this.world.findGround(x, z) ?? this.terrain.heightAt(Math.floor(x), Math.floor(z)) + 1;
    this.player.teleport(x, gy, z);
  }

  /**
   * Projects a world position to CSS pixels (for speech bubbles, name tags, markers).
   * `visible` is false when the point is behind the camera or off screen.
   */
  worldToScreen(x: number, y: number, z: number): { x: number; y: number; visible: boolean; distance: number } {
    const v = tmpProject.set(x, y, z);
    const distance = v.distanceTo(this.camera.position);
    v.project(this.camera);
    const w = window.innerWidth, h = window.innerHeight;
    const visible = v.z > -1 && v.z < 1 && Math.abs(v.x) <= 1.1 && Math.abs(v.y) <= 1.1;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, visible, distance };
  }

  /** Starts loading and the frame loop. Resolves when the player is in the world. */
  async start(): Promise<void> {
    const loading = new LoadingScreen(this.ui.root, this.seedText);
    this.player.frozen = true;
    this.last = performance.now();
    this.renderer.setAnimationLoop((t) => this.frame(t));
    const p = this.player.position;
    const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16);
    const radius = Math.min(3, this.chunks.distance);
    await new Promise<void>((resolve) => {
      const check = () => {
        const f = this.chunks.readiness(cx, cz, radius);
        const st = this.chunks.stats();
        loading.setProgress(f, `Building terrain… ${Math.round(f * 100)}%  (${st.loaded} chunks)`);
        if (f >= 1) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
    this.placePlayerOnGround();
    await loading.ready();
    this.input.lock();
    this.player.frozen = false;
    this.ready = true;
    this.events.emit('ready', {});
  }

  // -- internals -------------------------------------------------------------------------------

  private placePlayerOnGround(): void {
    const p = this.player.position;
    const blocked = this.world.isSolid(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) || this.world.isSolid(Math.floor(p.x), Math.floor(p.y + 1), Math.floor(p.z));
    if (this.save.has('player') && !blocked) return;
    const y = this.world.findGround(p.x, p.z);
    if (y !== null) p.y = y;
  }

  private wireSave(opts: GameOptions): void {
    // Default spawn next to the village site.
    const site = this.villageSite;
    const sx = (site ? site.spawn.x : 0) + 0.5;
    const sz = (site ? site.spawn.z : 0) + 0.5;
    const sy = this.terrain.heightAt(Math.floor(sx), Math.floor(sz)) + 1;
    this.player.spawnPoint.set(sx, sy, sz);
    this.player.position.set(sx, sy, sz);
    if (site) this.player.yaw = Math.atan2(-(site.x - sx), -(site.z - sz));
    this.inventory.fillDefaults();
    void opts;

    this.save.register('player', () => this.player.serialize(), (d) => this.player.deserialize(d));
    this.save.register('inventory', () => this.inventory.serialize(), (d) => this.inventory.deserialize(d));
    this.save.register(
      'world',
      () => ({ time: this.time.time, day: this.time.day, weather: this.weather.current }),
      (d: { time: number; day: number; weather: Weather }) => {
        this.time.time = d.time ?? this.time.time;
        this.time.day = d.day ?? 0;
        if (d.weather) this.weather.set(d.weather);
      },
    );
  }

  private wireInput(): void {
    const input = this.input;
    const screens = this.ui.screens;
    input.onKey((e) => {
      if (screens.isOpen) return screens.handleKey(e);
      if (!this.ready) return false;
      if (e.code === KEYS.debug) {
        this.debug.toggle();
        return true;
      }
      if (e.code === KEYS.view) {
        const order = ['first', 'back', 'front'] as const;
        this.player.viewMode = order[(order.indexOf(this.player.viewMode) + 1) % 3];
        return true;
      }
      if (e.code === KEYS.hideHud) {
        this.hudVisible = !this.hudVisible;
        this.ui.setHudVisible(this.hudVisible);
        return true;
      }
      return false;
    });
    input.onLockChange((locked) => {
      if (!locked && this.ready && !screens.isOpen) screens.open(this.pauseScreen);
    });
    screens.onChange(() => {
      const open = screens.isOpen;
      input.enabled = !open;
      const wasPaused = this.paused;
      this.paused = screens.pausing;
      if (open) input.unlock();
      else if (this.ready) input.lock();
      if (this.paused !== wasPaused) {
        this.events.emit(this.paused ? 'paused' : 'resumed', {});
        if (this.paused) void this.save.flush();
      }
    });
    this.renderer.domElement.addEventListener('click', () => {
      if (this.ready && !screens.isOpen) input.lock();
    });
  }

  private resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame(now: number): void {
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.elapsed += dt;

    if (!this.paused && this.ready) {
      this.time.update(dt);
      this.player.update(dt, this.input);
      this.interaction.update(dt, this.input);
      this.entities.update(dt);
      this.fluids.update(dt);
      for (const s of this.systems) {
        try {
          s.update(dt);
        } catch (err) {
          console.error(`[game] system "${s.name}" failed`, err);
        }
      }
      this.events.emit('tick', { dt, elapsed: this.elapsed });
      this.saveTimer += dt;
      if (this.saveTimer > 10) {
        this.saveTimer = 0;
        this.save.markDirty();
      }
    }

    this.player.updateCamera(this.camera, this.settings.fov);
    this.chunks.update(this.player.position.x, this.player.position.z, now);
    this.sky.update(dt, this.camera, this.time, this.weather);
    this.weather.update(dt, this.camera, this.world);
    this.updateUniforms(dt);
    this.updatePlayerModel(dt);
    this.debug.update(dt);
    this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
  }

  private updateUniforms(dt: number): void {
    const u = this.materials.uniforms;
    u.uTime.value = this.elapsed;
    u.uDaylight.value = Math.max(0.15, this.time.daylight * (1 - this.weather.darkening * 0.6));
    u.uSkyTint.value.copy(this.sky.skyTint);
    const cam = this.camera.position;
    const camBlock = this.world.getBlock(Math.floor(cam.x), Math.floor(cam.y), Math.floor(cam.z));
    const far = this.chunks.distance * 16 - 6;
    if (camBlock === BLOCK.water) {
      u.uFogColor.value.setRGB(0.08, 0.2, 0.42).multiplyScalar(0.3 + 0.7 * this.time.daylight);
      u.uFogNear.value = 1;
      u.uFogFar.value = 22;
    } else if (camBlock === BLOCK.lava) {
      u.uFogColor.value.setRGB(0.8, 0.3, 0.05);
      u.uFogNear.value = 0;
      u.uFogFar.value = 2;
    } else {
      u.uFogColor.value.copy(this.sky.fogColor);
      const wf = 1 - this.weather.intensity * 0.35;
      u.uFogNear.value = far * 0.55 * wf;
      u.uFogFar.value = far * wf;
    }
    this.scene.background = u.uFogColor.value;
    // Entity lights follow daylight.
    const dl = this.time.daylight;
    this.hemiLight.intensity = 0.6 + 0.9 * dl;
    this.sunLight.intensity = 1.1 * dl;
    this.time.sunDirection(this.sunLight.position).multiplyScalar(100);
    // Held item brightness from local light.
    const ex = Math.floor(cam.x), ey = Math.floor(cam.y), ez = Math.floor(cam.z);
    const sky = this.world.getSkyLight(ex, ey, ez) / 15;
    const blk = this.world.getBlockLight(ex, ey, ez) / 15;
    const b = 0.25 + 0.75 * Math.max(sky * (0.2 + 0.8 * dl), blk);
    this.heldItem.group.visible = this.player.viewMode === 'first' && this.hudVisible;
    this.heldItem.update(dt, this.inventory.selectedStack?.item ?? null, b, 0);
  }

  private updatePlayerModel(dt: number): void {
    const third = this.player.viewMode !== 'first';
    if (third && !this.playerModel) {
      this.playerModel = createPlayerModel();
      this.scene.add(this.playerModel.root);
    }
    if (!this.playerModel) return;
    this.playerModel.root.visible = third;
    if (!third) return;
    const p = this.player.position;
    this.playerModel.root.position.copy(p);
    this.playerModel.root.rotation.y = this.player.yaw;
    animateHumanoid(this.playerModel, this.player.walkPhase, this.player.walkAmount, -this.player.pitch * 0.8);
    const body = this.playerModel.parts.body;
    body.rotation.x = this.player.sneaking ? 0.4 : 0;
    const l = this.world.getLight(Math.floor(p.x), Math.floor(p.y + 1), Math.floor(p.z), this.time.daylight) / 15;
    this.playerModel.setBrightness(0.3 + 0.7 * l);
    this.playerModel.tick(dt);
  }
}

const tmpProject = new THREE.Vector3();
