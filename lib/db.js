'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

let cache = null;
let writeQueue = Promise.resolve();

function emptyState() {
  return { guilds: {} };
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (cache) return cache;
  ensureDir();
  if (!fs.existsSync(DB_PATH)) {
    cache = emptyState();
    return cache;
  }
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    cache = raw.trim() ? JSON.parse(raw) : emptyState();
  } catch (err) {
    console.error('[db] Failed to parse db.json, starting fresh:', err.message);
    cache = emptyState();
  }
  if (!cache.guilds) cache.guilds = {};
  return cache;
}

function save() {
  const data = load();
  const snapshot = JSON.stringify(data, null, 2);
  // Serialize writes so concurrent calls don't corrupt the file.
  writeQueue = writeQueue.then(
    () => fs.promises.writeFile(DB_PATH + '.tmp', snapshot).then(() => fs.promises.rename(DB_PATH + '.tmp', DB_PATH)),
    () => fs.promises.writeFile(DB_PATH + '.tmp', snapshot).then(() => fs.promises.rename(DB_PATH + '.tmp', DB_PATH)),
  );
  return writeQueue;
}

function guild(guildId) {
  const data = load();
  const id = String(guildId);
  if (!data.guilds[id]) {
    data.guilds[id] = {
      staff_role_id: null,
      log_channel_id: null,
      description: null,         // { title, subtitle, description, footer }
      panels: {},                // panel_id -> panel
      tickets: {},               // channel_id -> ticket
      counters: {},              // panel_id -> next number
      view_role_ids: [],         // extra roles that can view tickets
      ping_role_ids: [],         // roles pinged on ticket open
    };
  }
  const g = data.guilds[id];
  // Backfill keys for older db files
  if (!g.panels) g.panels = {};
  if (!g.tickets) g.tickets = {};
  if (!g.counters) g.counters = {};
  if (!Array.isArray(g.view_role_ids)) g.view_role_ids = [];
  if (!Array.isArray(g.ping_role_ids)) g.ping_role_ids = [];
  if (g.log_channel_id === undefined) g.log_channel_id = null;
  return g;
}

function nextTicketNumber(guildId, panelId) {
  const g = guild(guildId);
  const n = (g.counters[panelId] || 0) + 1;
  g.counters[panelId] = n;
  return n;
}

module.exports = {
  load,
  save,
  guild,
  nextTicketNumber,
};
