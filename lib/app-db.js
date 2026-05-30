'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE     = path.join(DATA_DIR, 'applications.json');

let cache      = null;
let writeQueue = Promise.resolve();

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (cache) return cache;
  ensureDir();
  if (!fs.existsSync(FILE)) { cache = {}; return cache; }
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; }
  catch (e) { console.error('[app-db] parse error, starting fresh:', e.message); cache = {}; }
  return cache;
}

function save() {
  const snap = JSON.stringify(load(), null, 2);
  writeQueue = writeQueue.then(
    () => fs.promises.writeFile(FILE + '.tmp', snap).then(() => fs.promises.rename(FILE + '.tmp', FILE)),
    () => fs.promises.writeFile(FILE + '.tmp', snap).then(() => fs.promises.rename(FILE + '.tmp', FILE)),
  );
  return writeQueue;
}

function guild(guildId) {
  const data = load();
  const id   = String(guildId);
  if (!data[id]) data[id] = {
    panelDescription: { title: 'Applications', subtitle: '', description: '', footer: '' },
    applications:     {},
    activeMessages:   [],
    submissions:      [],
    cooldowns:        [],
    submissionCounter: 0,
  };
  const g = data[id];
  if (!g.panelDescription)          g.panelDescription = { title: 'Applications', subtitle: '', description: '', footer: '' };
  if (!g.applications)              g.applications = {};
  if (!Array.isArray(g.activeMessages))  g.activeMessages = [];
  if (!Array.isArray(g.submissions))     g.submissions = [];
  if (!Array.isArray(g.cooldowns))       g.cooldowns = [];
  if (!g.submissionCounter)         g.submissionCounter = 0;
  return g;
}

function nextSubmissionId(guildId) {
  const g = guild(guildId);
  g.submissionCounter = (g.submissionCounter || 0) + 1;
  return g.submissionCounter;
}

module.exports = { load, save, guild, nextSubmissionId };
