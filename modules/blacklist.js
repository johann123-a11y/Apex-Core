'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const db     = require('../lib/db');
const checks = require('../lib/checks');
const { truncate, DISCORD_LIMITS } = require('../config');

const command = new SlashCommandBuilder()
  .setName('blacklist')
  .setDescription('Manage blacklists')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s.setName('add').setDescription('Globally blacklist a user from all bot features (read-only)')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false).setMaxLength(200)),
  )
  .addSubcommand((s) =>
    s.setName('ticket').setDescription('Blacklist a user from opening tickets')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false).setMaxLength(200)),
  )
  .addSubcommand((s) =>
    s.setName('application').setDescription('Blacklist a user from opening applications')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false).setMaxLength(200)),
  )
  .addSubcommand((s) =>
    s.setName('remove').setDescription('Remove all blacklists from a user')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
  )
  .addSubcommand((s) => s.setName('list').setDescription('List all blacklisted users'));

// ── Helpers ───────────────────────────────────────────────────────────────────

function isBlacklisted(g, userId, type) {
  if (g.global_blacklist.includes(userId)) return true;
  if (type === 'ticket')      return g.ticket_blacklist.includes(userId) || g.application_blacklist.includes(userId);
  if (type === 'application') return g.app_blacklist.includes(userId)    || g.application_blacklist.includes(userId);
  return false;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleAdd(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') || null;

  if (target.id === interaction.user.id)
    return interaction.reply({ content: 'You cannot blacklist yourself.', flags: MessageFlags.Ephemeral });

  const g = db.guild(interaction.guildId);
  if (!g.global_blacklist.includes(target.id)) g.global_blacklist.push(target.id);
  await db.save();

  return interaction.reply({
    content: `🚫 **${target.username}** is now globally blacklisted from all bot features.${reason ? `\nReason: ${reason}` : ''}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTicketBlacklist(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') || null;
  const g = db.guild(interaction.guildId);

  if (!g.ticket_blacklist.includes(target.id)) g.ticket_blacklist.push(target.id);
  await db.save();

  return interaction.reply({
    content: `🚫 **${target.username}** is now blacklisted from opening tickets.${reason ? `\nReason: ${reason}` : ''}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleApplicationBlacklist(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') || null;
  const g = db.guild(interaction.guildId);

  if (!g.app_blacklist.includes(target.id)) g.app_blacklist.push(target.id);
  await db.save();

  return interaction.reply({
    content: `🚫 **${target.username}** is now blacklisted from opening applications.${reason ? `\nReason: ${reason}` : ''}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleRemove(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const g = db.guild(interaction.guildId);
  const uid = target.id;

  const removed = [];
  const remove = (arr, label) => {
    const i = arr.indexOf(uid);
    if (i >= 0) { arr.splice(i, 1); removed.push(label); }
  };

  remove(g.global_blacklist,       'Global');
  remove(g.ticket_blacklist,       'Ticket');
  remove(g.app_blacklist,          'Application');
  remove(g.application_blacklist,  'Ticket+Application (warn)');

  if (!removed.length)
    return interaction.reply({ content: `**${target.username}** is not blacklisted.`, flags: MessageFlags.Ephemeral });

  await db.save();
  return interaction.reply({
    content: `✅ Removed **${target.username}** from: ${removed.join(', ')}.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleList(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });

  const g = db.guild(interaction.guildId);

  const sections = [
    { label: '🚫 Global (all features)',        list: g.global_blacklist       },
    { label: '🎫 Ticket only',                   list: g.ticket_blacklist       },
    { label: '📋 Application only',              list: g.app_blacklist          },
    { label: '⚠️ Ticket+Application (via warns)', list: g.application_blacklist  },
  ].filter((s) => s.list.length > 0);

  if (!sections.length)
    return interaction.reply({ content: 'No users are blacklisted.', flags: MessageFlags.Ephemeral });

  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('🚫 Blacklist')
    .setTimestamp();

  for (const { label, list } of sections) {
    embed.addFields({
      name: label,
      value: truncate(list.map((id) => `<@${id}>`).join(', '), DISCORD_LIMITS.EMBED_FIELD_VALUE),
      inline: false,
    });
  }

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ── Register ──────────────────────────────────────────────────────────────────

function register(client) {
  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.inGuild() || !interaction.isChatInputCommand() || interaction.commandName !== 'blacklist') return;
      const sub = interaction.options.getSubcommand();
      if (sub === 'add')          return await handleAdd(interaction);
      if (sub === 'ticket')       return await handleTicketBlacklist(interaction);
      if (sub === 'application')  return await handleApplicationBlacklist(interaction);
      if (sub === 'remove')       return await handleRemove(interaction);
      if (sub === 'list')         return await handleList(interaction);
    } catch (err) {
      console.error('[blacklist] error:', err);
      const opts = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(opts);
        else await interaction.reply(opts);
      } catch { /* swallow */ }
    }
  });
}

module.exports = { commands: [command], register, isBlacklisted };
