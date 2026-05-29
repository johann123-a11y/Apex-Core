'use strict';

const db = require('./db');

async function log(client, guildId, embed) {
  const g = db.guild(guildId);
  if (!g.log_channel_id) return;
  try {
    const channel = await client.channels.fetch(g.log_channel_id).catch(() => null);
    if (!channel?.isTextBased() || channel.isDMBased()) return;
    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error('[logger] send failed:', e?.message);
  }
}

module.exports = { log };
