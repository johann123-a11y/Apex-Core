'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'giveaways.json');

let cache = null;
let writeQueue = Promise.resolve();

function load() {
  if (cache) return cache;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) { cache = {}; return cache; }
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    cache = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  const snapshot = JSON.stringify(load(), null, 2);
  writeQueue = writeQueue.then(
    () => fs.promises.writeFile(DB_PATH + '.tmp', snapshot).then(() => fs.promises.rename(DB_PATH + '.tmp', DB_PATH)),
    () => fs.promises.writeFile(DB_PATH + '.tmp', snapshot).then(() => fs.promises.rename(DB_PATH + '.tmp', DB_PATH)),
  );
  return writeQueue;
}

function get(messageId)        { return load()[String(messageId)] || null; }
function set(messageId, data)  { load()[String(messageId)] = data; }
function all()                 { return load(); }

module.exports = { load, save, get, set, all };
