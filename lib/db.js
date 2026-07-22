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
      strikes: {},               // userId -> { count, history: [{reason, by_id, at}] }
      warns: {},                 // userId -> { count, history: [{reason, by_id, at}] }
      application_blacklist: [], // [userId, ...] — cannot open tickets/applications
      welcome: { channel_id: null, message: null },
      sticky: {},                // channelId -> { content, message_id }
      log_ticket_channel_id: null, // channel for ticket transcripts
      ticket_counter: 0,         // global incrementing ticket ID
      autorole_id: null,         // role assigned to new members on join
      reaction_roles: {},        // messageId -> { emojiKey -> roleId }
      application_pending_channel_id:  null,
      application_accepted_channel_id: null,
      application_denied_channel_id:   null,
      application_ticket_category_id:  null,
      global_blacklist:  [],   // blocked from ALL bot features
      ticket_blacklist:  [],   // blocked from tickets only
      app_blacklist:     [],   // blocked from applications only
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
  if (g.log_ticket_channel_id === undefined) g.log_ticket_channel_id = null;
  if (g.ticket_counter === undefined) g.ticket_counter = 0;
  if (!g.strikes) g.strikes = {};
  if (!g.warns) g.warns = {};
  if (!Array.isArray(g.application_blacklist)) g.application_blacklist = [];
  if (!g.welcome) g.welcome = { channel_id: null, message: null };
  if (!g.sticky) g.sticky = {};
  if (g.autorole_id === undefined) g.autorole_id = null;
  if (!g.reaction_roles) g.reaction_roles = {};
  if (g.application_pending_channel_id   === undefined) g.application_pending_channel_id   = null;
  if (g.application_accepted_channel_id  === undefined) g.application_accepted_channel_id  = null;
  if (g.application_denied_channel_id    === undefined) g.application_denied_channel_id    = null;
  if (g.application_ticket_category_id   === undefined) g.application_ticket_category_id   = null;
  if (!Array.isArray(g.global_blacklist)) g.global_blacklist = [];
  if (!Array.isArray(g.ticket_blacklist)) g.ticket_blacklist = [];
  if (!Array.isArray(g.app_blacklist))    g.app_blacklist    = [];
  return g;
}

function nextTicketNumber(guildId, panelId) {
  const g = guild(guildId);
  const n = (g.counters[panelId] || 0) + 1;
  g.counters[panelId] = n;
  return n;
}

function nextGlobalTicketId(guildId) {
  const g = guild(guildId);
  const n = (g.ticket_counter || 0) + 1;
  g.ticket_counter = n;
  return n;
}

module.exports = {
  load,
  save,
  guild,
  nextTicketNumber,
  nextGlobalTicketId,
};
