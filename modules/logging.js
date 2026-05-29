'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  AuditLogEvent,
  ChannelType,
} = require('discord.js');

const db = require('../lib/db');
const { DISCORD_LIMITS, truncate } = require('../config');
const logger = require('../lib/logger');

const C = {
  GREEN:  0x57F287,
  RED:    0xED4245,
  BLUE:   0x5865F2,
  ORANGE: 0xFAA61A,
  YELLOW: 0xFEE75C,
  GRAY:   0x95A5A6,
};

function ts(ms) {
  return `<t:${Math.floor((ms || Date.now()) / 1000)}:F>`;
}

function rel(ms) {
  return `<t:${Math.floor((ms || Date.now()) / 1000)}:R>`;
}

function accountAge(createdAt) {
  const days = Math.floor((Date.now() - createdAt.getTime()) / 86400000);
  if (days < 1) return 'created today';
  if (days === 1) return '1 day old';
  if (days < 30) return `${days} days old`;
  if (days < 365) return `${Math.floor(days / 30)} months old`;
  return `${Math.floor(days / 365)} years old`;
}

function channelTypeName(type) {
  const names = {
    [ChannelType.GuildText]: 'Text',
    [ChannelType.GuildVoice]: 'Voice',
    [ChannelType.GuildCategory]: 'Category',
    [ChannelType.GuildForum]: 'Forum',
    [ChannelType.GuildStageVoice]: 'Stage',
    [ChannelType.GuildAnnouncement]: 'Announcement',
  };
  return names[type] || 'Unknown';
}

async function fetchAuditEntry(guild, type, targetId, delayMs = 600) {
  await new Promise((r) => setTimeout(r, delayMs));
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    return logs.entries.find((e) => {
      const recent = Date.now() - e.createdTimestamp < 6000;
      const matchTarget = !targetId || String(e.target?.id) === String(targetId);
      return recent && matchTarget;
    }) || null;
  } catch {
    return null;
  }
}

// ──── /log command ────

const logCommand = new SlashCommandBuilder()
  .setName('log')
  .setDescription('Manage the logging system')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s.setName('set').setDescription('Set the log channel (replaces existing)')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel for logs').setRequired(true)),
  )
  .addSubcommand((s) => s.setName('clear').setDescription('Disable logging'))
  .addSubcommand((s) => s.setName('status').setDescription('Show the current log channel'));

async function handleSet(interaction) {
  const channel = interaction.options.getChannel('channel', true);
  if (!channel.isTextBased() || channel.isDMBased()) {
    return interaction.reply({ content: 'Please select a text channel in this server.', flags: MessageFlags.Ephemeral });
  }
  const g = db.guild(interaction.guildId);
  const old = g.log_channel_id;
  g.log_channel_id = channel.id;
  await db.save();
  const note = old && old !== channel.id ? ` (replaced <#${old}>)` : '';
  return interaction.reply({ content: `Log channel set to ${channel}${note}.`, flags: MessageFlags.Ephemeral });
}

async function handleClear(interaction) {
  const g = db.guild(interaction.guildId);
  g.log_channel_id = null;
  await db.save();
  return interaction.reply({ content: 'Logging disabled.', flags: MessageFlags.Ephemeral });
}

async function handleStatus(interaction) {
  const g = db.guild(interaction.guildId);
  if (!g.log_channel_id) {
    return interaction.reply({ content: 'No log channel configured. Use `/log set` to set one.', flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({ content: `Current log channel: <#${g.log_channel_id}>`, flags: MessageFlags.Ephemeral });
}

// ──── Member Events ────

async function onMemberJoin(client, member) {
  const created = member.user.createdAt;
  const embed = new EmbedBuilder()
    .setColor(C.GREEN)
    .setTitle('👥 Member Joined')
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: 'User',           value: `${member.user} (${member.user.username})`, inline: true },
      { name: 'ID',             value: member.user.id, inline: true },
      { name: 'Account Created', value: `${ts(created.getTime())}\n${accountAge(created)}`, inline: true },
      { name: 'Member Count',   value: String(member.guild.memberCount), inline: true },
    )
    .setFooter({ text: `User ID: ${member.user.id}` })
    .setTimestamp();
  await logger.log(client, member.guild.id, embed);
}

async function onMemberLeave(client, member) {
  if (member.partial) {
    try { await member.fetch(); } catch { /* stay partial */ }
  }

  const kick = await fetchAuditEntry(member.guild, AuditLogEvent.MemberKick, member.user.id);

  const roles = member.roles?.cache
    .filter((r) => r.id !== member.guild.id)
    .map((r) => `<@&${r.id}>`)
    .join(', ') || '_None_';

  if (kick) {
    const embed = new EmbedBuilder()
      .setColor(C.ORANGE)
      .setTitle('👢 Member Kicked')
      .setThumbnail(member.user.displayAvatarURL())
      .addFields(
        { name: 'User',      value: `${member.user} (${member.user.username})`, inline: true },
        { name: 'Moderator', value: kick.executor ? `${kick.executor} (${kick.executor.username})` : '_Unknown_', inline: true },
        { name: 'Reason',    value: truncate(kick.reason || '_No reason provided_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
        { name: 'Roles',     value: truncate(roles, DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
        { name: 'Joined',    value: member.joinedAt ? ts(member.joinedAt.getTime()) : '_Unknown_', inline: true },
      )
      .setFooter({ text: `User ID: ${member.user.id}` })
      .setTimestamp();
    return logger.log(client, member.guild.id, embed);
  }

  const embed = new EmbedBuilder()
    .setColor(C.RED)
    .setTitle('👋 Member Left')
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: 'User',            value: `${member.user} (${member.user.username})`, inline: true },
      { name: 'ID',              value: member.user.id, inline: true },
      { name: 'Joined',          value: member.joinedAt ? ts(member.joinedAt.getTime()) : '_Unknown_', inline: true },
      { name: 'Account Created', value: `${ts(member.user.createdAt.getTime())}\n${accountAge(member.user.createdAt)}`, inline: true },
      { name: 'Roles',           value: truncate(roles, DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
    )
    .setFooter({ text: `User ID: ${member.user.id}` })
    .setTimestamp();
  await logger.log(client, member.guild.id, embed);
}

// ──── Message Events ────

async function onMessageDelete(client, message) {
  if (!message.guild) return;
  if (message.author?.bot) return;

  const embed = new EmbedBuilder()
    .setColor(C.ORANGE)
    .setTitle('🗑️ Message Deleted')
    .addFields(
      { name: 'Author',  value: message.author ? `${message.author} (${message.author.username})` : '_Unknown (not cached)_', inline: true },
      { name: 'Channel', value: `${message.channel}`, inline: true },
    )
    .setFooter({ text: `Message ID: ${message.id}` })
    .setTimestamp();

  if (message.createdAt) {
    embed.addFields({ name: 'Sent', value: ts(message.createdTimestamp), inline: true });
  }
  if (message.content) {
    embed.addFields({ name: 'Content', value: truncate(message.content, DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false });
  }
  if (message.attachments?.size) {
    const urls = [...message.attachments.values()].map((a) => a.proxyURL || a.url).join('\n');
    embed.addFields({ name: 'Attachments', value: truncate(urls, DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false });
  }

  await logger.log(client, message.guild.id, embed);
}

async function onMessageEdit(client, oldMsg, newMsg) {
  if (!newMsg.guild) return;
  if (newMsg.author?.bot) return;
  if (oldMsg.content === newMsg.content) return;
  if (!newMsg.author) return;

  const embed = new EmbedBuilder()
    .setColor(C.BLUE)
    .setTitle('✏️ Message Edited')
    .setURL(newMsg.url)
    .addFields(
      { name: 'Author',  value: `${newMsg.author} (${newMsg.author.username})`, inline: true },
      { name: 'Channel', value: `${newMsg.channel}`, inline: true },
      { name: 'Before',  value: truncate(oldMsg.content || '_Not cached_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
      { name: 'After',   value: truncate(newMsg.content || '_Empty_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
    )
    .setFooter({ text: `Message ID: ${newMsg.id}` })
    .setTimestamp();

  await logger.log(client, newMsg.guild.id, embed);
}

async function onMessageCreate(client, message) {
  if (!message.guild) return;
  if (message.author?.bot) return;
  if (!message.mentions.everyone) return;

  const pingType = message.content.includes('@everyone') ? '@everyone' : '@here';

  const embed = new EmbedBuilder()
    .setColor(C.RED)
    .setTitle(`📢 ${pingType} Ping Sent`)
    .setURL(message.url)
    .addFields(
      { name: 'Author',  value: `${message.author} (${message.author.username})`, inline: true },
      { name: 'Channel', value: `${message.channel}`, inline: true },
      { name: 'Message', value: truncate(message.content, DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
    )
    .setFooter({ text: `Message ID: ${message.id}` })
    .setTimestamp();

  await logger.log(client, message.guild.id, embed);
}

// ──── Channel Events ────

async function onChannelCreate(client, channel) {
  if (!channel.guild) return;
  const entry = await fetchAuditEntry(channel.guild, AuditLogEvent.ChannelCreate, channel.id);

  const embed = new EmbedBuilder()
    .setColor(C.GREEN)
    .setTitle('📁 Channel Created')
    .addFields(
      { name: 'Channel',    value: `${channel} (\`${channel.name}\`)`, inline: true },
      { name: 'Type',       value: channelTypeName(channel.type), inline: true },
      { name: 'Category',   value: channel.parent ? channel.parent.name : '_None_', inline: true },
      { name: 'Created by', value: entry?.executor ? `${entry.executor} (${entry.executor.username})` : '_Unknown_', inline: true },
    )
    .setFooter({ text: `Channel ID: ${channel.id}` })
    .setTimestamp();

  await logger.log(client, channel.guild.id, embed);
}

async function onChannelDelete(client, channel) {
  if (!channel.guild) return;
  const entry = await fetchAuditEntry(channel.guild, AuditLogEvent.ChannelDelete, channel.id);

  const embed = new EmbedBuilder()
    .setColor(C.RED)
    .setTitle('📁 Channel Deleted')
    .addFields(
      { name: 'Channel',    value: `\`#${channel.name}\``, inline: true },
      { name: 'Type',       value: channelTypeName(channel.type), inline: true },
      { name: 'Category',   value: channel.parent ? channel.parent.name : '_None_', inline: true },
      { name: 'Deleted by', value: entry?.executor ? `${entry.executor} (${entry.executor.username})` : '_Unknown_', inline: true },
    )
    .setFooter({ text: `Channel ID: ${channel.id}` })
    .setTimestamp();

  await logger.log(client, channel.guild.id, embed);
}

// ──── Moderation Events ────

async function onBanAdd(client, ban) {
  const entry = await fetchAuditEntry(ban.guild, AuditLogEvent.MemberBan, ban.user.id);

  const embed = new EmbedBuilder()
    .setColor(C.RED)
    .setTitle('🔨 Member Banned')
    .setThumbnail(ban.user.displayAvatarURL())
    .addFields(
      { name: 'User',      value: `${ban.user} (${ban.user.username})`, inline: true },
      { name: 'Moderator', value: entry?.executor ? `${entry.executor} (${entry.executor.username})` : '_Unknown_', inline: true },
      { name: 'Reason',    value: truncate(entry?.reason || ban.reason || '_No reason provided_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
    )
    .setFooter({ text: `User ID: ${ban.user.id}` })
    .setTimestamp();

  await logger.log(client, ban.guild.id, embed);
}

async function onBanRemove(client, ban) {
  const entry = await fetchAuditEntry(ban.guild, AuditLogEvent.MemberUnban, ban.user.id);

  const embed = new EmbedBuilder()
    .setColor(C.GREEN)
    .setTitle('✅ Member Unbanned')
    .setThumbnail(ban.user.displayAvatarURL())
    .addFields(
      { name: 'User',      value: `${ban.user} (${ban.user.username})`, inline: true },
      { name: 'Moderator', value: entry?.executor ? `${entry.executor} (${entry.executor.username})` : '_Unknown_', inline: true },
    )
    .setFooter({ text: `User ID: ${ban.user.id}` })
    .setTimestamp();

  await logger.log(client, ban.guild.id, embed);
}

async function onMemberUpdate(client, oldMember, newMember) {
  const guildId = newMember.guild.id;

  // Nickname
  if (oldMember.nickname !== newMember.nickname) {
    const entry = await fetchAuditEntry(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
    const embed = new EmbedBuilder()
      .setColor(C.YELLOW)
      .setTitle('📝 Nickname Changed')
      .setThumbnail(newMember.user.displayAvatarURL())
      .addFields(
        { name: 'User',       value: `${newMember.user} (${newMember.user.username})`, inline: true },
        { name: 'Changed by', value: entry?.executor ? `${entry.executor} (${entry.executor.username})` : '_Unknown_', inline: true },
        { name: 'Before',     value: truncate(oldMember.nickname || `_${oldMember.user.username} (no nick)_`, 256), inline: true },
        { name: 'After',      value: truncate(newMember.nickname || `_${newMember.user.username} (removed)_`, 256), inline: true },
      )
      .setFooter({ text: `User ID: ${newMember.user.id}` })
      .setTimestamp();
    await logger.log(client, guildId, embed);
  }

  // Timeout
  const wasTimedOut  = oldMember.communicationDisabledUntil && !newMember.communicationDisabledUntil;
  const isNowTimedOut = !oldMember.communicationDisabledUntil && newMember.communicationDisabledUntil;

  if (isNowTimedOut) {
    const entry = await fetchAuditEntry(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
    const until = newMember.communicationDisabledUntilTimestamp;
    const embed = new EmbedBuilder()
      .setColor(C.ORANGE)
      .setTitle('🔇 Member Muted (Timeout)')
      .setThumbnail(newMember.user.displayAvatarURL())
      .addFields(
        { name: 'User',      value: `${newMember.user} (${newMember.user.username})`, inline: true },
        { name: 'Moderator', value: entry?.executor ? `${entry.executor} (${entry.executor.username})` : '_Unknown_', inline: true },
        { name: 'Until',     value: until ? `${ts(until)} (${rel(until)})` : '_Unknown_', inline: false },
        { name: 'Reason',    value: truncate(entry?.reason || '_No reason provided_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
      )
      .setFooter({ text: `User ID: ${newMember.user.id}` })
      .setTimestamp();
    await logger.log(client, guildId, embed);
  } else if (wasTimedOut) {
    const entry = await fetchAuditEntry(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
    const embed = new EmbedBuilder()
      .setColor(C.GREEN)
      .setTitle('🔊 Timeout Lifted (Unmute)')
      .setThumbnail(newMember.user.displayAvatarURL())
      .addFields(
        { name: 'User',      value: `${newMember.user} (${newMember.user.username})`, inline: true },
        { name: 'Moderator', value: entry?.executor ? `${entry.executor} (${entry.executor.username})` : '_Unknown_', inline: true },
      )
      .setFooter({ text: `User ID: ${newMember.user.id}` })
      .setTimestamp();
    await logger.log(client, guildId, embed);
  }

  // Roles
  const oldRoles = new Set(oldMember.roles.cache.keys());
  const newRoles = new Set(newMember.roles.cache.keys());
  const added    = [...newRoles].filter((id) => !oldRoles.has(id) && id !== newMember.guild.id);
  const removed  = [...oldRoles].filter((id) => !newRoles.has(id) && id !== newMember.guild.id);

  if (added.length || removed.length) {
    const entry = await fetchAuditEntry(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
    const title = added.length && removed.length ? '🏷️ Roles Updated'
      : added.length ? '🏷️ Role Added' : '🏷️ Role Removed';
    const embed = new EmbedBuilder()
      .setColor(added.length ? C.BLUE : C.GRAY)
      .setTitle(title)
      .setThumbnail(newMember.user.displayAvatarURL())
      .addFields(
        { name: 'User',       value: `${newMember.user} (${newMember.user.username})`, inline: true },
        { name: 'Changed by', value: entry?.executor ? `${entry.executor} (${entry.executor.username})` : '_Unknown_', inline: true },
      );
    if (added.length)   embed.addFields({ name: '✅ Added',   value: added.map((id) => `<@&${id}>`).join(', '), inline: false });
    if (removed.length) embed.addFields({ name: '❌ Removed', value: removed.map((id) => `<@&${id}>`).join(', '), inline: false });
    embed.setFooter({ text: `User ID: ${newMember.user.id}` }).setTimestamp();
    await logger.log(client, guildId, embed);
  }
}

// ──── Voice Events ────

async function onVoiceUpdate(client, oldState, newState) {
  const guildId = newState.guild?.id || oldState.guild?.id;
  if (!guildId) return;
  const member = newState.member || oldState.member;
  if (!member || member.user?.bot) return;

  const oldCh = oldState.channel;
  const newCh = newState.channel;

  let embed;
  if (!oldCh && newCh) {
    embed = new EmbedBuilder()
      .setColor(C.GREEN)
      .setTitle('🔊 Joined Voice')
      .addFields(
        { name: 'User',    value: `${member.user} (${member.user.username})`, inline: true },
        { name: 'Channel', value: `\`${newCh.name}\``, inline: true },
      );
  } else if (oldCh && !newCh) {
    embed = new EmbedBuilder()
      .setColor(C.RED)
      .setTitle('🔇 Left Voice')
      .addFields(
        { name: 'User',    value: `${member.user} (${member.user.username})`, inline: true },
        { name: 'Channel', value: `\`${oldCh.name}\``, inline: true },
      );
  } else if (oldCh && newCh && oldCh.id !== newCh.id) {
    embed = new EmbedBuilder()
      .setColor(C.BLUE)
      .setTitle('🔀 Switched Voice')
      .addFields(
        { name: 'User', value: `${member.user} (${member.user.username})`, inline: true },
        { name: 'From', value: `\`${oldCh.name}\``, inline: true },
        { name: 'To',   value: `\`${newCh.name}\``, inline: true },
      );
  } else {
    return;
  }

  embed.setFooter({ text: `User ID: ${member.user.id}` }).setTimestamp();
  await logger.log(client, guildId, embed);
}

// ──── Register ────

function register(client) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'log') return;
    if (!interaction.inGuild()) return interaction.reply({ content: 'Server only.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === 'set')    return await handleSet(interaction);
      if (sub === 'clear')  return await handleClear(interaction);
      if (sub === 'status') return await handleStatus(interaction);
    } catch (err) {
      console.error('[log] command error:', err);
      const opts = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(opts).catch(() => {});
      else await interaction.reply(opts).catch(() => {});
    }
  });

  client.on('guildMemberAdd',    (m)    => onMemberJoin(client, m).catch((e)       => console.error('[log:join]',    e?.message)));
  client.on('guildMemberRemove', (m)    => onMemberLeave(client, m).catch((e)      => console.error('[log:leave]',   e?.message)));
  client.on('messageDelete',     (msg)  => onMessageDelete(client, msg).catch((e)  => console.error('[log:msgDel]',  e?.message)));
  client.on('messageUpdate',     (o, n) => onMessageEdit(client, o, n).catch((e)   => console.error('[log:msgEdit]', e?.message)));
  client.on('messageCreate',     (msg)  => onMessageCreate(client, msg).catch((e)  => console.error('[log:msgNew]',  e?.message)));
  client.on('channelCreate',     (ch)   => onChannelCreate(client, ch).catch((e)   => console.error('[log:chNew]',   e?.message)));
  client.on('channelDelete',     (ch)   => onChannelDelete(client, ch).catch((e)   => console.error('[log:chDel]',   e?.message)));
  client.on('guildBanAdd',       (ban)  => onBanAdd(client, ban).catch((e)         => console.error('[log:banAdd]',  e?.message)));
  client.on('guildBanRemove',    (ban)  => onBanRemove(client, ban).catch((e)      => console.error('[log:banRem]',  e?.message)));
  client.on('guildMemberUpdate', (o, n) => onMemberUpdate(client, o, n).catch((e) => console.error('[log:memUpd]',  e?.message)));
  client.on('voiceStateUpdate',  (o, n) => onVoiceUpdate(client, o, n).catch((e)  => console.error('[log:voice]',   e?.message)));
}

module.exports = {
  commands: [logCommand],
  register,
};
