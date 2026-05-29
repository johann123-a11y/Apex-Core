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
  if (days < 1) return 'heute erstellt';
  if (days === 1) return '1 Tag alt';
  if (days < 30) return `${days} Tage alt`;
  if (days < 365) return `${Math.floor(days / 30)} Monate alt`;
  return `${Math.floor(days / 365)} Jahre alt`;
}

function channelTypeName(type) {
  const names = {
    [ChannelType.GuildText]: 'Text',
    [ChannelType.GuildVoice]: 'Voice',
    [ChannelType.GuildCategory]: 'Kategorie',
    [ChannelType.GuildForum]: 'Forum',
    [ChannelType.GuildStageVoice]: 'Stage',
    [ChannelType.GuildAnnouncement]: 'Ankündigung',
  };
  return names[type] || 'Unbekannt';
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
  .setDescription('Logging-System verwalten')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s.setName('set').setDescription('Log-Channel setzen (ersetzt bestehenden)')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel für Logs').setRequired(true)),
  )
  .addSubcommand((s) => s.setName('clear').setDescription('Logging deaktivieren'))
  .addSubcommand((s) => s.setName('status').setDescription('Aktuellen Log-Channel anzeigen'));

async function handleSet(interaction) {
  const channel = interaction.options.getChannel('channel', true);
  if (!channel.isTextBased() || channel.isDMBased()) {
    return interaction.reply({ content: 'Bitte einen Text-Channel in diesem Server auswählen.', flags: MessageFlags.Ephemeral });
  }
  const g = db.guild(interaction.guildId);
  const old = g.log_channel_id;
  g.log_channel_id = channel.id;
  await db.save();
  const note = old && old !== channel.id ? ` (ersetzt <#${old}>)` : '';
  return interaction.reply({ content: `Log-Channel gesetzt: ${channel}${note}.`, flags: MessageFlags.Ephemeral });
}

async function handleClear(interaction) {
  const g = db.guild(interaction.guildId);
  g.log_channel_id = null;
  await db.save();
  return interaction.reply({ content: 'Logging deaktiviert.', flags: MessageFlags.Ephemeral });
}

async function handleStatus(interaction) {
  const g = db.guild(interaction.guildId);
  if (!g.log_channel_id) {
    return interaction.reply({ content: 'Kein Log-Channel konfiguriert. Nutze `/log set` zum Einrichten.', flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({ content: `Aktueller Log-Channel: <#${g.log_channel_id}>`, flags: MessageFlags.Ephemeral });
}

// ──── Member Events ────

async function onMemberJoin(client, member) {
  const created = member.user.createdAt;
  const embed = new EmbedBuilder()
    .setColor(C.GREEN)
    .setTitle('👥 Member beigetreten')
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${member.user} (${member.user.tag})`, inline: true },
      { name: 'ID', value: member.user.id, inline: true },
      { name: 'Account erstellt', value: `${ts(created.getTime())}\n${accountAge(created)}`, inline: true },
      { name: 'Member-Count', value: String(member.guild.memberCount), inline: true },
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
    .join(', ') || '_Keine_';

  if (kick) {
    const embed = new EmbedBuilder()
      .setColor(C.ORANGE)
      .setTitle('👢 Member gekickt')
      .setThumbnail(member.user.displayAvatarURL())
      .addFields(
        { name: 'User', value: `${member.user} (${member.user.tag})`, inline: true },
        { name: 'Moderator', value: kick.executor ? `${kick.executor} (${kick.executor.tag})` : '_Unbekannt_', inline: true },
        { name: 'Grund', value: truncate(kick.reason || '_Kein Grund angegeben_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
        { name: 'Rollen', value: truncate(roles, DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
        { name: 'Beigetreten', value: member.joinedAt ? ts(member.joinedAt.getTime()) : '_Unbekannt_', inline: true },
      )
      .setFooter({ text: `User ID: ${member.user.id}` })
      .setTimestamp();
    return logger.log(client, member.guild.id, embed);
  }

  const embed = new EmbedBuilder()
    .setColor(C.RED)
    .setTitle('👋 Member verlassen')
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${member.user} (${member.user.tag})`, inline: true },
      { name: 'ID', value: member.user.id, inline: true },
      { name: 'Beigetreten', value: member.joinedAt ? ts(member.joinedAt.getTime()) : '_Unbekannt_', inline: true },
      { name: 'Account erstellt', value: `${ts(member.user.createdAt.getTime())}\n${accountAge(member.user.createdAt)}`, inline: true },
      { name: 'Rollen', value: truncate(roles, DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
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
    .setTitle('🗑️ Nachricht gelöscht')
    .addFields(
      { name: 'Autor', value: message.author ? `${message.author} (${message.author.tag})` : '_Unbekannt (nicht gecacht)_', inline: true },
      { name: 'Channel', value: `${message.channel}`, inline: true },
    )
    .setFooter({ text: `Message ID: ${message.id}` })
    .setTimestamp();

  if (message.createdAt) {
    embed.addFields({ name: 'Gesendet', value: ts(message.createdTimestamp), inline: true });
  }
  if (message.content) {
    embed.addFields({ name: 'Inhalt', value: truncate(message.content, DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false });
  }
  if (message.attachments?.size) {
    const urls = [...message.attachments.values()].map((a) => a.proxyURL || a.url).join('\n');
    embed.addFields({ name: 'Anhänge', value: truncate(urls, DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false });
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
    .setTitle('✏️ Nachricht bearbeitet')
    .setURL(newMsg.url)
    .addFields(
      { name: 'Autor', value: `${newMsg.author} (${newMsg.author.tag})`, inline: true },
      { name: 'Channel', value: `${newMsg.channel}`, inline: true },
      { name: 'Vorher', value: truncate(oldMsg.content || '_Nicht gecacht_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
      { name: 'Nachher', value: truncate(newMsg.content || '_Leer_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
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
    .setTitle(`📢 ${pingType} Ping gesendet`)
    .setURL(message.url)
    .addFields(
      { name: 'Autor', value: `${message.author} (${message.author.tag})`, inline: true },
      { name: 'Channel', value: `${message.channel}`, inline: true },
      { name: 'Nachricht', value: truncate(message.content, DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
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
    .setTitle('📁 Channel erstellt')
    .addFields(
      { name: 'Channel', value: `${channel} (\`${channel.name}\`)`, inline: true },
      { name: 'Typ', value: channelTypeName(channel.type), inline: true },
      { name: 'Kategorie', value: channel.parent ? channel.parent.name : '_Keine_', inline: true },
      { name: 'Erstellt von', value: entry?.executor ? `${entry.executor} (${entry.executor.tag})` : '_Unbekannt_', inline: true },
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
    .setTitle('📁 Channel gelöscht')
    .addFields(
      { name: 'Channel', value: `\`#${channel.name}\``, inline: true },
      { name: 'Typ', value: channelTypeName(channel.type), inline: true },
      { name: 'Kategorie', value: channel.parent ? channel.parent.name : '_Keine_', inline: true },
      { name: 'Gelöscht von', value: entry?.executor ? `${entry.executor} (${entry.executor.tag})` : '_Unbekannt_', inline: true },
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
    .setTitle('🔨 Member gebannt')
    .setThumbnail(ban.user.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${ban.user} (${ban.user.tag})`, inline: true },
      { name: 'Moderator', value: entry?.executor ? `${entry.executor} (${entry.executor.tag})` : '_Unbekannt_', inline: true },
      { name: 'Grund', value: truncate(entry?.reason || ban.reason || '_Kein Grund angegeben_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
    )
    .setFooter({ text: `User ID: ${ban.user.id}` })
    .setTimestamp();

  await logger.log(client, ban.guild.id, embed);
}

async function onBanRemove(client, ban) {
  const entry = await fetchAuditEntry(ban.guild, AuditLogEvent.MemberUnban, ban.user.id);

  const embed = new EmbedBuilder()
    .setColor(C.GREEN)
    .setTitle('✅ Member entbannt')
    .setThumbnail(ban.user.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${ban.user} (${ban.user.tag})`, inline: true },
      { name: 'Moderator', value: entry?.executor ? `${entry.executor} (${entry.executor.tag})` : '_Unbekannt_', inline: true },
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
      .setTitle('📝 Nickname geändert')
      .setThumbnail(newMember.user.displayAvatarURL())
      .addFields(
        { name: 'User', value: `${newMember.user} (${newMember.user.tag})`, inline: true },
        { name: 'Geändert von', value: entry?.executor ? `${entry.executor} (${entry.executor.tag})` : '_Unbekannt_', inline: true },
        { name: 'Vorher', value: truncate(oldMember.nickname || `_${oldMember.user.username} (kein Nick)_`, 256), inline: true },
        { name: 'Nachher', value: truncate(newMember.nickname || `_${newMember.user.username} (entfernt)_`, 256), inline: true },
      )
      .setFooter({ text: `User ID: ${newMember.user.id}` })
      .setTimestamp();
    await logger.log(client, guildId, embed);
  }

  // Timeout (Mute/Unmute via Discord)
  const wasTimedOut = oldMember.communicationDisabledUntil && !newMember.communicationDisabledUntil;
  const isNowTimedOut = !oldMember.communicationDisabledUntil && newMember.communicationDisabledUntil;

  if (isNowTimedOut) {
    const entry = await fetchAuditEntry(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
    const until = newMember.communicationDisabledUntilTimestamp;
    const embed = new EmbedBuilder()
      .setColor(C.ORANGE)
      .setTitle('🔇 Member gemutet (Timeout)')
      .setThumbnail(newMember.user.displayAvatarURL())
      .addFields(
        { name: 'User', value: `${newMember.user} (${newMember.user.tag})`, inline: true },
        { name: 'Moderator', value: entry?.executor ? `${entry.executor} (${entry.executor.tag})` : '_Unbekannt_', inline: true },
        { name: 'Bis', value: until ? `${ts(until)} (${rel(until)})` : '_Unbekannt_', inline: false },
        { name: 'Grund', value: truncate(entry?.reason || '_Kein Grund angegeben_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
      )
      .setFooter({ text: `User ID: ${newMember.user.id}` })
      .setTimestamp();
    await logger.log(client, guildId, embed);
  } else if (wasTimedOut) {
    const entry = await fetchAuditEntry(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
    const embed = new EmbedBuilder()
      .setColor(C.GREEN)
      .setTitle('🔊 Timeout aufgehoben (Unmute)')
      .setThumbnail(newMember.user.displayAvatarURL())
      .addFields(
        { name: 'User', value: `${newMember.user} (${newMember.user.tag})`, inline: true },
        { name: 'Moderator', value: entry?.executor ? `${entry.executor} (${entry.executor.tag})` : '_Unbekannt_', inline: true },
      )
      .setFooter({ text: `User ID: ${newMember.user.id}` })
      .setTimestamp();
    await logger.log(client, guildId, embed);
  }

  // Rollen
  const oldRoles = new Set(oldMember.roles.cache.keys());
  const newRoles = new Set(newMember.roles.cache.keys());
  const added   = [...newRoles].filter((id) => !oldRoles.has(id) && id !== newMember.guild.id);
  const removed = [...oldRoles].filter((id) => !newRoles.has(id) && id !== newMember.guild.id);

  if (added.length || removed.length) {
    const entry = await fetchAuditEntry(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
    const title = added.length && removed.length ? '🏷️ Rollen aktualisiert'
      : added.length ? '🏷️ Rolle hinzugefügt' : '🏷️ Rolle entfernt';
    const embed = new EmbedBuilder()
      .setColor(added.length ? C.BLUE : C.GRAY)
      .setTitle(title)
      .setThumbnail(newMember.user.displayAvatarURL())
      .addFields(
        { name: 'User', value: `${newMember.user} (${newMember.user.tag})`, inline: true },
        { name: 'Geändert von', value: entry?.executor ? `${entry.executor} (${entry.executor.tag})` : '_Unbekannt_', inline: true },
      );
    if (added.length)   embed.addFields({ name: '✅ Hinzugefügt', value: added.map((id) => `<@&${id}>`).join(', '), inline: false });
    if (removed.length) embed.addFields({ name: '❌ Entfernt',    value: removed.map((id) => `<@&${id}>`).join(', '), inline: false });
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
      .setTitle('🔊 Voice beigetreten')
      .addFields(
        { name: 'User', value: `${member.user} (${member.user.tag})`, inline: true },
        { name: 'Channel', value: `\`${newCh.name}\``, inline: true },
      );
  } else if (oldCh && !newCh) {
    embed = new EmbedBuilder()
      .setColor(C.RED)
      .setTitle('🔇 Voice verlassen')
      .addFields(
        { name: 'User', value: `${member.user} (${member.user.tag})`, inline: true },
        { name: 'Channel', value: `\`${oldCh.name}\``, inline: true },
      );
  } else if (oldCh && newCh && oldCh.id !== newCh.id) {
    embed = new EmbedBuilder()
      .setColor(C.BLUE)
      .setTitle('🔀 Voice gewechselt')
      .addFields(
        { name: 'User', value: `${member.user} (${member.user.tag})`, inline: true },
        { name: 'Von', value: `\`${oldCh.name}\``, inline: true },
        { name: 'Nach', value: `\`${newCh.name}\``, inline: true },
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
    if (!interaction.inGuild()) return interaction.reply({ content: 'Nur in Servern nutzbar.', flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === 'set')    return await handleSet(interaction);
      if (sub === 'clear')  return await handleClear(interaction);
      if (sub === 'status') return await handleStatus(interaction);
    } catch (err) {
      console.error('[log] command error:', err);
      const opts = { content: 'Etwas ist schiefgelaufen.', flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(opts).catch(() => {});
      else await interaction.reply(opts).catch(() => {});
    }
  });

  client.on('guildMemberAdd',    (m)       => onMemberJoin(client, m).catch((e)        => console.error('[log:join]',    e?.message)));
  client.on('guildMemberRemove', (m)       => onMemberLeave(client, m).catch((e)       => console.error('[log:leave]',   e?.message)));
  client.on('messageDelete',     (msg)     => onMessageDelete(client, msg).catch((e)   => console.error('[log:msgDel]',  e?.message)));
  client.on('messageUpdate',     (o, n)    => onMessageEdit(client, o, n).catch((e)    => console.error('[log:msgEdit]', e?.message)));
  client.on('messageCreate',     (msg)     => onMessageCreate(client, msg).catch((e)   => console.error('[log:msgNew]',  e?.message)));
  client.on('channelCreate',     (ch)      => onChannelCreate(client, ch).catch((e)    => console.error('[log:chNew]',   e?.message)));
  client.on('channelDelete',     (ch)      => onChannelDelete(client, ch).catch((e)    => console.error('[log:chDel]',   e?.message)));
  client.on('guildBanAdd',       (ban)     => onBanAdd(client, ban).catch((e)          => console.error('[log:banAdd]',  e?.message)));
  client.on('guildBanRemove',    (ban)     => onBanRemove(client, ban).catch((e)       => console.error('[log:banRem]',  e?.message)));
  client.on('guildMemberUpdate', (o, n)    => onMemberUpdate(client, o, n).catch((e)  => console.error('[log:memUpd]',  e?.message)));
  client.on('voiceStateUpdate',  (o, n)    => onVoiceUpdate(client, o, n).catch((e)   => console.error('[log:voice]',   e?.message)));
}

module.exports = {
  commands: [logCommand],
  register,
};
