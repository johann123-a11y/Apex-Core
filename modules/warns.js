'use strict';

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

const db = require('../lib/db');
const checks = require('../lib/checks');
const { DISCORD_LIMITS, truncate } = require('../config');
const logger = require('../lib/logger');

const C = { GREEN: 0x57F287, RED: 0xED4245, ORANGE: 0xFAA61A };

// Ordered highest→lowest so the first matching threshold wins
const PUNISHMENTS = [
  { threshold: 10, label: 'Perma-Mute (28 days)',       mute_ms: 28 * 24 * 60 * 60 * 1000, blacklist: false },
  { threshold: 5,  label: '2-day Mute + Blacklist',     mute_ms:  2 * 24 * 60 * 60 * 1000, blacklist: true  },
  { threshold: 3,  label: '1-day Mute',                 mute_ms: 24 * 60 * 60 * 1000,       blacklist: false },
  { threshold: 1,  label: '30-minute Mute',             mute_ms: 30 * 60 * 1000,             blacklist: false },
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
  .setDescription('Warning system')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s.setName('give').setDescription('Give a user a warning')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false).setMaxLength(512)),
  )
  .addSubcommand((s) =>
    s.setName('remove').setDescription('Remove warnings (also lifts active punishment)')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
      .addIntegerOption((o) => o.setName('amount').setDescription('Number of warnings to remove (default: 1)').setRequired(false).setMinValue(1).setMaxValue(100)),
  )
  .addSubcommand((s) =>
    s.setName('check').setDescription('Check warnings of a user')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
  )
  .addSubcommand((s) => s.setName('list').setDescription('List all warnings'));

// ──── /warn give ────

async function handleWarnGive(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') || null;

  if (target.id === interaction.user.id) return interaction.reply({ content: 'You cannot warn yourself.', flags: MessageFlags.Ephemeral });

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
    .setTitle(`⚠️ Warning #${data.count}`)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: 'User',      value: `${target} (${target.username})`,                     inline: true },
      { name: 'Moderator', value: `${interaction.user} (${interaction.user.username})`, inline: true },
      { name: 'Total',     value: `**${data.count}** warning${data.count !== 1 ? 's' : ''}`, inline: true },
      { name: 'Reason',    value: truncate(reason || '_No reason provided_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
    );

  if (appliedLabel) {
    const punishLines = [`**${appliedLabel}**`];
    if (punishment?.blacklist) punishLines.push('🚫 Blacklisted from opening tickets');
    if (until) punishLines.push(`Until: <t:${Math.floor(until.getTime() / 1000)}:F>`);
    embed.addFields({ name: '🔒 Punishment', value: punishLines.join('\n'), inline: false });
  }

  embed
    .setFooter({ text: `User ID: ${target.id} • Warn ${data.count}` })
    .setTimestamp();

  await interaction.reply({ content: `<@${target.id}>`, embeds: [embed], allowedMentions: { users: [target.id] } });
  await logger.log(interaction.client, interaction.guildId, embed);
}

// ──── /warn remove ────

async function handleWarnRemove(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const amount = interaction.options.getInteger('amount') || 1;

  const g = db.guild(interaction.guildId);
  const data = getWarnData(g, target.id);

  if (data.count <= 0) return interaction.reply({ content: `${target.username} has no warnings.`, flags: MessageFlags.Ephemeral });

  const oldCount = data.count;
  data.count = Math.max(0, data.count - amount);
  const removed = oldCount - data.count;

  const member = interaction.guild.members.cache.get(target.id);

  if (member) {
    try { await member.timeout(null, `Warnings removed by ${interaction.user.username}`); } catch { /* ignore */ }
  }

  let deblacklisted = false;
  if (oldCount >= 5 && data.count < 5) {
    if (Array.isArray(g.application_blacklist)) {
      const idx = g.application_blacklist.indexOf(target.id);
      if (idx >= 0) { g.application_blacklist.splice(idx, 1); deblacklisted = true; }
    }
  }

  await db.save();

  const statusLines = ['✅ Timeout lifted'];
  if (deblacklisted) statusLines.push('✅ Removed from blacklist');

  const embed = new EmbedBuilder()
    .setColor(C.GREEN)
    .setTitle('✅ Warnings removed')
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: 'User',        value: `${target} (${target.username})`,                     inline: true  },
      { name: 'Moderator',   value: `${interaction.user} (${interaction.user.username})`, inline: true  },
      { name: 'Removed',     value: `**${removed}** warning${removed !== 1 ? 's' : ''}`, inline: true },
      { name: 'Remaining',   value: `**${data.count}** warning${data.count !== 1 ? 's' : ''}`, inline: true },
      { name: 'Lifted',      value: statusLines.join('\n'),                                inline: false },
    )
    .setFooter({ text: `User ID: ${target.id}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  await logger.log(interaction.client, interaction.guildId, embed);
}

// ──── /warn check ────

async function handleWarnCheck(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const g = db.guild(interaction.guildId);
  const data = getWarnData(g, target.id);
  const punishment = getPunishment(data.count);
  const isBlacklisted = (g.application_blacklist || []).includes(target.id);

  const embed = new EmbedBuilder()
    .setColor(data.count >= 5 ? C.RED : data.count >= 1 ? C.ORANGE : C.GREEN)
    .setTitle(`📋 Warnings: ${target.username}`)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: 'Warnings',    value: `**${data.count}**`,                           inline: true },
      { name: 'Punishment',  value: punishment ? punishment.label : '_None_',      inline: true },
      { name: 'Blacklisted', value: isBlacklisted ? '🚫 Yes' : '✅ No',            inline: true },
    );

  if (data.history.length) {
    const last = data.history.slice(-10);
    const offset = data.history.length - last.length;
    const lines = last.map((e, i) =>
      `**${offset + i + 1}.** ${truncate(e.reason || '_no reason_', 80)} — <@${e.by_id}> — <t:${Math.floor(e.at / 1000)}:R>`,
    );
    embed.addFields({ name: `History (last ${last.length})`, value: truncate(lines.join('\n'), DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false });
  } else {
    embed.addFields({ name: 'History', value: '_No warnings_', inline: false });
  }

  embed.setFooter({ text: `User ID: ${target.id}` }).setTimestamp();
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ──── /warn list ────

async function handleWarnList(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });

  const g = db.guild(interaction.guildId);
  const entries = Object.entries(g.warns || {})
    .filter(([, d]) => d.count > 0)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 25);

  if (!entries.length) return interaction.reply({ content: 'No warnings have been issued.', flags: MessageFlags.Ephemeral });

  const lines = entries.map(([uid, d]) =>
    `<@${uid}> — **${d.count}** warning${d.count !== 1 ? 's' : ''} (${getPunishment(d.count)?.label || 'no punishment'})`,
  );

  const embed = new EmbedBuilder()
    .setColor(C.ORANGE)
    .setTitle('📋 All Warnings')
    .setDescription(truncate(lines.join('\n'), DISCORD_LIMITS.EMBED_DESCRIPTION))
    .setFooter({ text: `${entries.length} user(s) with warnings` })
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
      const opts = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(opts);
        else await interaction.reply(opts);
      } catch { /* swallow */ }
    }
  });
}

module.exports = { commands: [warnCommand], register };
