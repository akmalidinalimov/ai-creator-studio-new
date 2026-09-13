// warmup-dispatch/plugins.ts — the registered plugin set.
//
// Slice 0 ships the engine, not the game: this list is empty on purpose. Agent D (game mechanics),
// Agent E (community manager) and Agent F (sequences) each add their own entries as their plugins
// land, and nothing else about dispatch changes.
//
// Adding one:
//   import { pointsBasic } from "../_warmup/plugins/points-basic/index.ts";
//   export const PLUGINS: Plugin[] = [pointsBasic];
//
// Rules a plugin must satisfy (enforced by review, and by the fact that Ctx hands it no database
// handle): it returns Effect[] and writes nothing; it never imports another plugin; it never calls
// the Telegram API — it emits a send or react effect instead; and it contains no user-facing
// string, only copy keys resolved from the pack.
//
// A plugin that throws is caught by the bus, counted, and auto-disabled after
// AUTO_DISABLE_AFTER consecutive failures. Registering a broken plugin cannot take the bot down.

import type { Plugin } from "../_warmup/types.ts";

export const PLUGINS: Plugin[] = [];
