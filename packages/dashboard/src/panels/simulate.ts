// Simulate player: fire a preset play style (rich hoarder, dodger, pacifist chatterbox, murderer ...) as a fake
// player and watch the Observer's traits climb, NPCs react and the Director adapt. Also a one-off signal composer.
import { BUILTIN_SIGNAL_TYPES, type PlayerModel } from "@liveforge/protocol";
import { app, bus, live } from "../app";
import { PRESETS, type SimPreset, type SimSignal } from "../presets";
import { h, icon, label, render, toast } from "../ui/dom";
import { card, empty, pill, useLive, type PanelDef } from "./panel";
import { traitBars } from "./players";
import { directiveRow } from "./overview";

export const simulatePanel: PanelDef = {
  id: "simulate",
  title: "Simulate player",
  icon: "simulate",
  subtitle: "Fire a play style as a fake player and watch the game adapt.",
  mount(root) {
    const s0 = app();
    let watching: string | null = null;
    let running: { preset: SimPreset; sent: number; total: number; cancel: boolean } | null = null;
    let speed = 1;
    const grid = h("div", { class: "preset-grid" });
    const watch = h("div");
    const reactions = h("div", { class: "feed" });
    const progress = h("div", { class: "sim-progress" });
    const speedSel = h("select", { class: "input input-sm", onchange: () => (speed = Number(speedSel.value)) },
      h("option", { value: "0.5" }, "slow"), h("option", { value: "1", selected: true }, "normal"), h("option", { value: "3" }, "fast")) as HTMLSelectElement;

    const typeIn = h("input", { class: "input", list: "sig-types", placeholder: "combat.dodged", value: "combat.dodged" }) as HTMLInputElement;
    const dataIn = h("textarea", { class: "code code-sm", spellcheck: false }) as HTMLTextAreaElement;
    dataIn.value = '{ "source": "forge_titan", "direction": "left" }';
    const playerIn = h("input", { class: "input", value: s0.player ?? "sim_dev" }) as HTMLInputElement;

    const run = async (p: SimPreset) => {
      if (running) {
        toast("A preset is already running", "info");
        return;
      }
      const s = app();
      const player = p.player;
      const signals = p.build(Date.now() & 0xffff);
      running = { preset: p, sent: 0, total: signals.length, cancel: false };
      watching = player;
      drawGrid();
      drawProgress();
      const batch = 3;
      try {
        for (let i = 0; i < signals.length && !running.cancel; i += batch) {
          const chunk: SimSignal[] = signals.slice(i, i + batch);
          const r = await s.source.simulate({ world: s.world, player, signals: chunk });
          if (r.rejected?.length) toast(`${r.rejected.length} signal(s) rejected: ${r.rejected[0].message}`, "err");
          running.sent += chunk.length;
          drawProgress();
          await new Promise((res) => setTimeout(res, 650 / speed));
        }
        toast(`${p.name}: ${running.sent} signals sent as ${label(player)}`, "ok");
      } catch (e) {
        toast(`Simulate failed: ${(e as Error).message}`, "err");
      } finally {
        running = null;
        drawGrid();
        drawProgress();
        bus.emit("tick");
      }
    };

    const drawProgress = () => {
      if (!running) {
        render(progress, watching ? h("div", { class: "muted small" }, `Watching ${label(watching)}`) : null);
        return;
      }
      const r = running;
      render(progress,
        h("div", { class: "sim-row" }, h("b", null, r.preset.name), h("span", { class: "muted" }, ` as ${label(r.preset.player)} · ${r.sent}/${r.total} signals`),
          h("button", { class: "btn btn-sm btn-ghost", onclick: () => { r.cancel = true; } }, "Stop")),
        h("div", { class: "meter" }, h("div", { class: "meter-fill", style: { width: `${(r.sent / r.total) * 100}%`, background: r.preset.color } })));
    };

    const drawGrid = () => {
      render(grid, ...PRESETS.map((p) => {
        const count = p.build(1).length;
        const busy = running?.preset.id === p.id;
        return h("div", { class: `preset ${busy ? "busy" : ""}`, style: { borderTopColor: p.color } },
          h("div", { class: "preset-head" }, h("b", null, p.name), h("span", { class: "muted small" }, `${count} signals`)),
          h("div", { class: "preset-blurb" }, p.blurb),
          h("div", { class: "vi-tags" }, ...p.expect.map((t) => pill(t, p.color))),
          h("div", { class: "preset-foot" },
            h("span", { class: "muted small" }, `as ${label(p.player)}`),
            h("button", { class: "btn btn-primary btn-sm", disabled: !!running, onclick: () => void run(p) }, icon("play", 12), busy ? " Running…" : " Run")));
      }));
    };

    const sendOne = async () => {
      const s = app();
      let data: Record<string, unknown> = {};
      try {
        data = dataIn.value.trim() ? JSON.parse(dataIn.value) : {};
      } catch {
        toast("Data is not valid JSON", "err");
        return;
      }
      const player = playerIn.value.trim() || "sim_dev";
      try {
        const r = await s.source.simulate({ world: s.world, player, signals: [{ type: typeIn.value.trim(), data }] });
        if (r.rejected?.length) toast(`Rejected: ${r.rejected[0].message}`, "err");
        else toast(`Sent ${typeIn.value} as ${label(player)}`, "ok");
        watching = player;
        drawProgress();
      } catch (e) {
        toast(`Send failed: ${(e as Error).message}`, "err");
      }
    };

    render(root,
      card("Presets", { hint: "signals are streamed in small batches so you can watch traits climb", actions: [h("span", { class: "muted small" }, "speed "), speedSel] }, progress, grid),
      h("div", { class: "grid g-1-1" },
        card("Trait watch", { hint: "live player model of the simulated player" }, watch),
        card("Reactions", { hint: "directives pushed while you simulate" }, reactions)),
      card("Send one signal", { hint: "built-in vocabulary or a custom signal declared in the manifest" },
        h("datalist", { id: "sig-types" }, ...BUILTIN_SIGNAL_TYPES.map((t) => h("option", { value: t }))),
        h("div", { class: "composer" },
          h("label", null, h("span", null, "player"), playerIn),
          h("label", null, h("span", null, "type"), typeIn),
          h("label", { class: "grow" }, h("span", null, "data (JSON)"), dataIn),
          h("button", { class: "btn btn-primary", onclick: () => void sendOne() }, icon("bolt", 14), " Send"))));

    drawGrid();
    drawProgress();
    const drawReactions = () => {
      const list = live.directives.filter((d) => !watching || !d.player || d.player === watching).slice(-10).reverse();
      render(reactions, list.length ? list.map(directiveRow) : empty("No reactions yet", "Run a preset."));
    };
    drawReactions();
    const off = bus.on("directive", drawReactions);
    const stop = useLive(async () => {
      if (!watching) {
        render(watch, empty("Pick a preset", "The simulated player's traits will appear here as signals arrive."));
        return;
      }
      const s = app();
      const m = (await s.source.projection("observer.player_model", s.world, watching).catch(() => null)) as PlayerModel | null;
      render(watch, m ? h("div", null, h("div", { class: "muted small" }, `${label(watching)} · ${m.eventCount} events`), traitBars(m)) : empty(`Waiting for ${label(watching)}…`));
    }, { interval: 1500, throttleMs: 700 });
    return () => {
      stop();
      off();
      if (running) running.cancel = true;
    };
  },
};
