'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');

const db = require('../lib/db');
const checks = require('../lib/checks');
const { DISCORD_LIMITS, truncate } = require('../config');
const logger = require('../lib/logger');

const C = {
  GREEN:  0x57F287,
  RED:    0xED4245,
  ORANGE: 0xFAA61A,
  YELLOW: 0xFEE75C,
  BRAND:  0x5865F2,
  GRAY:   0x95A5A6,
};
const MAX_STRIKES = 3;
const EMBED_MODAL_ID = 'apex:embed_modal';

// ──── Command definitions ────

const banCommand = new SlashCommandBuilder()
  .setName('ban')
  .setDescription('Ban a user from the server')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addUserOption((o) => o.setName('user').setDescription('User to ban').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false).setMaxLength(512));

const kickCommand = new SlashCommandBuilder()
  .setName('kick')
  .setDescription('Kick a user from the server')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addUserOption((o) => o.setName('user').setDescription('User to kick').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false).setMaxLength(512));

const muteCommand = new SlashCommandBuilder()
  .setName('mute')
  .setDescription('Mute a member using a timeout')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .setDMPermission(false)
  .addUserOption((o) => o.setName('user').setDescription('Member to mute').setRequired(true))
  .addIntegerOption((o) => o.setName('duration').setDescription('Duration in minutes (default: 60)').setRequired(false).setMinValue(1).setMaxValue(40320))
  .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false).setMaxLength(512));

const purgeCommand = new SlashCommandBuilder()
  .setName('purge')
  .setDescription("Delete a specific user's messages")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addUserOption((o) => o.setName('user').setDescription('User whose messages to delete').setRequired(true))
  .addIntegerOption((o) => o.setName('amount').setDescription('Number of messages to delete (max 100)').setRequired(true).setMinValue(1).setMaxValue(100));

const clearCommand = new SlashCommandBuilder()
  .setName('clear')
  .setDescription('Delete a number of messages from this channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addIntegerOption((o) => o.setName('amount').setDescription('Number of messages to delete (max 100)').setRequired(true).setMinValue(1).setMaxValue(100));

const lockCommand = new SlashCommandBuilder()
  .setName('lock')
  .setDescription('Lock this channel for non-staff')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .setDMPermission(false);

const unlockCommand = new SlashCommandBuilder()
  .setName('unlock')
  .setDescription('Unlock this channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .setDMPermission(false);

const embedCommand = new SlashCommandBuilder()
  .setName('embed')
  .setDescription('Send an embed message')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

const strikesCommand = new SlashCommandBuilder()
  .setName('strikes')
  .setDescription('Strike system')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s.setName('give').setDescription('Give a user a strike')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false).setMaxLength(512)),
  )
  .addSubcommand((s) =>
    s.setName('remove').setDescription('Remove a strike from a user')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
  )
  .addSubcommand((s) =>
    s.setName('check').setDescription("Check a user's strikes")
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
  )
  .addSubcommand((s) => s.setName('list').setDescription('List all strikes'));

// ──── /ban ────

async function handleBan(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') || null;

  if (target.id === interaction.user.id) return interaction.reply({ content: 'You cannot ban yourself.', flags: MessageFlags.Ephemeral });

  const member = interaction.guild.members.cache.get(target.id);
  if (member && !member.bannable) return interaction.reply({ content: 'This user cannot be banned (higher role or bot).', flags: MessageFlags.Ephemeral });

  try {
    await interaction.guild.members.ban(target.id, { reason: reason || undefined, deleteMessageSeconds: 0 });
  } catch (e) {
    return interaction.reply({ content: `Ban failed: ${e?.message || 'Unknown error'}`, flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setColor(C.RED)
    .setTitle('🔨 User Banned')
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: 'User',      value: `${target} (${target.username})`,                     inline: true },
      { name: 'Moderator', value: `${interaction.user} (${interaction.user.username})`, inline: true },
      { name: 'Reason',    value: truncate(reason || '_No reason provided_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
    )
    .setFooter({ text: `User ID: ${target.id}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
  await logger.log(interaction.client, interaction.guildId, embed);
}

// ──── /kick ────

async function handleKick(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getMember('user');
  if (!target) return interaction.reply({ content: 'User not found in this server.', flags: MessageFlags.Ephemeral });
  if (target.id === interaction.user.id) return interaction.reply({ content: 'You cannot kick yourself.', flags: MessageFlags.Ephemeral });
  if (!target.kickable) return interaction.reply({ content: 'This user cannot be kicked (higher role or bot).', flags: MessageFlags.Ephemeral });

  const reason = interaction.options.getString('reason') || null;

  try {
    await target.kick(reason || undefined);
  } catch (e) {
    return interaction.reply({ content: `Kick failed: ${e?.message || 'Unknown error'}`, flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setColor(C.ORANGE)
    .setTitle('👢 User Kicked')
    .setThumbnail(target.user.displayAvatarURL())
    .addFields(
      { name: 'User',      value: `${target.user} (${target.user.username})`,           inline: true },
      { name: 'Moderator', value: `${interaction.user} (${interaction.user.username})`, inline: true },
      { name: 'Reason',    value: truncate(reason || '_No reason provided_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
    )
    .setFooter({ text: `User ID: ${target.id}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
  await logger.log(interaction.client, interaction.guildId, embed);
}

// ──── /mute ────

async function handleMute(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getMember('user');
  if (!target) return interaction.reply({ content: 'User not found in this server.', flags: MessageFlags.Ephemeral });
  if (target.id === interaction.user.id) return interaction.reply({ content: 'You cannot mute yourself.', flags: MessageFlags.Ephemeral });
  if (!target.moderatable) return interaction.reply({ content: 'This user cannot be muted.', flags: MessageFlags.Ephemeral });

  const durationMinutes = interaction.options.getInteger('duration') || 60;
  const reason = interaction.options.getString('reason') || null;
  const until = new Date(Date.now() + durationMinutes * 60 * 1000);

  try {
    await target.timeout(durationMinutes * 60 * 1000, reason || undefined);
  } catch (e) {
    return interaction.reply({ content: `Mute failed: ${e?.message || 'Unknown error'}`, flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setColor(C.ORANGE)
    .setTitle('🔇 Member Muted')
    .setThumbnail(target.user.displayAvatarURL())
    .addFields(
      { name: 'User',      value: `${target.user} (${target.user.username})`,           inline: true },
      { name: 'Moderator', value: `${interaction.user} (${interaction.user.username})`, inline: true },
      { name: 'Duration',  value: `${durationMinutes} min.`, inline: true },
      { name: 'Until',     value: `<t:${Math.floor(until.getTime() / 1000)}:F>`, inline: true },
      { name: 'Reason',    value: truncate(reason || '_No reason provided_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
    )
    .setFooter({ text: `User ID: ${target.id}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
  await logger.log(interaction.client, interaction.guildId, embed);
}

// ──── /purge ────

async function handlePurge(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const amount = interaction.options.getInteger('amount', true);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const fetched = await interaction.channel.messages.fetch({ limit: 100 });
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const toDelete = [...fetched.values()]
      .filter((m) => m.author.id === target.id && m.createdTimestamp > cutoff)
      .slice(0, amount);

    if (!toDelete.length) {
      return interaction.editReply({ content: `No messages from ${target.username} found (or older than 14 days).` });
    }

    const deleted = await interaction.channel.bulkDelete(toDelete, true);

    const embed = new EmbedBuilder()
      .setColor(C.ORANGE)
      .setTitle('🧹 Purge Executed')
      .addFields(
        { name: 'Target',    value: `${target} (${target.username})`,                     inline: true },
        { name: 'Moderator', value: `${interaction.user} (${interaction.user.username})`, inline: true },
        { name: 'Deleted',   value: `${deleted.size}`, inline: true },
        { name: 'Channel',   value: `${interaction.channel}`, inline: true },
      )
      .setFooter({ text: `Target ID: ${target.id}` })
      .setTimestamp();

    await interaction.editReply({ content: `${deleted.size} message${deleted.size !== 1 ? 's' : ''} from ${target.username} deleted.` });
    await logger.log(interaction.client, interaction.guildId, embed);
  } catch (e) {
    await interaction.editReply({ content: `Purge failed: ${e?.message || 'Unknown error'}` });
  }
}

// ──── /clear ────

async function handleClear(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const amount = interaction.options.getInteger('amount', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const deleted = await interaction.channel.bulkDelete(amount, true);

    const embed = new EmbedBuilder()
      .setColor(C.ORANGE)
      .setTitle('🧹 Channel Cleared')
      .addFields(
        { name: 'Moderator', value: `${interaction.user} (${interaction.user.username})`, inline: true },
        { name: 'Deleted',   value: `${deleted.size}`, inline: true },
        { name: 'Channel',   value: `${interaction.channel}`, inline: true },
      )
      .setFooter({ text: `Requested: ${amount}` })
      .setTimestamp();

    await interaction.editReply({ content: `${deleted.size} message${deleted.size !== 1 ? 's' : ''} deleted.` });
    await logger.log(interaction.client, interaction.guildId, embed);
  } catch (e) {
    await interaction.editReply({ content: `Clear failed: ${e?.message || 'Unknown error'}` });
  }
}

// ──── /lock & /unlock ────

async function handleLock(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });

  const g = db.guild(interaction.guildId);
  const everyone = interaction.guild.roles.everyone;

  try {
    await interaction.channel.permissionOverwrites.edit(everyone.id, {
      SendMessages: false,
      AddReactions: false,
    }, { reason: `Locked by ${interaction.user.username}` });

    if (g.staff_role_id) {
      await interaction.channel.permissionOverwrites.edit(g.staff_role_id, {
        SendMessages: true,
        AddReactions: true,
      }, { reason: 'Lock — keeping staff access' });
    }
  } catch (e) {
    return interaction.reply({ content: `Lock failed: ${e?.message || 'Unknown error'}`, flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setColor(C.RED)
    .setTitle('🔒 Channel Locked')
    .setDescription(`${interaction.channel} has been locked for non-staff.`)
    .addFields({ name: 'Locked by', value: `${interaction.user} (${interaction.user.username})`, inline: true })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
  await logger.log(interaction.client, interaction.guildId, embed);
}

async function handleUnlock(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });

  try {
    await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, {
      SendMessages: null,
      AddReactions: null,
    }, { reason: `Unlocked by ${interaction.user.username}` });
  } catch (e) {
    return interaction.reply({ content: `Unlock failed: ${e?.message || 'Unknown error'}`, flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setColor(C.GREEN)
    .setTitle('🔓 Channel Unlocked')
    .setDescription(`${interaction.channel} is now open for everyone.`)
    .addFields({ name: 'Unlocked by', value: `${interaction.user} (${interaction.user.username})`, inline: true })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
  await logger.log(interaction.client, interaction.guildId, embed);
}

// ──── /embed ────

async function handleEmbed(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const modal = new ModalBuilder()
    .setCustomId(EMBED_MODAL_ID)
    .setTitle('Create Embed');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('title').setLabel('Title (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(256),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('description').setLabel('Text / Content').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('color').setLabel('Color: Hex e.g. #5865F2 (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(7).setPlaceholder('#5865F2'),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('footer').setLabel('Footer text (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(2048),
    ),
  );

  await interaction.showModal(modal);
}

async function onEmbedModal(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const title       = interaction.fields.getTextInputValue('title').trim();
  const description = interaction.fields.getTextInputValue('description').trim();
  const colorRaw    = interaction.fields.getTextInputValue('color').trim();
  const footer      = interaction.fields.getTextInputValue('footer').trim();

  let color = C.BRAND;
  if (colorRaw) {
    const parsed = parseInt(colorRaw.replace('#', ''), 16);
    if (!isNaN(parsed)) color = parsed;
  }

  const embed = new EmbedBuilder().setColor(color);
  if (title) embed.setTitle(truncate(title, DISCORD_LIMITS.EMBED_TITLE));
  embed.setDescription(truncate(description, DISCORD_LIMITS.EMBED_DESCRIPTION));
  if (footer) embed.setFooter({ text: truncate(footer, DISCORD_LIMITS.EMBED_FOOTER) });

  try {
    await interaction.channel.send({ embeds: [embed] });
    return interaction.reply({ content: '✅ Embed sent.', flags: MessageFlags.Ephemeral });
  } catch (e) {
    return interaction.reply({ content: `Failed to send: ${e?.message || 'Unknown error'}`, flags: MessageFlags.Ephemeral });
  }
}

// ──── Strike helpers ────

function getStrikes(g, userId) {
  if (!g.strikes) g.strikes = {};
  if (!g.strikes[userId]) g.strikes[userId] = { count: 0, history: [] };
  return g.strikes[userId];
}

// ──── /strikes give ────

async function handleStrikeGive(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') || null;

  const g = db.guild(interaction.guildId);
  const data = getStrikes(g, target.id);
  data.count += 1;
  data.history.push({ reason, by_id: interaction.user.id, at: Date.now() });
  await db.save();

  const isMax = data.count >= MAX_STRIKES;

  const embed = new EmbedBuilder()
    .setColor(isMax ? C.RED : C.ORANGE)
    .setTitle(isMax ? '🚨 Maximum Strikes Reached!' : '⚠️ Strike Issued')
    .setThumbnail(target.displayAvatarURL())
    .setDescription(
      isMax
        ? `${target} has **${data.count}/${MAX_STRIKES}** strikes and should be demoted!`
        : `${target} now has **${data.count}/${MAX_STRIKES}** strike${data.count !== 1 ? 's' : ''}.`,
    )
    .addFields(
      { name: 'User',      value: `${target} (${target.username})`,                     inline: true },
      { name: 'Moderator', value: `${interaction.user} (${interaction.user.username})`, inline: true },
      { name: 'Reason',    value: truncate(reason || '_No reason provided_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
    )
    .setFooter({ text: `Strike ${data.count}/${MAX_STRIKES} • User ID: ${target.id}` })
    .setTimestamp();

  await interaction.reply({
    content: `<@${target.id}>`,
    embeds: [embed],
    allowedMentions: { users: [target.id] },
  });
  await logger.log(interaction.client, interaction.guildId, embed);
}

// ──── /strikes remove ────

async function handleStrikeRemove(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const g = db.guild(interaction.guildId);
  const data = getStrikes(g, target.id);

  if (data.count <= 0) return interaction.reply({ content: `${target.username} has no strikes.`, flags: MessageFlags.Ephemeral });

  data.count -= 1;
  data.history.pop();
  await db.save();

  const embed = new EmbedBuilder()
    .setColor(C.GREEN)
    .setTitle('✅ Strike Removed')
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: 'User',             value: `${target} (${target.username})`,                     inline: true },
      { name: 'Moderator',        value: `${interaction.user} (${interaction.user.username})`, inline: true },
      { name: 'Remaining Strikes', value: `**${data.count}/${MAX_STRIKES}**`,                  inline: true },
    )
    .setFooter({ text: `User ID: ${target.id}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  await logger.log(interaction.client, interaction.guildId, embed);
}

// ──── /strikes check ────

async function handleStrikeCheck(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const g = db.guild(interaction.guildId);
  const data = getStrikes(g, target.id);

  const embed = new EmbedBuilder()
    .setColor(data.count >= MAX_STRIKES ? C.RED : data.count > 0 ? C.ORANGE : C.GREEN)
    .setTitle(`📋 Strikes: ${target.username}`)
    .setThumbnail(target.displayAvatarURL())
    .addFields({ name: 'Strikes', value: `**${data.count}/${MAX_STRIKES}**`, inline: true });

  if (data.history.length) {
    const lines = data.history.map((e, i) =>
      `**${i + 1}.** ${truncate(e.reason || '_No reason_', 80)} — <@${e.by_id}> — <t:${Math.floor(e.at / 1000)}:R>`,
    );
    embed.addFields({ name: 'History', value: truncate(lines.join('\n'), DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false });
  } else {
    embed.addFields({ name: 'History', value: '_No strikes_', inline: false });
  }

  embed.setFooter({ text: `User ID: ${target.id}` }).setTimestamp();
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ──── /strikes list ────

async function handleStrikeList(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });

  const g = db.guild(interaction.guildId);
  const entries = Object.entries(g.strikes || {})
    .filter(([, d]) => d.count > 0)
    .sort(([, a], [, b]) => b.count - a.count);

  if (!entries.length) return interaction.reply({ content: 'No strikes have been issued.', flags: MessageFlags.Ephemeral });

  const lines = entries.map(([userId, d]) =>
    `<@${userId}> — **${d.count}/${MAX_STRIKES}** strike${d.count !== 1 ? 's' : ''}`,
  );

  const embed = new EmbedBuilder()
    .setColor(C.ORANGE)
    .setTitle('📋 All Strikes')
    .setDescription(truncate(lines.join('\n'), DISCORD_LIMITS.EMBED_DESCRIPTION))
    .setFooter({ text: `${entries.length} user(s) with strikes` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ──── Register ────

function register(client) {
  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.inGuild()) return;

      if (interaction.isChatInputCommand()) {
        switch (interaction.commandName) {
          case 'ban':    return await handleBan(interaction);
          case 'kick':   return await handleKick(interaction);
          case 'mute':   return await handleMute(interaction);
          case 'purge':  return await handlePurge(interaction);
          case 'clear':  return await handleClear(interaction);
          case 'lock':   return await handleLock(interaction);
          case 'unlock': return await handleUnlock(interaction);
          case 'embed':  return await handleEmbed(interaction);
          case 'strikes': {
            const sub = interaction.options.getSubcommand();
            if (sub === 'give')   return await handleStrikeGive(interaction);
            if (sub === 'remove') return await handleStrikeRemove(interaction);
            if (sub === 'check')  return await handleStrikeCheck(interaction);
            if (sub === 'list')   return await handleStrikeList(interaction);
            break;
          }
        }
      }

      if (interaction.isModalSubmit() && interaction.customId === EMBED_MODAL_ID) {
        return await onEmbedModal(interaction);
      }
    } catch (err) {
      console.error('[moderation] error:', err);
      const opts = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(opts);
        else if (interaction.isRepliable?.()) await interaction.reply(opts);
      } catch { /* swallow */ }
    }
  });
}

module.exports = {
  commands: [banCommand, kickCommand, muteCommand, purgeCommand, clearCommand, lockCommand, unlockCommand, embedCommand, strikesCommand],
  register,
};
