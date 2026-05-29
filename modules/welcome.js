'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

const db = require('../lib/db');
const checks = require('../lib/checks');
const { DISCORD_LIMITS, truncate } = require('../config');

const C = { BRAND: 0x5865F2, GREEN: 0x57F287 };

const WELCOME_MODAL_ID  = 'apex:welcome_modal';
const WELCOME_EDIT_BTN  = 'apex:welcome_edit';
const WELCOME_DEL_BTN   = 'apex:welcome_del';
const STICK_MODAL_ID    = 'apex:stick_modal';

const PLACEHOLDER_HINT = '`{user}` mention · `{username}` name · `{server}` server name · `{count}` member count';

function resolvePlaceholders(template, member) {
  return template
    .replace(/{user}/g,     `<@${member.user.id}>`)
    .replace(/{username}/g, member.user.username)
    .replace(/{server}/g,   member.guild.name)
    .replace(/{count}/g,    String(member.guild.memberCount));
}

// ──────────────────────────────────────────────────────────
//  WELCOME
// ──────────────────────────────────────────────────────────

const welcomeCommand = new SlashCommandBuilder()
  .setName('welcome')
  .setDescription('Manage welcome messages')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('set').setDescription('Set the welcome message (placeholders supported)'))
  .addSubcommand((s) =>
    s.setName('channel').setDescription('Set the welcome channel')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true)),
  )
  .addSubcommand((s) => s.setName('info').setDescription('Show current welcome settings'))
  .addSubcommand((s) => s.setName('test').setDescription('Test the welcome message with yourself'));

function buildWelcomeModal(existing) {
  const modal = new ModalBuilder().setCustomId(WELCOME_MODAL_ID).setTitle('Welcome Message');
  const input = new TextInputBuilder()
    .setCustomId('message')
    .setLabel(truncate('Message (placeholders supported)', DISCORD_LIMITS.TEXT_INPUT_LABEL))
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(2000)
    .setPlaceholder('Welcome {user} to {server}! You are member #{count}.');
  if (existing) input.setValue(truncate(existing, 2000));
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

async function handleWelcomeSet(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });
  const g = db.guild(interaction.guildId);
  return interaction.showModal(buildWelcomeModal(g.welcome?.message));
}

async function handleWelcomeChannel(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });
  const ch = interaction.options.getChannel('channel', true);
  if (!ch.isTextBased() || ch.isDMBased()) return interaction.reply({ content: 'Please select a text channel in this server.', flags: MessageFlags.Ephemeral });
  const g = db.guild(interaction.guildId);
  if (!g.welcome) g.welcome = { channel_id: null, message: null };
  g.welcome.channel_id = ch.id;
  await db.save();
  return interaction.reply({ content: `Welcome channel set to ${ch}.`, flags: MessageFlags.Ephemeral });
}

async function handleWelcomeInfo(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });
  const g = db.guild(interaction.guildId);
  const w = g.welcome;

  const embed = new EmbedBuilder()
    .setColor(C.BRAND)
    .setTitle('👋 Welcome Messages')
    .addFields(
      { name: 'Channel',      value: w?.channel_id ? `<#${w.channel_id}>` : '_Not set_', inline: true },
      { name: 'Message',      value: w?.message ? `\`\`\`${truncate(w.message, 600)}\`\`\`` : '_Not set_', inline: false },
      { name: 'Placeholders', value: PLACEHOLDER_HINT, inline: false },
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(WELCOME_EDIT_BTN).setLabel('✏️ Edit').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(WELCOME_DEL_BTN).setLabel('🗑️ Delete').setStyle(ButtonStyle.Danger),
  );

  return interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

async function handleWelcomeTest(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });
  const g = db.guild(interaction.guildId);
  if (!g.welcome?.message) return interaction.reply({ content: 'No welcome message set. Use `/welcome set`.', flags: MessageFlags.Ephemeral });
  const text = resolvePlaceholders(g.welcome.message, interaction.member);
  return interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
}

async function onWelcomeModal(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });
  const message = interaction.fields.getTextInputValue('message').trim();
  const g = db.guild(interaction.guildId);
  if (!g.welcome) g.welcome = { channel_id: null, message: null };
  g.welcome.message = message;
  await db.save();
  return interaction.reply({ content: `✅ Welcome message saved.\n${PLACEHOLDER_HINT}`, flags: MessageFlags.Ephemeral });
}

async function onWelcomeEditBtn(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });
  const g = db.guild(interaction.guildId);
  return interaction.showModal(buildWelcomeModal(g.welcome?.message));
}

async function onWelcomeDelBtn(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });
  const g = db.guild(interaction.guildId);
  g.welcome = { channel_id: null, message: null };
  await db.save();
  return interaction.update({ content: '🗑️ Welcome settings deleted.', embeds: [], components: [] });
}

async function onMemberJoin(client, member) {
  const g = db.guild(member.guild.id);
  if (!g.welcome?.channel_id || !g.welcome?.message) return;
  try {
    const ch = await client.channels.fetch(g.welcome.channel_id).catch(() => null);
    if (!ch?.isTextBased()) return;
    const text = resolvePlaceholders(g.welcome.message, member);
    await ch.send({ content: text, allowedMentions: { users: [member.user.id] } });
  } catch (e) {
    console.error('[welcome] send failed:', e?.message);
  }
}

// ──────────────────────────────────────────────────────────
//  STICKY
// ──────────────────────────────────────────────────────────

const stickCommand = new SlashCommandBuilder()
  .setName('stick')
  .setDescription('Manage sticky messages')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('set').setDescription('Set a sticky message for this channel'))
  .addSubcommand((s) => s.setName('remove').setDescription('Remove the sticky message from this channel'))
  .addSubcommand((s) => s.setName('info').setDescription('Show all sticky messages'));

async function handleStickSet(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });
  const g = db.guild(interaction.guildId);
  const existing = g.sticky?.[interaction.channel.id]?.content;

  const modal = new ModalBuilder().setCustomId(STICK_MODAL_ID).setTitle('Sticky Message');
  const input = new TextInputBuilder()
    .setCustomId('content')
    .setLabel('Message')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(2000);
  if (existing) input.setValue(existing);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return interaction.showModal(modal);
}

async function handleStickRemove(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });
  const g = db.guild(interaction.guildId);
  const entry = g.sticky?.[interaction.channel.id];
  if (!entry) return interaction.reply({ content: 'No sticky message in this channel.', flags: MessageFlags.Ephemeral });

  if (entry.message_id) {
    const old = await interaction.channel.messages.fetch(entry.message_id).catch(() => null);
    if (old) await old.delete().catch(() => {});
  }

  delete g.sticky[interaction.channel.id];
  await db.save();
  return interaction.reply({ content: '🗑️ Sticky removed.', flags: MessageFlags.Ephemeral });
}

async function handleStickInfo(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });
  const g = db.guild(interaction.guildId);
  const entries = Object.entries(g.sticky || {});

  if (!entries.length) return interaction.reply({ content: 'No sticky messages configured.', flags: MessageFlags.Ephemeral });

  const embed = new EmbedBuilder()
    .setColor(C.BRAND)
    .setTitle('📌 Sticky Messages')
    .setTimestamp();

  for (const [channelId, data] of entries.slice(0, 20)) {
    embed.addFields({
      name: `<#${channelId}>`,
      value: `\`\`\`${truncate(data.content, 200)}\`\`\``,
      inline: false,
    });
  }

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function onStickModal(interaction) {
  if (!checks.isAdmin(interaction.member)) return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const content = interaction.fields.getTextInputValue('content').trim();
  const g = db.guild(interaction.guildId);
  if (!g.sticky) g.sticky = {};
  const channelId = interaction.channel.id;
  const old = g.sticky[channelId];

  if (old?.message_id) {
    const oldMsg = await interaction.channel.messages.fetch(old.message_id).catch(() => null);
    if (oldMsg) await oldMsg.delete().catch(() => {});
  }

  let newId = null;
  try {
    const sent = await interaction.channel.send({ content: `📌 ${content}` });
    newId = sent.id;
  } catch (e) {
    await interaction.editReply({ content: `Failed to send: ${e?.message}` });
    return;
  }

  g.sticky[channelId] = { content, message_id: newId };
  await db.save();
  await interaction.editReply({ content: '📌 Sticky set.' });
}

// Per-channel lock to prevent concurrent re-posts
const stickyLock = new Set();

async function onMessageCreate(client, message) {
  if (!message.guild) return;
  if (message.author?.bot) return;

  const g = db.guild(message.guild.id);
  const entry = g.sticky?.[message.channel.id];
  if (!entry?.content) return;

  const channelId = message.channel.id;
  if (stickyLock.has(channelId)) return;
  stickyLock.add(channelId);

  try {
    if (entry.message_id) {
      const old = await message.channel.messages.fetch(entry.message_id).catch(() => null);
      if (old) await old.delete().catch(() => {});
    }

    const sent = await message.channel.send({ content: `📌 ${entry.content}` });
    entry.message_id = sent.id;
    await db.save();
  } catch (e) {
    console.error('[sticky] re-post failed:', e?.message);
  } finally {
    stickyLock.delete(channelId);
  }
}

// ──── Register ────

function register(client) {
  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.inGuild()) return;

      if (interaction.isChatInputCommand()) {
        const cmd = interaction.commandName;
        const sub = interaction.options.getSubcommand(false);
        if (cmd === 'welcome') {
          if (sub === 'set')     return await handleWelcomeSet(interaction);
          if (sub === 'channel') return await handleWelcomeChannel(interaction);
          if (sub === 'info')    return await handleWelcomeInfo(interaction);
          if (sub === 'test')    return await handleWelcomeTest(interaction);
        }
        if (cmd === 'stick') {
          if (sub === 'set')    return await handleStickSet(interaction);
          if (sub === 'remove') return await handleStickRemove(interaction);
          if (sub === 'info')   return await handleStickInfo(interaction);
        }
      }

      if (interaction.isModalSubmit()) {
        if (interaction.customId === WELCOME_MODAL_ID) return await onWelcomeModal(interaction);
        if (interaction.customId === STICK_MODAL_ID)   return await onStickModal(interaction);
      }

      if (interaction.isButton()) {
        if (interaction.customId === WELCOME_EDIT_BTN) return await onWelcomeEditBtn(interaction);
        if (interaction.customId === WELCOME_DEL_BTN)  return await onWelcomeDelBtn(interaction);
      }
    } catch (err) {
      console.error('[welcome] error:', err);
      const opts = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(opts);
        else if (interaction.isRepliable?.()) await interaction.reply(opts);
      } catch { /* swallow */ }
    }
  });

  client.on('guildMemberAdd', (m)    => onMemberJoin(client, m).catch((e)       => console.error('[welcome:join]', e?.message)));
  client.on('messageCreate',  (msg)  => onMessageCreate(client, msg).catch((e)  => console.error('[sticky:msg]',   e?.message)));
}

module.exports = {
  commands: [welcomeCommand, stickCommand],
  register,
};
