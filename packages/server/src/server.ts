// Embeddable entry: createLiveforgeServer(config?) -> { lf, app, listen(), close() }.
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { loadConfig, type ServerConfig } from "./config.js";
import { createLogger, type Logger } from "./log.js";
import { createProviders, type Providers } from "./providers/index.js";
import { Liveforge } from "./core/runtime.js";
import { createApp } from "./http/app.js";
import { BUILTIN_MODULES } from "./modules/index.js";
import type { LiveforgeModule } from "./module.js";
import type { Moderator } from "./core/moderation.js";

export interface CreateOptions {
  config?: Partial<ServerConfig>;
  /** Default: the six built-in modules. Append plugins: [...BUILTIN_MODULES, myPlugin]. */
  modules?: LiveforgeModule[];
  providers?: Partial<Providers>;
  moderator?: Moderator;
  log?: Logger;
}

export async function createLiveforgeServer(opts: CreateOptions = {}) {
  const config: ServerConfig = { ...loadConfig(), ...opts.config };
  const log = opts.log ?? createLogger(config.logLevel);
  const modules = opts.modules ?? BUILTIN_MODULES;
  const ids = modules.map((m) => m.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`module "${dup}" registered twice`);
  const providers: Providers = { ...createProviders(config, log), ...opts.providers };
  const lf = new Liveforge(config, { modules, providers, moderator: opts.moderator, log });
  await lf.start();
  const app = createApp(lf, modules);
  let server: Server | null = null;
  return {
    lf,
    app,
    config,
    listen(): Promise<Server> {
      return new Promise((resolve) => {
        server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
          log.info(`listening on http://${config.host}:${info.port} (ws ${"/v1/ws"})`);
          resolve(server!);
        }) as Server;
        lf.hub.attach(server, (key, game) => lf.authenticate(key, game));
      });
    },
    async close(): Promise<void> {
      await lf.stop();
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    },
  };
}
