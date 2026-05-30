'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const db = require('../lib/db');
const checks = require('../lib/checks');

// Emoji key: custom emoji → ID string, unicode → the character itself
function emojiKey(emoji) {
  return emoji.id ?? emoji.name;
}

function parseEmojiInput(str) {
  // Custom emoji: <:name:id> or <a:name:id>
  const custom = str.match(/^<a?:[^:]+:(\d+)>$/);
  if (custom) return custom[1];
  // Unicode emoji: return as-is
  return str.trim();
}

// ──── Command ────

const command = new SlashCommandBuilder()
  .setName('reactionrole')
  .setDescription('Manage reaction roles')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s.setName('add').setDescription('Link a reaction on a message to a role')
      .addStringOption((o) => o.setName('message_id').setDescription('ID of the message').setRequired(true))
      .addStringOption((o) => o.setName('emoji').setDescription('Emoji to react with (e.g. ✅ or <:custom:123>)').setRequired(true))
      .addRoleOption((o) => o.setName('role').setDescription('Role to assign when reacted').setRequired(true)),
  )
  .addSubcommand((s) =>
    s.setName('remove').setDescription('Remove a reaction role from a message')
      .addStringOption((o) => o.setName('message_id').setDescription('ID of the message').setRequired(true))
      .addStringOption((o) => o.setName('emoji').setDescription('Emoji to remove').setRequired(true)),
  )
  .addSubcommand((s) => s.setName('list').setDescription('List all configured reaction roles'));

// ──── /reactionrole add ────

async function handleAdd(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const messageId = interaction.options.getString('message_id', true).trim();
  const emojiInput = interaction.options.getString('emoji', true).trim();
  const role = interaction.options.getRole('role', true);

  if (role.managed || role.id === interaction.guild.id)
    return interaction.reply({ content: 'That role cannot be assigned.', flags: MessageFlags.Ephemeral });

  if (role.position >= interaction.guild.members.me.roles.highest.position)
    return interaction.reply({ content: 'That role is higher than my highest role. Move my role above it first.', flags: MessageFlags.Ephemeral });

  // Verify message exists in this channel or any channel
  let message = null;
  try {
    message = await interaction.channel.messages.fetch(messageId);
  } catch {
    return interaction.reply({ content: 'Message not found in this channel. Run the command in the same channel as the message.', flags: MessageFlags.Ephemeral });
  }

  const key = parseEmojiInput(emojiInput);

  // Try to add the bot's reaction to the message as confirmation
  try {
    await message.react(emojiInput);
  } catch {
    return interaction.reply({ content: `Could not react with that emoji. Make sure it's a valid emoji the bot has access to.`, flags: MessageFlags.Ephemeral });
  }

  const g = db.guild(interaction.guildId);
  if (!g.reaction_roles[messageId]) g.reaction_roles[messageId] = {};
  g.reaction_roles[messageId][key] = role.id;
  await db.save();

  return interaction.reply({
    content: `✅ Done. Members who react with ${emojiInput} on that message will receive ${role}.`,
    flags: MessageFlags.Ephemeral,
  });
}

// ──── /reactionrole remove ────

async function handleRemove(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const messageId = interaction.options.getString('message_id', true).trim();
  const emojiInput = interaction.options.getString('emoji', true).trim();
  const key = parseEmojiInput(emojiInput);

  const g = db.guild(interaction.guildId);
  if (!g.reaction_roles[messageId]?.[key])
    return interaction.reply({ content: 'No reaction role found for that message + emoji combination.', flags: MessageFlags.Ephemeral });

  delete g.reaction_roles[messageId][key];
  if (Object.keys(g.reaction_roles[messageId]).length === 0)
    delete g.reaction_roles[messageId];

  await db.save();

  return interaction.reply({ content: `✅ Reaction role for ${emojiInput} removed.`, flags: MessageFlags.Ephemeral });
}

// ──── /reactionrole list ────

async function handleList(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const g = db.guild(interaction.guildId);
  const entries = Object.entries(g.reaction_roles || {});

  if (!entries.length)
    return interaction.reply({ content: 'No reaction roles configured.', flags: MessageFlags.Ephemeral });

  const lines = [];
  for (const [msgId, emojiMap] of entries) {
    for (const [emoji, roleId] of Object.entries(emojiMap)) {
      const display = emoji.match(/^\d+$/) ? `<:_:${emoji}>` : emoji;
      lines.push(`[${msgId}] ${display} → <@&${roleId}>`);
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎭 Reaction Roles')
    .setDescription(lines.join('\n'))
    .setTimestamp();

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ──── Reaction events ────

async function onReactionAdd(reaction, user) {
  if (user.bot) return;
  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }
  if (!reaction.message.guild) return;

  const g = db.guild(reaction.message.guild.id);
  const map = g.reaction_roles[reaction.message.id];
  if (!map) return;

  const key = emojiKey(reaction.emoji);
  const roleId = map[key];
  if (!roleId) return;

  const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  await member.roles.add(roleId, 'Reaction role').catch((e) =>
    console.error('[reactionroles] add role failed:', e?.message),
  );
}

async function onReactionRemove(reaction, user) {
  if (user.bot) return;
  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }
  if (!reaction.message.guild) return;

  const g = db.guild(reaction.message.guild.id);
  const map = g.reaction_roles[reaction.message.id];
  if (!map) return;

  const key = emojiKey(reaction.emoji);
  const roleId = map[key];
  if (!roleId) return;

  const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  await member.roles.remove(roleId, 'Reaction role removed').catch((e) =>
    console.error('[reactionroles] remove role failed:', e?.message),
  );
}

// ──── Register ────

function register(client) {
  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.inGuild() || !interaction.isChatInputCommand() || interaction.commandName !== 'reactionrole') return;
      const sub = interaction.options.getSubcommand();
      if (sub === 'add')    return await handleAdd(interaction);
      if (sub === 'remove') return await handleRemove(interaction);
      if (sub === 'list')   return await handleList(interaction);
    } catch (err) {
      console.error('[reactionroles] error:', err);
      const opts = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(opts);
        else await interaction.reply(opts);
      } catch { /* swallow */ }
    }
  });

  client.on('messageReactionAdd',    (r, u) => onReactionAdd(r, u).catch((e)    => console.error('[reactionroles:add]', e?.message)));
  client.on('messageReactionRemove', (r, u) => onReactionRemove(r, u).catch((e) => console.error('[reactionroles:remove]', e?.message)));
}

module.exports = { commands: [command], register };
