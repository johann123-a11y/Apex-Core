'use strict';

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

const db = require('../lib/db');
const checks = require('../lib/checks');
const { DISCORD_LIMITS, truncate } = require('../config');
const logger = require('../lib/logger');

const C = { GREEN: 0x57F287, RED: 0xED4245, ORANGE: 0xFAA61A };

// Ordered highest→lowest so the first matching threshold wins
const PUNISHMENTS = [
  { threshold: 10, label: 'Perma-Mute (28 Tage)',        mute_ms: 28 * 24 * 60 * 60 * 1000, blacklist: false },
  { threshold: 5,  label: '2 Tage Mute + Blacklist',     mute_ms:  2 * 24 * 60 * 60 * 1000, blacklist: true  },
  { threshold: 3,  label: '1 Tag Mute',                  mute_ms: 24 * 60 * 60 * 1000,       blacklist: false },
  { threshold: 1,  label: '30 Minuten Mute',             mute_ms: 30 * 60 * 1000,             blacklist: false },
];

function getPunishment(count) {
  for (const p of PUNISHMENTS) {
    if (count >= p.threshold) return p;
  }
  return null;
}

function getWarnData(g, userId) {
  if (!g.warns) g.warns = {};
  if (!g.warns[userId]) g.warns[userId] = { count: 0, history: [] };
  return g.warns[userId];
}

// ──── Command ────

const warnCommand = new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Warn-System')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s.setName('give').setDescription('Einem User eine Verwarnung geben')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Grund').setRequired(false).setMaxLength(512)),
  )
  .addSubcommand((s) =>
    s.setName('remove').setDescription('Verwarnungen entfernen (hebt auch aktive Strafe auf)')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
      .addIntegerOption((o) => o.setName('amount').setDescription('Anzahl zu entfernender Verwarnungen (Standard: 1)').setRequired(false).setMinValue(1).setMaxValue(100)),
  )
  .addSubcommand((s) =>
    s.setName('check').setDescription('Verwarnungen eines Users anzeigen')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
  )
  .addSubcommand((s) => s.setName('list').setDescription('Alle Verwarnungen anzeigen'));

// ──── /warn give ────

async function handleWarnGive(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Nur Staff kann verwarnen.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') || null;

  if (target.id === interaction.user.id) return interaction.reply({ content: 'Du kannst dich nicht selbst verwarnen.', flags: MessageFlags.Ephemeral });

  const g = db.guild(interaction.guildId);
  const data = getWarnData(g, target.id);
  data.count += 1;
  data.history.push({ reason, by_id: interaction.user.id, at: Date.now() });

  const punishment = getPunishment(data.count);
  let appliedLabel = null;
  let until = null;

  const member = interaction.guild.members.cache.get(target.id);
  if (punishment && member?.moderatable) {
    try {
      await member.timeout(punishment.mute_ms, truncate(`Warn #${data.count}${reason ? ': ' + reason : ''}`, 512));
      appliedLabel = punishment.label;
      until = new Date(Date.now() + punishment.mute_ms);
    } catch (e) {
      console.error('[warns] timeout failed:', e?.message);
    }
  }

  if (punishment?.blacklist) {
    if (!Array.isArray(g.application_blacklist)) g.application_blacklist = [];
    if (!g.application_blacklist.includes(target.id)) g.application_blacklist.push(target.id);
  }

  await db.save();

  const embed = new EmbedBuilder()
    .setColor(data.count >= 5 ? C.RED : C.ORANGE)
    .setTitle(`⚠️ Verwarnung #${data.count}`)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: 'User',       value: `${target} (${target.tag})`,                         inline: true },
      { name: 'Moderator',  value: `${interaction.user} (${interaction.user.tag})`,     inline: true },
      { name: 'Gesamt',     value: `**${data.count}** Verwarnung${data.count !== 1 ? 'en' : ''}`, inline: true },
      { name: 'Grund',      value: truncate(reason || '_Kein Grund angegeben_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
    );

  if (appliedLabel) {
    const punishLines = [`**${appliedLabel}**`];
    if (punishment?.blacklist) punishLines.push('🚫 Von Tickets/Bewerbungen gesperrt');
    if (until) punishLines.push(`Bis: <t:${Math.floor(until.getTime() / 1000)}:F>`);
    embed.addFields({ name: '🔒 Strafe', value: punishLines.join('\n'), inline: false });
  }

  embed
    .setFooter({ text: `User ID: ${target.id} • Warn ${data.count}` })
    .setTimestamp();

  await interaction.reply({ content: `<@${target.id}>`, embeds: [embed], allowedMentions: { users: [target.id] } });
  await logger.log(interaction.client, interaction.guildId, embed);
}

// ──── /warn remove ────

async function handleWarnRemove(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Nur Staff kann Verwarnungen entfernen.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const amount = interaction.options.getInteger('amount') || 1;

  const g = db.guild(interaction.guildId);
  const data = getWarnData(g, target.id);

  if (data.count <= 0) return interaction.reply({ content: `${target.tag} hat keine Verwarnungen.`, flags: MessageFlags.Ephemeral });

  const oldCount = data.count;
  data.count = Math.max(0, data.count - amount);
  const removed = oldCount - data.count;

  const member = interaction.guild.members.cache.get(target.id);

  // Always remove active timeout so they can write again instantly
  if (member) {
    try { await member.timeout(null, `Verwarnungen entfernt von ${interaction.user.tag}`); } catch { /* ignore */ }
  }

  // Remove blacklist if new count is below the threshold
  let deblacklisted = false;
  if (oldCount >= 5 && data.count < 5) {
    if (Array.isArray(g.application_blacklist)) {
      const idx = g.application_blacklist.indexOf(target.id);
      if (idx >= 0) { g.application_blacklist.splice(idx, 1); deblacklisted = true; }
    }
  }

  await db.save();

  const statusLines = ['✅ Timeout aufgehoben'];
  if (deblacklisted) statusLines.push('✅ Blacklist entfernt');

  const embed = new EmbedBuilder()
    .setColor(C.GREEN)
    .setTitle('✅ Verwarnungen entfernt')
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: 'User',             value: `${target} (${target.tag})`,                         inline: true  },
      { name: 'Moderator',        value: `${interaction.user} (${interaction.user.tag})`,     inline: true  },
      { name: 'Entfernt',         value: `**${removed}** Verwarnung${removed !== 1 ? 'en' : ''}`, inline: true },
      { name: 'Verbleibend',      value: `**${data.count}** Verwarnung${data.count !== 1 ? 'en' : ''}`, inline: true },
      { name: 'Aufgehobene Strafe', value: statusLines.join('\n'),                            inline: false },
    )
    .setFooter({ text: `User ID: ${target.id}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  await logger.log(interaction.client, interaction.guildId, embed);
}

// ──── /warn check ────

async function handleWarnCheck(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Nur Staff kann Verwarnungen einsehen.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const g = db.guild(interaction.guildId);
  const data = getWarnData(g, target.id);
  const punishment = getPunishment(data.count);
  const isBlacklisted = (g.application_blacklist || []).includes(target.id);

  const embed = new EmbedBuilder()
    .setColor(data.count >= 5 ? C.RED : data.count >= 1 ? C.ORANGE : C.GREEN)
    .setTitle(`📋 Verwarnungen: ${target.tag}`)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: 'Verwarnungen', value: `**${data.count}**`,                                      inline: true },
      { name: 'Strafniveau',  value: punishment ? punishment.label : '_Keine_',               inline: true },
      { name: 'Blacklist',    value: isBlacklisted ? '🚫 Ja' : '✅ Nein',                     inline: true },
    );

  if (data.history.length) {
    const last = data.history.slice(-10);
    const offset = data.history.length - last.length;
    const lines = last.map((e, i) =>
      `**${offset + i + 1}.** ${truncate(e.reason || '_kein Grund_', 80)} — <@${e.by_id}> — <t:${Math.floor(e.at / 1000)}:R>`,
    );
    embed.addFields({ name: `Verlauf (letzte ${last.length})`, value: truncate(lines.join('\n'), DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false });
  } else {
    embed.addFields({ name: 'Verlauf', value: '_Keine Verwarnungen_', inline: false });
  }

  embed.setFooter({ text: `User ID: ${target.id}` }).setTimestamp();
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ──── /warn list ────

async function handleWarnList(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Nur Staff.', flags: MessageFlags.Ephemeral });

  const g = db.guild(interaction.guildId);
  const entries = Object.entries(g.warns || {})
    .filter(([, d]) => d.count > 0)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 25);

  if (!entries.length) return interaction.reply({ content: 'Keine Verwarnungen vergeben.', flags: MessageFlags.Ephemeral });

  const lines = entries.map(([uid, d]) =>
    `<@${uid}> — **${d.count}** Verwarnung${d.count !== 1 ? 'en' : ''} (${getPunishment(d.count)?.label || 'keine Strafe'})`,
  );

  const embed = new EmbedBuilder()
    .setColor(C.ORANGE)
    .setTitle('📋 Alle Verwarnungen')
    .setDescription(truncate(lines.join('\n'), DISCORD_LIMITS.EMBED_DESCRIPTION))
    .setFooter({ text: `${entries.length} User mit Verwarnungen` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ──── Register ────

function register(client) {
  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.inGuild() || !interaction.isChatInputCommand() || interaction.commandName !== 'warn') return;
      const sub = interaction.options.getSubcommand();
      if (sub === 'give')   return await handleWarnGive(interaction);
      if (sub === 'remove') return await handleWarnRemove(interaction);
      if (sub === 'check')  return await handleWarnCheck(interaction);
      if (sub === 'list')   return await handleWarnList(interaction);
    } catch (err) {
      console.error('[warns] error:', err);
      const opts = { content: 'Etwas ist schiefgelaufen.', flags: MessageFlags.Ephemeral };
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(opts);
        else await interaction.reply(opts);
      } catch { /* swallow */ }
    }
  });
}

module.exports = { commands: [warnCommand], register };
