// Liveforge dashboard entry: admin-key login (or demo data), the app shell (nav, world / player pickers, live
// connection status) and a hash router over the panels.
import "./styles.css";
import { AdminError, type ConnStatus, type DataSource, type WorldSummary } from "./api/types";
import { LiveSource } from "./api/admin";
import { app, bus, eventRate, hasApp, initApp, pushDirective, pushEvent, resetApp, setState } from "./app";
import { fmtNum, h, icon, label, render } from "./ui/dom";
import type { PanelDef } from "./panels/panel";
import { overviewPanel } from "./panels/overview";
import { streamPanel } from "./panels/stream";
import { playersPanel } from "./panels/players";
import { npcsPanel } from "./panels/npcs";
import { rumoursPanel } from "./panels/rumours";
import { factionsPanel } from "./panels/factions";
import { directorPanel } from "./panels/director";
import { galleryPanel } from "./panels/gallery";
import { reviewPanel } from "./panels/review";
import { metersPanel } from "./panels/meters";
import { manifestPanel } from "./panels/manifest";
import { simulatePanel } from "./panels/simulate";

const NAV: { group: string; panels: PanelDef[] }[] = [
  { group: "Live", panels: [overviewPanel, streamPanel, simulatePanel] },
  { group: "Players", panels: [playersPanel, npcsPanel] },
  { group: "World", panels: [rumoursPanel, factionsPanel, directorPanel] },
  { group: "Forge", panels: [galleryPanel, reviewPanel] },
  { group: "Ops", panels: [metersPanel, manifestPanel] },
];
const PANELS = NAV.flatMap((g) => g.panels);
const AUTH_KEY = "liveforge.dashboard.auth";

const CONN_LABEL: Record<ConnStatus, [string, string]> = {
  live: ["Live", "#3fa34d"],
  polling: ["Polling", "#c98500"],
  connecting: ["Connecting", "#3987e5"],
  offline: ["Offline", "#e66767"],
  demo: ["Demo", "#9085e9"],
};

const root = document.getElementById("app")!;
let disposePanel: (() => void) | null = null;
let disconnect: (() => void) | null = null;
let worldTimer: ReturnType<typeof setInterval> | null = null;

// ------------------------------------------------------------------------------------------ auth storage

interface SavedAuth {
  baseUrl: string;
  key: string;
}
function loadAuth(): SavedAuth | null {
  try {
    const raw = sessionStorage.getItem(AUTH_KEY) ?? localStorage.getItem(AUTH_KEY);
    return raw ? (JSON.parse(raw) as SavedAuth) : null;
  } catch {
    return null;
  }
}
function saveAuth(a: SavedAuth, remember: boolean) {
  try {
    sessionStorage.setItem(AUTH_KEY, JSON.stringify(a));
    if (remember) localStorage.setItem(AUTH_KEY, JSON.stringify(a));
  } catch {
    /* storage unavailable: session only */
  }
}
function clearAuth() {
  try {
    sessionStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(AUTH_KEY);
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------------------------------ login

function logo(size = 28): HTMLElement {
  return h("div", { class: "logo" },
    h("div", { class: "logo-mark", style: { width: `${size}px`, height: `${size}px` } }),
    h("span", null, "Liveforge"));
}

function showLogin(error?: string) {
  const saved = loadAuth();
  const url = h("input", { class: "input", placeholder: "same origin (this page's server)", value: saved?.baseUrl ?? "", autocomplete: "url" }) as HTMLInputElement;
  const key = h("input", { class: "input", type: "password", placeholder: "LIVEFORGE_ADMIN_KEY", value: "", autocomplete: "current-password" }) as HTMLInputElement;
  const remember = h("input", { type: "checkbox" }) as HTMLInputElement;
  const err = h("div", { class: "login-err" }, error ?? "");
  const btn = h("button", { class: "btn btn-primary btn-lg", type: "submit" }, "Connect");
  const form = h("form", { class: "login-form", onsubmit: async (e: Event) => {
    e.preventDefault();
    err.textContent = "";
    if (!key.value.trim()) {
      err.textContent = "Enter the admin key (LIVEFORGE_ADMIN_KEY on the server; dev servers accept dev-admin).";
      return;
    }
    btn.disabled = true;
    btn.textContent = "Connecting…";
    const src = new LiveSource({ baseUrl: url.value.trim(), adminKey: key.value.trim() });
    try {
      await src.check();
      saveAuth({ baseUrl: url.value.trim(), key: key.value.trim() }, remember.checked);
      await boot(src);
    } catch (x) {
      const m = x instanceof AdminError ? (x.status === 401 || x.status === 403 ? "That admin key was rejected." : x.message) : (x as Error).message;
      err.textContent = m;
      btn.disabled = false;
      btn.textContent = "Connect";
    }
  } },
    h("label", null, h("span", null, "Server"), url),
    h("label", null, h("span", null, "Admin key"), key),
    h("label", { class: "check" }, remember, h("span", null, "Remember on this device")),
    err,
    btn);
  render(root, h("div", { class: "login" },
    h("div", { class: "login-glow" }),
    h("div", { class: "login-card" },
      logo(40),
      h("p", { class: "login-pitch" }, "Games that adapt to the player. Watch your NPCs remember, rumours spread and the Director adapt - live."),
      form,
      h("div", { class: "login-or" }, h("span", null, "or")),
      h("button", { class: "btn btn-ghost btn-lg", onclick: () => void bootDemo() }, icon("spark", 16), " Explore with demo data"),
      h("p", { class: "login-note" }, "The admin key never leaves this browser except as a header to your own server. Demo data runs entirely in your browser."))));
  setTimeout(() => key.focus(), 50);
}

async function bootDemo() {
  const { DemoSource } = await import("./api/demo");
  await boot(new DemoSource());
}

// ------------------------------------------------------------------------------------------ shell

const sameWorlds = (a: WorldSummary[], b: WorldSummary[]) =>
  a.length === b.length && a.every((w, i) => w.id === b[i].id && w.players.map((p) => p.id).join() === b[i].players.map((p) => p.id).join());

async function refreshWorlds() {
  if (!hasApp()) return;
  const s = app();
  const worlds = await s.source.worlds().catch(() => null);
  if (!worlds) return;
  if (!worlds.some((w) => w.id === s.world) && worlds.length) {
    setState({ worlds, world: worlds[0].id });
    return;
  }
  if (sameWorlds(worlds, s.worlds)) s.worlds.splice(0, s.worlds.length, ...worlds);
  else setState({ worlds });
  drawTopbar();
}

async function boot(source: DataSource) {
  if (hasApp()) shutdown();
  render(root, h("div", { class: "boot" }, logo(40), h("div", { class: "muted" }, "Loading…")));
  let game;
  let worlds: WorldSummary[];
  try {
    [game, worlds] = await Promise.all([source.game(), source.worlds()]);
  } catch (e) {
    showLogin((e as Error).message);
    return;
  }
  const world = worlds.sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0))[0]?.id ?? "default";
  initApp({ source, game, worlds, world, player: null, conn: source.mode === "demo" ? "demo" : "connecting" });
  renderShell();
  connectWorld();
  worldTimer = setInterval(() => void refreshWorlds(), 5000);
  route();
}

function connectWorld() {
  disconnect?.();
  const s = app();
  disconnect = s.source.connect(s.world, {
    onEvent: pushEvent,
    onDirective: pushDirective,
    onStatus: (conn, detail) => {
      if (!hasApp()) return;
      if (app().conn !== conn) {
        setState({ conn, connDetail: detail });
        drawTopbar();
      }
    },
  });
}

function shutdown() {
  disposePanel?.();
  disposePanel = null;
  disconnect?.();
  disconnect = null;
  if (worldTimer) clearInterval(worldTimer);
  if (hasApp()) app().source.close();
  resetApp();
}

const navEl = h("nav", { class: "nav" });
const topbar = h("header", { class: "topbar" });
const page = h("div", { class: "page" });

function renderShell() {
  const s = app();
  render(navEl,
    h("div", { class: "nav-top" }, logo(26), h("div", { class: "nav-game" }, s.game.name)),
    ...NAV.map((g) => h("div", { class: "nav-group" },
      h("div", { class: "nav-label" }, g.group),
      ...g.panels.map((p) => h("a", { class: "nav-item", href: `#/${p.id}`, dataset: { id: p.id } }, icon(p.icon, 18), h("span", null, p.title))))),
    h("div", { class: "nav-foot" },
      h("div", { class: "muted small" }, `${s.source.mode === "demo" ? "demo data" : s.source.label} · ${s.game.protocol}`),
      h("button", { class: "btn btn-ghost btn-sm", onclick: () => { shutdown(); clearAuth(); location.hash = ""; showLogin(); } }, icon("logout", 14), s.source.mode === "demo" ? " Exit demo" : " Sign out")));
  render(root, h("div", { class: "shell" }, navEl, h("main", { class: "main" }, topbar, page)));
  drawTopbar();
}

let currentPanel: PanelDef = overviewPanel;
function drawTopbar() {
  if (!hasApp()) return;
  const s = app();
  const [connText, connColor] = CONN_LABEL[s.conn];
  const w = s.worlds.find((x) => x.id === s.world);
  const worldSel = h("select", { class: "input input-sm", onchange: () => { setState({ world: worldSel.value, player: null }); connectWorld(); drawTopbar(); } },
    ...(s.worlds.length ? s.worlds : [{ id: s.world, events: 0, lastEventAt: null, players: [] }]).map((x) => h("option", { value: x.id, selected: x.id === s.world }, `${x.id}`))) as HTMLSelectElement;
  const players = [...(w?.players ?? [])].sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  const playerSel = h("select", { class: "input input-sm", onchange: () => setState({ player: playerSel.value || null }) },
    h("option", { value: "" }, "All players"),
    ...players.map((p) => h("option", { value: p.id, selected: p.id === s.player }, label(p.id)))) as HTMLSelectElement;
  if (s.player && !players.some((p) => p.id === s.player)) playerSel.appendChild(h("option", { value: s.player, selected: true }, label(s.player)));
  render(topbar,
    h("div", { class: "tb-title" }, h("h1", null, currentPanel.title), h("div", { class: "tb-sub" }, currentPanel.subtitle)),
    h("div", { class: "tb-controls" },
      h("label", { class: "tb-field" }, h("span", null, "world"), worldSel),
      h("label", { class: "tb-field" }, h("span", null, "player"), playerSel),
      h("div", { class: "tb-rate", title: "signals per minute" }, h("b", { id: "tb-rate" }, fmtNum(eventRate())), h("span", null, "/min")),
      h("div", { class: "conn", title: s.connDetail ?? "", style: { borderColor: `${connColor}66` } }, h("i", { class: `dot ${s.conn === "live" || s.conn === "demo" ? "pulse" : ""}`, style: { background: connColor } }), connText)));
}
setInterval(() => {
  const el = document.getElementById("tb-rate");
  if (el) el.textContent = fmtNum(eventRate());
}, 2000);

function route() {
  if (!hasApp()) return;
  const [, id, arg] = (location.hash || "#/overview").split("/");
  const panel = PANELS.find((p) => p.id === id) ?? overviewPanel;
  if (panel.id === "players" && arg) {
    const pl = decodeURIComponent(arg);
    if (app().player !== pl) setState({ player: pl });
  }
  if (panel === currentPanel && disposePanel && !arg) return;
  disposePanel?.();
  currentPanel = panel;
  navEl.querySelectorAll<HTMLElement>(".nav-item").forEach((a) => a.classList.toggle("on", a.dataset.id === panel.id));
  drawTopbar();
  const host = h("div", { class: `panel panel-${panel.id}` });
  render(page, host);
  page.scrollTop = 0;
  disposePanel = panel.mount(host);
}
window.addEventListener("hashchange", route);
bus.on("state", () => drawTopbar());
bus.on("tick", () => void refreshWorlds());

// ------------------------------------------------------------------------------------------ start

const params = new URLSearchParams(location.search);
if (params.has("demo")) void bootDemo();
else {
  const saved = loadAuth();
  if (saved) {
    const src = new LiveSource({ baseUrl: saved.baseUrl, adminKey: saved.key });
    src.check().then(() => boot(src)).catch((e) => showLogin(e instanceof AdminError && e.status === 401 ? "Saved admin key was rejected - sign in again." : undefined));
  } else showLogin();
}
