/**
 * Entry point. URL params: `?seed=<text|number>`, `?fresh` (new world for the seed),
 * `?creative`, `?rd=<2..10>`, `?time=<0..1|dawn|noon|dusk|night|midnight>`,
 * `?weather=<clear|rain|storm|snow>`.
 */
import './ui/styles.css';
import { Game } from './game/game';
import { initPlugins } from './game/plugins';
import type { Weather } from './game/events';
import type { NamedTime } from './game/time';

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;
  const game = await Game.create({
    canvas,
    uiRoot,
    seed: params.get('seed'),
    fresh: params.has('fresh'),
    creative: !params.has('survival'),
  });
  const rd = Number(params.get('rd'));
  if (rd >= 2 && rd <= 10) game.setSetting('renderDistance', rd);
  const time = params.get('time');
  if (time) game.setTime(Number.isFinite(Number(time)) ? Number(time) : (time as NamedTime));
  const weather = params.get('weather');
  if (weather) game.setWeather(weather as Weather);
  (window as unknown as { game: Game }).game = game;
  await initPlugins(game);
  await game.start();
  // creative is the default (also over a saved survival world); ?survival opts out
  if (!params.has('survival') && game.player.mode !== 'creative') game.setGameMode('creative');
}

main().catch((err) => {
  console.error(err);
  const msg = document.createElement('pre');
  msg.style.cssText = 'position:fixed;inset:20px;color:#f88;background:#200;padding:16px;white-space:pre-wrap;font:14px monospace;z-index:99';
  msg.textContent = `Livecraft failed to start:\n${err instanceof Error ? err.stack ?? err.message : String(err)}`;
  document.body.appendChild(msg);
});
