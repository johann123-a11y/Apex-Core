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
  .setDescription('Einen User bannen')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addUserOption((o) => o.setName('user').setDescription('Zu bannender User').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Grund').setRequired(false).setMaxLength(512));

const kickCommand = new SlashCommandBuilder()
  .setName('kick')
  .setDescription('Einen User kicken')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addUserOption((o) => o.setName('user').setDescription('Zu kickender User').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Grund').setRequired(false).setMaxLength(512));

const muteCommand = new SlashCommandBuilder()
  .setName('mute')
  .setDescription('Einen Member per Timeout muten')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .setDMPermission(false)
  .addUserOption((o) => o.setName('user').setDescription('Zu mutender Member').setRequired(true))
  .addIntegerOption((o) => o.setName('duration').setDescription('Dauer in Minuten (Standard: 60)').setRequired(false).setMinValue(1).setMaxValue(40320))
  .addStringOption((o) => o.setName('reason').setDescription('Grund').setRequired(false).setMaxLength(512));

const purgeCommand = new SlashCommandBuilder()
  .setName('purge')
  .setDescription('Nachrichten eines bestimmten Users löschen')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addUserOption((o) => o.setName('user').setDescription('User dessen Nachrichten gelöscht werden').setRequired(true))
  .addIntegerOption((o) => o.setName('amount').setDescription('Anzahl zu löschender Nachrichten (max 100)').setRequired(true).setMinValue(1).setMaxValue(100));

const clearCommand = new SlashCommandBuilder()
  .setName('clear')
  .setDescription('Eine bestimmte Anzahl Nachrichten löschen')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addIntegerOption((o) => o.setName('amount').setDescription('Anzahl zu löschender Nachrichten (max 100)').setRequired(true).setMinValue(1).setMaxValue(100));

const lockCommand = new SlashCommandBuilder()
  .setName('lock')
  .setDescription('Channel für alle non-Staff sperren')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .setDMPermission(false);

const unlockCommand = new SlashCommandBuilder()
  .setName('unlock')
  .setDescription('Channel wieder entsperren')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .setDMPermission(false);

const embedCommand = new SlashCommandBuilder()
  .setName('embed')
  .setDescription('Eine Embed-Nachricht senden')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

const strikesCommand = new SlashCommandBuilder()
  .setName('strikes')
  .setDescription('Strike-System')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s.setName('give').setDescription('Einem User einen Strike geben')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Grund').setRequired(false).setMaxLength(512)),
  )
  .addSubcommand((s) =>
    s.setName('remove').setDescription('Einen Strike entfernen')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
  )
  .addSubcommand((s) =>
    s.setName('check').setDescription('Strikes eines Users anzeigen')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
  )
  .addSubcommand((s) => s.setName('list').setDescription('Alle Strikes anzeigen'));

// ──── /ban ────

async function handleBan(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Nur Admins können bannen.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') || null;

  if (target.id === interaction.user.id) return interaction.reply({ content: 'Du kannst dich nicht selbst bannen.', flags: MessageFlags.Ephemeral });

  const member = interaction.guild.members.cache.get(target.id);
  if (member && !member.bannable) return interaction.reply({ content: 'Dieser User kann nicht gebannt werden (höhere Rolle oder Bot).', flags: MessageFlags.Ephemeral });

  try {
    await interaction.guild.members.ban(target.id, { reason: reason || undefined, deleteMessageSeconds: 0 });
  } catch (e) {
    return interaction.reply({ content: `Bann fehlgeschlagen: ${e?.message || 'Unbekannt'}`, flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setColor(C.RED)
    .setTitle('🔨 User gebannt')
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${target} (${target.tag})`, inline: true },
      { name: 'Moderator', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
      { name: 'Grund', value: truncate(reason || '_Kein Grund angegeben_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
    )
    .setFooter({ text: `User ID: ${target.id}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
  await logger.log(interaction.client, interaction.guildId, embed);
}

// ──── /kick ────

async function handleKick(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Nur Admins können kicken.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getMember('user');
  if (!target) return interaction.reply({ content: 'User nicht im Server gefunden.', flags: MessageFlags.Ephemeral });
  if (target.id === interaction.user.id) return interaction.reply({ content: 'Du kannst dich nicht selbst kicken.', flags: MessageFlags.Ephemeral });
  if (!target.kickable) return interaction.reply({ content: 'Dieser User kann nicht gekickt werden (höhere Rolle oder Bot).', flags: MessageFlags.Ephemeral });

  const reason = interaction.options.getString('reason') || null;

  try {
    await target.kick(reason || undefined);
  } catch (e) {
    return interaction.reply({ content: `Kick fehlgeschlagen: ${e?.message || 'Unbekannt'}`, flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setColor(C.ORANGE)
    .setTitle('👢 User gekickt')
    .setThumbnail(target.user.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${target.user} (${target.user.tag})`, inline: true },
      { name: 'Moderator', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
      { name: 'Grund', value: truncate(reason || '_Kein Grund angegeben_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
    )
    .setFooter({ text: `User ID: ${target.id}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
  await logger.log(interaction.client, interaction.guildId, embed);
}

// ──── /mute ────

async function handleMute(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Nur Staff kann muten.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getMember('user');
  if (!target) return interaction.reply({ content: 'User nicht im Server gefunden.', flags: MessageFlags.Ephemeral });
  if (target.id === interaction.user.id) return interaction.reply({ content: 'Du kannst dich nicht selbst muten.', flags: MessageFlags.Ephemeral });
  if (!target.moderatable) return interaction.reply({ content: 'Dieser User kann nicht gemutet werden.', flags: MessageFlags.Ephemeral });

  const durationMinutes = interaction.options.getInteger('duration') || 60;
  const reason = interaction.options.getString('reason') || null;
  const until = new Date(Date.now() + durationMinutes * 60 * 1000);

  try {
    await target.timeout(durationMinutes * 60 * 1000, reason || undefined);
  } catch (e) {
    return interaction.reply({ content: `Mute fehlgeschlagen: ${e?.message || 'Unbekannt'}`, flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setColor(C.ORANGE)
    .setTitle('🔇 Member gemutet')
    .setThumbnail(target.user.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${target.user} (${target.user.tag})`, inline: true },
      { name: 'Moderator', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
      { name: 'Dauer', value: `${durationMinutes} Min.`, inline: true },
      { name: 'Bis', value: `<t:${Math.floor(until.getTime() / 1000)}:F>`, inline: true },
      { name: 'Grund', value: truncate(reason || '_Kein Grund angegeben_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
    )
    .setFooter({ text: `User ID: ${target.id}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
  await logger.log(interaction.client, interaction.guildId, embed);
}

// ──── /purge ────

async function handlePurge(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Nur Admins können purgen.', flags: MessageFlags.Ephemeral });

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
      return interaction.editReply({ content: `Keine Nachrichten von ${target.tag} gefunden (oder älter als 14 Tage).` });
    }

    const deleted = await interaction.channel.bulkDelete(toDelete, true);

    const embed = new EmbedBuilder()
      .setColor(C.ORANGE)
      .setTitle('🧹 Purge ausgeführt')
      .addFields(
        { name: 'Target', value: `${target} (${target.tag})`, inline: true },
        { name: 'Moderator', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
        { name: 'Gelöscht', value: `${deleted.size}`, inline: true },
        { name: 'Channel', value: `${interaction.channel}`, inline: true },
      )
      .setFooter({ text: `Target ID: ${target.id}` })
      .setTimestamp();

    await interaction.editReply({ content: `${deleted.size} Nachricht${deleted.size !== 1 ? 'en' : ''} von ${target.tag} gelöscht.` });
    await logger.log(interaction.client, interaction.guildId, embed);
  } catch (e) {
    await interaction.editReply({ content: `Purge fehlgeschlagen: ${e?.message || 'Unbekannt'}` });
  }
}

// ──── /clear ────

async function handleClear(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Nur Admins können clearen.', flags: MessageFlags.Ephemeral });

  const amount = interaction.options.getInteger('amount', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const deleted = await interaction.channel.bulkDelete(amount, true);

    const embed = new EmbedBuilder()
      .setColor(C.ORANGE)
      .setTitle('🧹 Channel gecleart')
      .addFields(
        { name: 'Moderator', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
        { name: 'Gelöscht', value: `${deleted.size}`, inline: true },
        { name: 'Channel', value: `${interaction.channel}`, inline: true },
      )
      .setFooter({ text: `Angefragt: ${amount}` })
      .setTimestamp();

    await interaction.editReply({ content: `${deleted.size} Nachricht${deleted.size !== 1 ? 'en' : ''} gelöscht.` });
    await logger.log(interaction.client, interaction.guildId, embed);
  } catch (e) {
    await interaction.editReply({ content: `Clear fehlgeschlagen: ${e?.message || 'Unbekannt'}` });
  }
}

// ──── /lock & /unlock ────

async function handleLock(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Nur Staff kann den Channel sperren.', flags: MessageFlags.Ephemeral });

  const g = db.guild(interaction.guildId);
  const everyone = interaction.guild.roles.everyone;

  try {
    await interaction.channel.permissionOverwrites.edit(everyone.id, {
      SendMessages: false,
      AddReactions: false,
    }, { reason: `Locked by ${interaction.user.tag}` });

    if (g.staff_role_id) {
      await interaction.channel.permissionOverwrites.edit(g.staff_role_id, {
        SendMessages: true,
        AddReactions: true,
      }, { reason: 'Lock — keeping staff access' });
    }
  } catch (e) {
    return interaction.reply({ content: `Lock fehlgeschlagen: ${e?.message || 'Unbekannt'}`, flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setColor(C.RED)
    .setTitle('🔒 Channel gesperrt')
    .setDescription(`${interaction.channel} wurde für non-Staff gesperrt.`)
    .addFields({ name: 'Gesperrt von', value: `${interaction.user} (${interaction.user.tag})`, inline: true })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
  await logger.log(interaction.client, interaction.guildId, embed);
}

async function handleUnlock(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Nur Staff kann den Channel entsperren.', flags: MessageFlags.Ephemeral });

  try {
    await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, {
      SendMessages: null,
      AddReactions: null,
    }, { reason: `Unlocked by ${interaction.user.tag}` });
  } catch (e) {
    return interaction.reply({ content: `Unlock fehlgeschlagen: ${e?.message || 'Unbekannt'}`, flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setColor(C.GREEN)
    .setTitle('🔓 Channel entsperrt')
    .setDescription(`${interaction.channel} ist wieder offen für alle.`)
    .addFields({ name: 'Entsperrt von', value: `${interaction.user} (${interaction.user.tag})`, inline: true })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
  await logger.log(interaction.client, interaction.guildId, embed);
}

// ──── /embed ────

async function handleEmbed(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Nur Admins können Embeds senden.', flags: MessageFlags.Ephemeral });

  const modal = new ModalBuilder()
    .setCustomId(EMBED_MODAL_ID)
    .setTitle('Embed erstellen');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('title').setLabel('Titel (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(256),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('description').setLabel('Text / Inhalt').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('color').setLabel('Farbe: Hex z.B. #5865F2 (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(7).setPlaceholder('#5865F2'),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('footer').setLabel('Footer Text (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(2048),
    ),
  );

  await interaction.showModal(modal);
}

async function onEmbedModal(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Nur Admins.', flags: MessageFlags.Ephemeral });

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
    return interaction.reply({ content: '✅ Embed gesendet.', flags: MessageFlags.Ephemeral });
  } catch (e) {
    return interaction.reply({ content: `Fehler beim Senden: ${e?.message || 'Unbekannt'}`, flags: MessageFlags.Ephemeral });
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
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Nur Admins können Strikes vergeben.', flags: MessageFlags.Ephemeral });

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
    .setTitle(isMax ? '🚨 Maximale Strikes erreicht!' : '⚠️ Strike vergeben')
    .setThumbnail(target.displayAvatarURL())
    .setDescription(
      isMax
        ? `${target} hat **${data.count}/${MAX_STRIKES}** Strikes und sollte degradiert werden!`
        : `${target} hat jetzt **${data.count}/${MAX_STRIKES}** Strike${data.count !== 1 ? 's' : ''}.`,
    )
    .addFields(
      { name: 'User', value: `${target} (${target.tag})`, inline: true },
      { name: 'Moderator', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
      { name: 'Grund', value: truncate(reason || '_Kein Grund angegeben_', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
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
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Nur Admins können Strikes entfernen.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const g = db.guild(interaction.guildId);
  const data = getStrikes(g, target.id);

  if (data.count <= 0) return interaction.reply({ content: `${target.tag} hat keine Strikes.`, flags: MessageFlags.Ephemeral });

  data.count -= 1;
  data.history.pop();
  await db.save();

  const embed = new EmbedBuilder()
    .setColor(C.GREEN)
    .setTitle('✅ Strike entfernt')
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${target} (${target.tag})`, inline: true },
      { name: 'Moderator', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
      { name: 'Verbleibende Strikes', value: `**${data.count}/${MAX_STRIKES}**`, inline: true },
    )
    .setFooter({ text: `User ID: ${target.id}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  await logger.log(interaction.client, interaction.guildId, embed);
}

// ──── /strikes check ────

async function handleStrikeCheck(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Nur Staff kann Strikes einsehen.', flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user', true);
  const g = db.guild(interaction.guildId);
  const data = getStrikes(g, target.id);

  const embed = new EmbedBuilder()
    .setColor(data.count >= MAX_STRIKES ? C.RED : data.count > 0 ? C.ORANGE : C.GREEN)
    .setTitle(`📋 Strikes: ${target.tag}`)
    .setThumbnail(target.displayAvatarURL())
    .addFields({ name: 'Strikes', value: `**${data.count}/${MAX_STRIKES}**`, inline: true });

  if (data.history.length) {
    const lines = data.history.map((e, i) =>
      `**${i + 1}.** ${truncate(e.reason || '_Kein Grund_', 80)} — <@${e.by_id}> — <t:${Math.floor(e.at / 1000)}:R>`,
    );
    embed.addFields({ name: 'Verlauf', value: truncate(lines.join('\n'), DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false });
  } else {
    embed.addFields({ name: 'Verlauf', value: '_Keine Strikes_', inline: false });
  }

  embed.setFooter({ text: `User ID: ${target.id}` }).setTimestamp();
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ──── /strikes list ────

async function handleStrikeList(interaction) {
  if (!checks.isStaff(interaction.member)) return interaction.reply({ content: 'Nur Staff kann die Strike-Liste einsehen.', flags: MessageFlags.Ephemeral });

  const g = db.guild(interaction.guildId);
  const entries = Object.entries(g.strikes || {})
    .filter(([, d]) => d.count > 0)
    .sort(([, a], [, b]) => b.count - a.count);

  if (!entries.length) return interaction.reply({ content: 'Keine Strikes vergeben.', flags: MessageFlags.Ephemeral });

  const lines = entries.map(([userId, d]) =>
    `<@${userId}> — **${d.count}/${MAX_STRIKES}** Strike${d.count !== 1 ? 's' : ''}`,
  );

  const embed = new EmbedBuilder()
    .setColor(C.ORANGE)
    .setTitle('📋 Alle Strikes')
    .setDescription(truncate(lines.join('\n'), DISCORD_LIMITS.EMBED_DESCRIPTION))
    .setFooter({ text: `${entries.length} User mit Strikes` })
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
      const opts = { content: 'Etwas ist schiefgelaufen.', flags: MessageFlags.Ephemeral };
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
