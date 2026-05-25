'use strict';

const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongodb:27017';
const DB_NAME = process.env.MONGO_DB_NAME || 'apex_core';

let client = null;
let collection = null;
let cache = null;
let saveQueue = Promise.resolve();

function emptyState() {
  return { guilds: {} };
}

async function init() {
  client = new MongoClient(MONGO_URI);
  await client.connect();
  collection = client.db(DB_NAME).collection('state');
  const doc = await collection.findOne({ _id: 'main' });
  cache = doc ? { guilds: doc.guilds || {} } : emptyState();
  console.log(`[db] Connected to MongoDB (${DB_NAME})`);
}

function load() {
  if (!cache) cache = emptyState();
  return cache;
}

function save() {
  const data = load();
  saveQueue = saveQueue.then(
    () => collection.replaceOne({ _id: 'main' }, { _id: 'main', guilds: data.guilds }, { upsert: true }),
    () => collection.replaceOne({ _id: 'main' }, { _id: 'main', guilds: data.guilds }, { upsert: true }),
  );
  return saveQueue;
}

function guild(guildId) {
  const data = load();
  const id = String(guildId);
  if (!data.guilds[id]) {
    data.guilds[id] = {
      staff_role_id: null,
      description: null,
      panels: {},
      tickets: {},
      counters: {},
      view_role_ids: [],
      ping_role_ids: [],
    };
  }
  const g = data.guilds[id];
  if (!g.panels) g.panels = {};
  if (!g.tickets) g.tickets = {};
  if (!g.counters) g.counters = {};
  if (!Array.isArray(g.view_role_ids)) g.view_role_ids = [];
  if (!Array.isArray(g.ping_role_ids)) g.ping_role_ids = [];
  return g;
}

function nextTicketNumber(guildId, panelId) {
  const g = guild(guildId);
  const n = (g.counters[panelId] || 0) + 1;
  g.counters[panelId] = n;
  return n;
}

module.exports = {
  init,
  load,
  save,
  guild,
  nextTicketNumber,
};
