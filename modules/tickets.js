'use strict';

const {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} = require('discord.js');

const fs   = require('fs');
const path = require('path');

const db   = require('../lib/db');
const tdb  = require('../lib/transcript-db');
const checks = require('../lib/checks');
const { DISCORD_LIMITS, IDS, TRANSCRIPT_BASE_URL, truncate } = require('../config');

// ───── Constants & helpers ─────

const PANEL_ID_RE = /^[a-z0-9_-]{1,32}$/;
const SNOWFLAKE_RE = /^\d{15,21}$/;
const EMBED_COLOR_BRAND = 0x5865F2;
const EMBED_COLOR_WARN  = 0xFAA61A;
const EMBED_COLOR_OK    = 0x57F287;

const COLOR_STYLE = {
  blue: ButtonStyle.Primary,
  green: ButtonStyle.Success,
  red: ButtonStyle.Danger,
  gray: ButtonStyle.Secondary,
  grey: ButtonStyle.Secondary,
};
const COLOR_NORMAL = { blue: 'Blue', green: 'Green', red: 'Red', gray: 'Gray', grey: 'Gray' };

function normalizeColor(raw) {
  if (!raw) return null;
  return COLOR_NORMAL[String(raw).trim().toLowerCase()] || null;
}
function colorToStyle(name) {
  return COLOR_STYLE[String(name || '').toLowerCase()] || ButtonStyle.Primary;
}

function slugChannelName(panelId, counter) {
  const base = String(panelId).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const safeBase = base || 'ticket';
  const n = String(counter).padStart(4, '0');
  return truncate(`${safeBase}-${n}`, DISCORD_LIMITS.CHANNEL_NAME);
}

async function safeReply(interaction, opts) {
  try {
    // Order matters: `replied` is set after editReply too, so check it first.
    if (interaction.replied) {
      return await interaction.followUp(opts);
    }
    if (interaction.deferred) {
      // editReply doesn't accept `flags` — they were locked in at defer time.
      const { flags: _drop, ...rest } = opts;
      return await interaction.editReply(rest);
    }
    return await interaction.reply(opts);
  } catch (e) {
    console.error('[tickets] reply failed:', e?.message);
  }
}

function ephemeral(interaction, content) {
  return safeReply(interaction, { content: truncate(content, DISCORD_LIMITS.MESSAGE_CONTENT), flags: MessageFlags.Ephemeral });
}

// ───── Slash command ─────

const ticketCommand = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Apex Core ticket system')
  .setDefaultMemberPermissions(0n)
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('description').setDescription('Set the ticket panel description (title, subtitle, body, footer)'))
  .addSubcommand((s) => s.setName('setup').setDescription('Create or update a ticket panel'))
  .addSubcommand((s) => s.setName('group').setDescription('Send one or more panels together in one message'))
  .addSubcommand((s) =>
    s.setName('rename').setDescription('Rename this ticket channel')
      .addStringOption((o) => o.setName('name').setDescription('New channel name').setRequired(true).setMaxLength(90)),
  )
  .addSubcommand((s) =>
    s.setName('add').setDescription('Add a user to this ticket')
      .addUserOption((o) => o.setName('user').setDescription('User to add').setRequired(true)),
  )
  .addSubcommand((s) =>
    s.setName('remove').setDescription('Remove a user from this ticket')
      .addUserOption((o) => o.setName('user').setDescription('User to remove').setRequired(true)),
  )
  .addSubcommand((s) =>
    s.setName('move').setDescription('Move this ticket to another category')
      .addStringOption((o) => o.setName('category').setDescription('Category ID').setRequired(true).setMaxLength(21)),
  )
  .addSubcommand((s) =>
    s.setName('view').setDescription('Toggle a role allowed to view tickets')
      .addRoleOption((o) => o.setName('role').setDescription('Role to toggle').setRequired(true)),
  )
  .addSubcommand((s) =>
    s.setName('ping').setDescription('Toggle a role pinged on ticket open')
      .addRoleOption((o) => o.setName('role').setDescription('Role to toggle').setRequired(true)),
  )
  .addSubcommand((s) => s.setName('panels').setDescription('List configured panels'))
  .addSubcommand((s) => s.setName('info').setDescription('Show all ticket setups, description config, and roles'))
  .addSubcommand((s) =>
    s.setName('edit').setDescription('Edit an existing ticket panel')
      .addStringOption((o) => o.setName('panel_id').setDescription('Panel ID to edit').setRequired(true).setMaxLength(32)),
  )
  .addSubcommand((s) =>
    s.setName('delete').setDescription('Delete a configured panel')
      .addStringOption((o) => o.setName('panel_id').setDescription('Panel ID to delete').setRequired(true).setMaxLength(32)),
  )
  .addSubcommand((s) =>
    s.setName('log').setDescription('Set (or clear) the channel where ticket transcripts are sent')
      .addChannelOption((o) => o.setName('channel').setDescription('Transcript log channel — omit to clear').setRequired(false)),
  );

// ───── Modal builders ─────

function buildDescriptionModal(existing) {
  const modal = new ModalBuilder()
    .setCustomId(IDS.DESCRIPTION_MODAL)
    .setTitle(truncate('Set Ticket Panel Description', DISCORD_LIMITS.MODAL_TITLE));

  const title = new TextInputBuilder()
    .setCustomId('title').setLabel(truncate('Title (e.g. Create Ticket)', DISCORD_LIMITS.TEXT_INPUT_LABEL))
    .setStyle(TextInputStyle.Short).setMaxLength(DISCORD_LIMITS.EMBED_TITLE).setRequired(false);
  if (existing?.title) title.setValue(truncate(existing.title, DISCORD_LIMITS.EMBED_TITLE));

  const subtitle = new TextInputBuilder()
    .setCustomId('subtitle').setLabel(truncate('Subtitle — shown bold (e.g. Ticket Rules)', DISCORD_LIMITS.TEXT_INPUT_LABEL))
    .setStyle(TextInputStyle.Short).setMaxLength(DISCORD_LIMITS.EMBED_TITLE).setRequired(false);
  if (existing?.subtitle) subtitle.setValue(truncate(existing.subtitle, DISCORD_LIMITS.EMBED_TITLE));

  const description = new TextInputBuilder()
    .setCustomId('description').setLabel(truncate('Description — multi-line & bullets', DISCORD_LIMITS.TEXT_INPUT_LABEL))
    .setStyle(TextInputStyle.Paragraph).setMaxLength(3500).setRequired(false);
  if (existing?.description) description.setValue(truncate(existing.description, 3500));

  const footer = new TextInputBuilder()
    .setCustomId('footer').setLabel(truncate('Footer text (optional)', DISCORD_LIMITS.TEXT_INPUT_LABEL))
    .setStyle(TextInputStyle.Short).setMaxLength(DISCORD_LIMITS.EMBED_FOOTER).setRequired(false);
  if (existing?.footer) footer.setValue(truncate(existing.footer, DISCORD_LIMITS.EMBED_FOOTER));

  modal.addComponents(
    new ActionRowBuilder().addComponents(title),
    new ActionRowBuilder().addComponents(subtitle),
    new ActionRowBuilder().addComponents(description),
    new ActionRowBuilder().addComponents(footer),
  );
  return modal;
}

function buildSetupModal() {
  const modal = new ModalBuilder()
    .setCustomId(IDS.SETUP_MODAL)
    .setTitle(truncate('Create Ticket Panel', DISCORD_LIMITS.MODAL_TITLE));

  const panelId = new TextInputBuilder()
    .setCustomId('panel_id').setLabel(truncate('Panel ID (e.g. support)', DISCORD_LIMITS.TEXT_INPUT_LABEL))
    .setStyle(TextInputStyle.Short).setMaxLength(32).setMinLength(1).setRequired(true)
    .setPlaceholder(truncate('lowercase, letters/numbers/_/- only', DISCORD_LIMITS.TEXT_INPUT_PLACEHOLDER));

  const buttonText = new TextInputBuilder()
    .setCustomId('button_text').setLabel(truncate('Button Text (e.g. Support)', DISCORD_LIMITS.TEXT_INPUT_LABEL))
    .setStyle(TextInputStyle.Short).setMaxLength(DISCORD_LIMITS.BUTTON_LABEL).setMinLength(1).setRequired(true);

  const buttonColor = new TextInputBuilder()
    .setCustomId('button_color').setLabel(truncate('Button Color: Blue/Green/Red/Gray', DISCORD_LIMITS.TEXT_INPUT_LABEL))
    .setStyle(TextInputStyle.Short).setMaxLength(10).setRequired(true).setPlaceholder('Blue');

  const categoryId = new TextInputBuilder()
    .setCustomId('category_id').setLabel(truncate('Discord Category ID (optional)', DISCORD_LIMITS.TEXT_INPUT_LABEL))
    .setStyle(TextInputStyle.Short).setMaxLength(21).setRequired(false)
    .setPlaceholder(truncate('Right-click category → Copy ID', DISCORD_LIMITS.TEXT_INPUT_PLACEHOLDER));

  const questions = new TextInputBuilder()
    .setCustomId('questions').setLabel(truncate('Questions before ticket (optional)', DISCORD_LIMITS.TEXT_INPUT_LABEL))
    .setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(false)
    .setPlaceholder(truncate('What is your IGN?\nWhat is your issue?', DISCORD_LIMITS.TEXT_INPUT_PLACEHOLDER));

  modal.addComponents(
    new ActionRowBuilder().addComponents(panelId),
    new ActionRowBuilder().addComponents(buttonText),
    new ActionRowBuilder().addComponents(buttonColor),
    new ActionRowBuilder().addComponents(categoryId),
    new ActionRowBuilder().addComponents(questions),
  );
  return modal;
}

function buildEditModal(panel) {
  const modal = new ModalBuilder()
    .setCustomId(IDS.SETUP_MODAL)
    .setTitle(truncate(`Edit: ${panel.panel_id}`, DISCORD_LIMITS.MODAL_TITLE));

  const panelId = new TextInputBuilder()
    .setCustomId('panel_id').setLabel(truncate('Panel ID (e.g. support)', DISCORD_LIMITS.TEXT_INPUT_LABEL))
    .setStyle(TextInputStyle.Short).setMaxLength(32).setMinLength(1).setRequired(true)
    .setValue(panel.panel_id);

  const buttonText = new TextInputBuilder()
    .setCustomId('button_text').setLabel(truncate('Button Text (e.g. Support)', DISCORD_LIMITS.TEXT_INPUT_LABEL))
    .setStyle(TextInputStyle.Short).setMaxLength(DISCORD_LIMITS.BUTTON_LABEL).setMinLength(1).setRequired(true)
    .setValue(truncate(panel.button_text, DISCORD_LIMITS.BUTTON_LABEL));

  const buttonColor = new TextInputBuilder()
    .setCustomId('button_color').setLabel(truncate('Button Color: Blue/Green/Red/Gray', DISCORD_LIMITS.TEXT_INPUT_LABEL))
    .setStyle(TextInputStyle.Short).setMaxLength(10).setRequired(true)
    .setValue(panel.button_color || 'Blue');

  const categoryId = new TextInputBuilder()
    .setCustomId('category_id').setLabel(truncate('Discord Category ID (optional)', DISCORD_LIMITS.TEXT_INPUT_LABEL))
    .setStyle(TextInputStyle.Short).setMaxLength(21).setRequired(false)
    .setPlaceholder(truncate('Right-click category → Copy ID', DISCORD_LIMITS.TEXT_INPUT_PLACEHOLDER));
  if (panel.category_id) categoryId.setValue(panel.category_id);

  const questions = new TextInputBuilder()
    .setCustomId('questions').setLabel(truncate('Questions before ticket (optional)', DISCORD_LIMITS.TEXT_INPUT_LABEL))
    .setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(false)
    .setPlaceholder(truncate('What is your IGN?\nWhat is your issue?', DISCORD_LIMITS.TEXT_INPUT_PLACEHOLDER));
  if (panel.questions?.length) questions.setValue(truncate(panel.questions.join('\n'), 1000));

  modal.addComponents(
    new ActionRowBuilder().addComponents(panelId),
    new ActionRowBuilder().addComponents(buttonText),
    new ActionRowBuilder().addComponents(buttonColor),
    new ActionRowBuilder().addComponents(categoryId),
    new ActionRowBuilder().addComponents(questions),
  );
  return modal;
}

function buildCloseReasonModal(channelId) {
  return new ModalBuilder()
    .setCustomId(`${IDS.CLOSE_REASON_MODAL}:${channelId}`)
    .setTitle(truncate('Close Ticket', DISCORD_LIMITS.MODAL_TITLE))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel(truncate('Reason (optional)', DISCORD_LIMITS.TEXT_INPUT_LABEL))
          .setStyle(TextInputStyle.Short)
          .setMaxLength(200)
          .setRequired(false)
          .setPlaceholder(truncate('e.g. Issue resolved, no response…', DISCORD_LIMITS.TEXT_INPUT_PLACEHOLDER)),
      ),
    );
}

// ───── Embeds & buttons ─────

function buildPanelEmbed(descCfg) {
  const cfg = descCfg || {};
  const e = new EmbedBuilder().setColor(EMBED_COLOR_BRAND);

  e.setTitle(truncate(cfg.title || 'Create Ticket', DISCORD_LIMITS.EMBED_TITLE));

  const parts = [];
  if (cfg.subtitle) parts.push(`**${truncate(cfg.subtitle, DISCORD_LIMITS.EMBED_TITLE)}**`);
  if (cfg.description) {
    if (parts.length) parts.push('');
    parts.push(cfg.description);
  }
  if (parts.length) {
    e.setDescription(truncate(parts.join('\n'), DISCORD_LIMITS.EMBED_DESCRIPTION));
  }

  e.setFooter({ text: truncate(cfg.footer || 'Powered by Apex Core', DISCORD_LIMITS.EMBED_FOOTER) });
  return e;
}

function buildPanelButtonRows(panels) {
  const rows = [];
  for (let i = 0; i < panels.length; i += 5) {
    const slice = panels.slice(i, i + 5);
    const row = new ActionRowBuilder();
    for (const p of slice) {
      const customId = `${IDS.PANEL_BUTTON}:${p.panel_id}`;
      if (customId.length > DISCORD_LIMITS.CUSTOM_ID) continue; // safety; PANEL_ID_RE keeps us well below
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(customId)
          .setLabel(truncate(p.button_text || p.panel_id, DISCORD_LIMITS.BUTTON_LABEL))
          .setStyle(colorToStyle(p.button_color)),
      );
    }
    if (row.components.length > 0) rows.push(row);
  }
  return rows;
}

function buildTicketTopButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.TICKET_REQUEST_CLOSE).setLabel(truncate('Request Close', DISCORD_LIMITS.BUTTON_LABEL)).setStyle(ButtonStyle.Secondary).setEmoji('📩'),
    new ButtonBuilder().setCustomId(IDS.TICKET_CLOSE).setLabel(truncate('Close Ticket', DISCORD_LIMITS.BUTTON_LABEL)).setStyle(ButtonStyle.Danger).setEmoji('🔒'),
  );
}

// ───── Slash subcommand handlers ─────

async function handleDescription(interaction) {
  if (!checks.isStaff(interaction.member)) return ephemeral(interaction, 'Staff only.');
  const g = db.guild(interaction.guildId);
  return interaction.showModal(buildDescriptionModal(g.description));
}

async function handleSetup(interaction) {
  if (!checks.isAdmin(interaction.member)) return ephemeral(interaction, 'Admin only.');
  return interaction.showModal(buildSetupModal());
}

async function handleGroup(interaction) {
  if (!checks.isStaff(interaction.member)) return ephemeral(interaction, 'Staff only.');
  const g = db.guild(interaction.guildId);
  const panels = Object.values(g.panels);
  if (!panels.length) return ephemeral(interaction, 'No panels configured yet. Use `/ticket setup` first.');

  const trimmed = panels.slice(0, DISCORD_LIMITS.SELECT_OPTIONS_MAX);
  const options = trimmed.map((p) => ({
    label: truncate(p.button_text || p.panel_id, DISCORD_LIMITS.SELECT_LABEL),
    value: truncate(p.panel_id, DISCORD_LIMITS.SELECT_VALUE),
    description: truncate(`Panel: ${p.panel_id}`, DISCORD_LIMITS.SELECT_DESCRIPTION),
  }));

  const select = new StringSelectMenuBuilder()
    .setCustomId(IDS.GROUP_SELECT)
    .setPlaceholder(truncate('Pick panels to send in one message', DISCORD_LIMITS.SELECT_DESCRIPTION))
    .setMinValues(1)
    .setMaxValues(Math.min(options.length, DISCORD_LIMITS.SELECT_OPTIONS_MAX))
    .addOptions(options);

  return interaction.reply({
    content: 'Pick which panels you want to send here:',
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleRename(interaction) {
  const ticket = checks.getTicket(interaction.guildId, interaction.channel.id);
  if (!ticket) return ephemeral(interaction, 'This is not a ticket channel.');
  if (!checks.isStaff(interaction.member)) return ephemeral(interaction, 'Staff only.');

  const raw = interaction.options.getString('name', true);
  const sanitized = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!sanitized) return ephemeral(interaction, 'Invalid name — needs letters/numbers/dashes.');
  const next = truncate(sanitized, DISCORD_LIMITS.CHANNEL_NAME);
  try {
    await interaction.channel.setName(next, `Renamed by ${interaction.user.tag}`);
    return ephemeral(interaction, `Renamed to \`${next}\`.`);
  } catch (e) {
    return ephemeral(interaction, `Failed to rename: ${e?.message || 'unknown'}`);
  }
}

async function handleAdd(interaction) {
  const ticket = checks.getTicket(interaction.guildId, interaction.channel.id);
  if (!ticket) return ephemeral(interaction, 'This is not a ticket channel.');
  if (!checks.isStaff(interaction.member)) return ephemeral(interaction, 'Staff only.');

  const user = interaction.options.getUser('user', true);
  try {
    await interaction.channel.permissionOverwrites.edit(user.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      EmbedLinks: true,
      AttachFiles: true,
    }, { reason: `Added to ticket by ${interaction.user.tag}` });
    return interaction.reply({ content: `Added <@${user.id}> to this ticket.`, allowedMentions: { users: [user.id] } });
  } catch (e) {
    return ephemeral(interaction, `Failed to add: ${e?.message || 'unknown'}`);
  }
}

async function handleRemove(interaction) {
  const ticket = checks.getTicket(interaction.guildId, interaction.channel.id);
  if (!ticket) return ephemeral(interaction, 'This is not a ticket channel.');
  if (!checks.isStaff(interaction.member)) return ephemeral(interaction, 'Staff only.');

  const user = interaction.options.getUser('user', true);
  if (String(user.id) === String(ticket.user_id)) {
    return ephemeral(interaction, 'Cannot remove the ticket owner.');
  }
  try {
    await interaction.channel.permissionOverwrites.delete(user.id, `Removed from ticket by ${interaction.user.tag}`);
    return interaction.reply({ content: `Removed <@${user.id}> from this ticket.`, allowedMentions: { parse: [] } });
  } catch (e) {
    return ephemeral(interaction, `Failed to remove: ${e?.message || 'unknown'}`);
  }
}

async function handleMove(interaction) {
  const ticket = checks.getTicket(interaction.guildId, interaction.channel.id);
  if (!ticket) return ephemeral(interaction, 'This is not a ticket channel.');
  if (!checks.isStaff(interaction.member)) return ephemeral(interaction, 'Staff only.');

  const raw = interaction.options.getString('category', true).trim();
  if (!SNOWFLAKE_RE.test(raw)) return ephemeral(interaction, 'Invalid Category ID — must be a Discord snowflake.');
  const category = interaction.guild.channels.cache.get(raw);
  if (!category || category.type !== ChannelType.GuildCategory) {
    return ephemeral(interaction, 'Category ID does not match a category in this server.');
  }
  try {
    await interaction.channel.setParent(category.id, { lockPermissions: false, reason: `Moved by ${interaction.user.tag}` });
    return ephemeral(interaction, `Moved to category \`${category.name}\`.`);
  } catch (e) {
    return ephemeral(interaction, `Failed to move: ${e?.message || 'unknown'}`);
  }
}

async function handleView(interaction) {
  if (!checks.isStaff(interaction.member)) return ephemeral(interaction, 'Staff only.');
  const role = interaction.options.getRole('role', true);
  const g = db.guild(interaction.guildId);
  if (!g.view_role_ids) g.view_role_ids = [];
  const idx = g.view_role_ids.indexOf(role.id);
  if (idx >= 0) {
    g.view_role_ids.splice(idx, 1);
    await db.save();
    return ephemeral(interaction, `${role} removed from ticket viewers.`);
  }
  g.view_role_ids.push(role.id);
  await db.save();
  return ephemeral(interaction, `${role} added to ticket viewers.`);
}

async function handlePing(interaction) {
  if (!checks.isStaff(interaction.member)) return ephemeral(interaction, 'Staff only.');
  const role = interaction.options.getRole('role', true);
  const g = db.guild(interaction.guildId);
  if (!g.ping_role_ids) g.ping_role_ids = [];
  const idx = g.ping_role_ids.indexOf(role.id);
  if (idx >= 0) {
    g.ping_role_ids.splice(idx, 1);
    await db.save();
    return ephemeral(interaction, `${role} will no longer be pinged on ticket open.`);
  }
  g.ping_role_ids.push(role.id);
  await db.save();
  return ephemeral(interaction, `${role} will now be pinged on ticket open.`);
}

async function handlePanels(interaction) {
  if (!checks.isStaff(interaction.member)) return ephemeral(interaction, 'Staff only.');
  const g = db.guild(interaction.guildId);
  const list = Object.values(g.panels);
  if (!list.length) return ephemeral(interaction, 'No panels configured.');
  const lines = list.map(
    (p) => `• \`${p.panel_id}\` — ${p.button_text} [${p.button_color}] · cat:${p.category_id || 'none'} · questions:${(p.questions || []).length}`,
  );
  return ephemeral(interaction, truncate(lines.join('\n'), 1900));
}

async function handleInfo(interaction) {
  if (!checks.isStaff(interaction.member)) return ephemeral(interaction, 'Staff only.');
  const g = db.guild(interaction.guildId);

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR_BRAND)
    .setTitle(truncate('Ticket System — Overview', DISCORD_LIMITS.EMBED_TITLE))
    .setTimestamp();

  // Description config
  const desc = g.description;
  if (desc && (desc.title || desc.subtitle || desc.description || desc.footer)) {
    const parts = [];
    if (desc.title) parts.push(`**Title:** ${truncate(desc.title, 100)}`);
    if (desc.subtitle) parts.push(`**Subtitle:** ${truncate(desc.subtitle, 100)}`);
    if (desc.description) parts.push(`**Body:** ${truncate(desc.description, 200)}`);
    if (desc.footer) parts.push(`**Footer:** ${truncate(desc.footer, 100)}`);
    embed.addFields({ name: '📝 Panel Description', value: truncate(parts.join('\n'), DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false });
  } else {
    embed.addFields({ name: '📝 Panel Description', value: '_Not set — use `/ticket description`_', inline: false });
  }

  // Global roles
  const staffRole = g.staff_role_id ? `<@&${g.staff_role_id}>` : '_None_';
  const viewRoles = (g.view_role_ids || []).length
    ? truncate((g.view_role_ids).map((id) => `<@&${id}>`).join(', '), DISCORD_LIMITS.EMBED_FIELD_VALUE)
    : '_None_';
  const pingRoles = (g.ping_role_ids || []).length
    ? truncate((g.ping_role_ids).map((id) => `<@&${id}>`).join(', '), DISCORD_LIMITS.EMBED_FIELD_VALUE)
    : '_None_';

  embed.addFields(
    { name: '🛡️ Staff Role', value: staffRole, inline: true },
    { name: '👁️ View Roles', value: viewRoles, inline: true },
    { name: '🔔 Ping Roles', value: pingRoles, inline: true },
  );

  // Panels
  const panels = Object.values(g.panels);
  if (!panels.length) {
    embed.addFields({ name: '📋 Panels', value: '_No panels configured. Use `/ticket setup` to create one._', inline: false });
  } else {
    // Separator field
    embed.addFields({ name: `📋 Panels (${panels.length})`, value: '​', inline: false });
    const shown = panels.slice(0, 21); // keep well under the 25-field limit
    for (const p of shown) {
      const qs = p.questions || [];
      const qLine = qs.length ? qs.map((q) => `• ${truncate(q, 60)}`).join('\n') : '_None_';
      const lines = [
        `**Button:** ${truncate(p.button_text, 60)} \`[${p.button_color}]\``,
        `**Category:** ${p.category_id ? `\`${p.category_id}\`` : '_None_'}`,
        `**Tickets opened:** ${g.counters[p.panel_id] || 0}`,
        `**Questions (${qs.length}):**\n${truncate(qLine, 400)}`,
      ];
      embed.addFields({ name: truncate(`\`${p.panel_id}\``, DISCORD_LIMITS.EMBED_FIELD_NAME), value: truncate(lines.join('\n'), DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: true });
    }
    if (panels.length > 21) {
      embed.addFields({ name: `…and ${panels.length - 21} more`, value: 'Use `/ticket panels` for the full list.', inline: false });
    }
  }

  embed.setFooter({ text: truncate('Use /ticket edit <panel_id> to modify a panel • /ticket setup to add a new one', DISCORD_LIMITS.EMBED_FOOTER) });

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleEdit(interaction) {
  if (!checks.isStaff(interaction.member)) return ephemeral(interaction, 'Staff only.');
  const id = interaction.options.getString('panel_id', true).trim().toLowerCase();
  const g = db.guild(interaction.guildId);
  if (!g.panels[id]) return ephemeral(interaction, `No panel \`${id}\` found. Use \`/ticket setup\` to create it first.`);
  return interaction.showModal(buildEditModal(g.panels[id]));
}

async function handleDelete(interaction) {
  if (!checks.isStaff(interaction.member)) return ephemeral(interaction, 'Staff only.');
  const id = interaction.options.getString('panel_id', true).trim().toLowerCase();
  const g = db.guild(interaction.guildId);
  if (!g.panels[id]) return ephemeral(interaction, `No panel \`${id}\` exists.`);
  delete g.panels[id];
  delete g.counters[id];
  await db.save();
  return ephemeral(interaction, `Panel \`${id}\` deleted.`);
}

// ───── Modal submit handlers ─────

async function onDescriptionModal(interaction) {
  if (!checks.isStaff(interaction.member)) return ephemeral(interaction, 'Staff only.');
  const title = interaction.fields.getTextInputValue('title').trim();
  const subtitle = interaction.fields.getTextInputValue('subtitle').trim();
  const description = interaction.fields.getTextInputValue('description').trim();
  const footer = interaction.fields.getTextInputValue('footer').trim();

  const g = db.guild(interaction.guildId);
  g.description = {
    title: title ? truncate(title, DISCORD_LIMITS.EMBED_TITLE) : null,
    subtitle: subtitle ? truncate(subtitle, DISCORD_LIMITS.EMBED_TITLE) : null,
    description: description ? truncate(description, 3500) : null,
    footer: footer ? truncate(footer, DISCORD_LIMITS.EMBED_FOOTER) : null,
  };
  await db.save();

  const preview = buildPanelEmbed(g.description);
  return interaction.reply({
    content: 'Ticket panel description saved. Preview:',
    embeds: [preview],
    flags: MessageFlags.Ephemeral,
  });
}

async function onSetupModal(interaction) {
  if (!checks.isStaff(interaction.member)) return ephemeral(interaction, 'Staff only.');
  const panelIdRaw = interaction.fields.getTextInputValue('panel_id').trim().toLowerCase();
  const buttonText = interaction.fields.getTextInputValue('button_text').trim();
  const buttonColorRaw = interaction.fields.getTextInputValue('button_color').trim();
  const categoryIdRaw = interaction.fields.getTextInputValue('category_id').trim();
  const questionsRaw = interaction.fields.getTextInputValue('questions').trim();

  if (!PANEL_ID_RE.test(panelIdRaw)) {
    return ephemeral(interaction, 'Invalid Panel ID. Use lowercase letters, numbers, `_` or `-` (max 32 chars).');
  }
  if (!buttonText) return ephemeral(interaction, 'Button text is required.');
  if (buttonText.length > DISCORD_LIMITS.BUTTON_LABEL) {
    return ephemeral(interaction, `Button text is too long (max ${DISCORD_LIMITS.BUTTON_LABEL} chars).`);
  }
  const color = normalizeColor(buttonColorRaw);
  if (!color) return ephemeral(interaction, 'Invalid color. Use one of: Blue, Green, Red, Gray.');

  let categoryId = null;
  if (categoryIdRaw) {
    if (!SNOWFLAKE_RE.test(categoryIdRaw)) {
      return ephemeral(interaction, 'Invalid Category ID — must be a Discord snowflake (numeric).');
    }
    const category = interaction.guild.channels.cache.get(categoryIdRaw);
    if (!category || category.type !== ChannelType.GuildCategory) {
      return ephemeral(interaction, 'Category ID does not match a category in this server.');
    }
    categoryId = categoryIdRaw;
  }

  const questions = questionsRaw
    .split(/\r?\n/)
    .map((q) => q.trim())
    .filter(Boolean)
    .slice(0, DISCORD_LIMITS.MODAL_INPUTS_MAX);

  const g = db.guild(interaction.guildId);
  const existed = !!g.panels[panelIdRaw];
  g.panels[panelIdRaw] = {
    panel_id: panelIdRaw,
    button_text: buttonText,
    button_color: color,
    category_id: categoryId,
    questions,
  };
  if (!g.counters[panelIdRaw]) g.counters[panelIdRaw] = 0;
  await db.save();

  return ephemeral(
    interaction,
    `Panel \`${panelIdRaw}\` ${existed ? 'updated' : 'created'}. Use \`/ticket group\` to send it in a channel.`,
  );
}

async function onPanelModal(interaction) {
  const prefix = `${IDS.PANEL_MODAL}:`;
  if (!interaction.customId.startsWith(prefix)) return;
  const panelId = interaction.customId.slice(prefix.length);

  const g = db.guild(interaction.guildId);
  const uid = interaction.user.id;
  if (g.global_blacklist?.includes(uid) || g.ticket_blacklist?.includes(uid) || (g.application_blacklist || []).includes(uid)) {
    return ephemeral(interaction, 'You are blacklisted from opening tickets.');
  }
  const panel = g.panels[panelId];
  if (!panel) return ephemeral(interaction, 'This panel no longer exists.');

  const answers = {};
  const qs = (panel.questions || []).slice(0, DISCORD_LIMITS.MODAL_INPUTS_MAX);
  for (let i = 0; i < qs.length; i++) {
    let value = '';
    try { value = interaction.fields.getTextInputValue(`q${i}`); } catch { value = ''; }
    answers[qs[i]] = value;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channel = await createTicketChannel(interaction, panel, answers);
  if (channel) {
    await interaction.editReply({ content: `Ticket created: ${channel}` }).catch(() => {});
  }
}

// ───── Component handlers ─────

async function onPanelClick(interaction) {
  const prefix = `${IDS.PANEL_BUTTON}:`;
  if (!interaction.customId.startsWith(prefix)) return;
  const panelId = interaction.customId.slice(prefix.length);

  const g = db.guild(interaction.guildId);
  const uid = interaction.user.id;
  if (g.global_blacklist?.includes(uid) || g.ticket_blacklist?.includes(uid) || (g.application_blacklist || []).includes(uid)) {
    return ephemeral(interaction, 'You are blacklisted from opening tickets.');
  }
  const panel = g.panels[panelId];
  if (!panel) return ephemeral(interaction, 'This panel no longer exists.');

  const qs = (panel.questions || []).slice(0, DISCORD_LIMITS.MODAL_INPUTS_MAX);
  if (qs.length === 0) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = await createTicketChannel(interaction, panel, {});
    if (channel) await interaction.editReply({ content: `Ticket created: ${channel}` }).catch(() => {});
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`${IDS.PANEL_MODAL}:${panelId}`)
    .setTitle(truncate(`Open: ${panel.button_text}`, DISCORD_LIMITS.MODAL_TITLE));

  qs.forEach((q, i) => {
    const input = new TextInputBuilder()
      .setCustomId(`q${i}`)
      .setLabel(truncate(q, DISCORD_LIMITS.TEXT_INPUT_LABEL))
      .setStyle(q.length > 80 ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(1000);
    // Discord truncates the label at 45 chars — surface the rest via the placeholder
    // so the user can still read most of the question.
    if (q.length > DISCORD_LIMITS.TEXT_INPUT_LABEL) {
      input.setPlaceholder(truncate(q, DISCORD_LIMITS.TEXT_INPUT_PLACEHOLDER));
    }
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  });

  await interaction.showModal(modal);
}

async function onGroupSelect(interaction) {
  if (!checks.isStaff(interaction.member)) return ephemeral(interaction, 'Staff only.');
  const g = db.guild(interaction.guildId);
  const picked = interaction.values.map((id) => g.panels[id]).filter(Boolean);
  if (!picked.length) {
    return interaction.update({ content: 'None of the selected panels exist anymore.', components: [] }).catch(() => {});
  }

  const embed = buildPanelEmbed(g.description);
  const rows = buildPanelButtonRows(picked);
  if (rows.length > 5) {
    return interaction.update({ content: 'Too many panels selected — Discord allows at most 25 buttons (5 rows × 5).', components: [] }).catch(() => {});
  }

  try {
    await interaction.channel.send({ embeds: [embed], components: rows, allowedMentions: { parse: [] } });
  } catch (e) {
    return interaction.update({ content: `Failed to send: ${e?.message || 'unknown'}`, components: [] }).catch(() => {});
  }
  return interaction.update({ content: `Sent ${picked.length} panel(s) in ${interaction.channel}.`, components: [] }).catch(() => {});
}

async function onCloseClick(interaction) {
  const ticket = checks.getTicket(interaction.guildId, interaction.channel.id);
  if (!ticket) return ephemeral(interaction, 'This is not a ticket channel.');
  if (!checks.isStaff(interaction.member)) {
    return ephemeral(interaction, 'Only staff can close tickets directly. Use Request Close instead.');
  }
  await interaction.showModal(buildCloseReasonModal(interaction.channel.id));
}

async function onRequestCloseClick(interaction) {
  const g = db.guild(interaction.guildId);
  const ticket = g.tickets[interaction.channel.id];
  if (!ticket) return ephemeral(interaction, 'This is not a ticket channel.');

  const isStaff = checks.isStaff(interaction.member);
  ticket.close_requested_by = isStaff ? 'staff' : 'member';
  ticket.close_requested_by_user_id = interaction.user.id;
  await db.save();

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR_WARN)
    .setTitle(truncate('Close requested', DISCORD_LIMITS.EMBED_TITLE))
    .setDescription(truncate(
      `<@${interaction.user.id}> requested to close this ticket.\n\n` +
      (isStaff
        ? 'The ticket owner **or** staff may confirm.'
        : 'Only staff may confirm this close.'),
      DISCORD_LIMITS.EMBED_DESCRIPTION,
    ));

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.TICKET_CONFIRM_CLOSE).setLabel(truncate('Confirm Close', DISCORD_LIMITS.BUTTON_LABEL)).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(IDS.TICKET_CANCEL_CLOSE).setLabel(truncate('Cancel', DISCORD_LIMITS.BUTTON_LABEL)).setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ embeds: [embed], components: [buttons], allowedMentions: { parse: [] } });
}

async function onConfirmCloseClick(interaction) {
  const ticket = checks.getTicket(interaction.guildId, interaction.channel.id);
  if (!ticket) return ephemeral(interaction, 'This is not a ticket channel.');

  const userIsStaff = checks.isStaff(interaction.member);
  const userIsOwner = String(ticket.user_id) === String(interaction.user.id);

  let allowed;
  if (ticket.close_requested_by === 'staff') {
    allowed = userIsStaff || userIsOwner;
  } else if (ticket.close_requested_by === 'member') {
    allowed = userIsStaff;
  } else {
    allowed = userIsStaff;
  }

  if (!allowed) {
    return ephemeral(
      interaction,
      ticket.close_requested_by === 'staff'
        ? 'Only staff or the ticket owner can confirm this close.'
        : 'Only staff can confirm this close.',
    );
  }

  await interaction.showModal(buildCloseReasonModal(interaction.channel.id));
}

async function onCancelCloseClick(interaction) {
  const g = db.guild(interaction.guildId);
  const ticket = g.tickets[interaction.channel.id];
  if (!ticket) return ephemeral(interaction, 'This is not a ticket channel.');

  const userIsStaff = checks.isStaff(interaction.member);
  const userIsOwner = String(ticket.user_id) === String(interaction.user.id);
  const userIsRequester = String(ticket.close_requested_by_user_id || '') === String(interaction.user.id);
  if (!userIsStaff && !userIsOwner && !userIsRequester) {
    return ephemeral(interaction, 'You cannot cancel this close request.');
  }

  ticket.close_requested_by = null;
  ticket.close_requested_by_user_id = null;
  await db.save();

  const okEmbed = new EmbedBuilder()
    .setColor(EMBED_COLOR_OK)
    .setTitle(truncate('Close cancelled', DISCORD_LIMITS.EMBED_TITLE))
    .setDescription(truncate(`<@${interaction.user.id}> cancelled the close request.`, DISCORD_LIMITS.EMBED_DESCRIPTION));

  await interaction.update({ embeds: [okEmbed], components: [] }).catch(() => {});
}

// ───── Close reason modal submit ─────

async function onCloseReasonModal(interaction) {
  const prefix    = `${IDS.CLOSE_REASON_MODAL}:`;
  const channelId = interaction.customId.slice(prefix.length);
  if (channelId !== interaction.channel.id) {
    return ephemeral(interaction, 'This modal is for a different channel.');
  }
  const ticket = checks.getTicket(interaction.guildId, channelId);
  if (!ticket) return ephemeral(interaction, 'This ticket no longer exists.');

  let reason = null;
  try { reason = interaction.fields.getTextInputValue('reason')?.trim() || null; } catch { /* optional */ }

  await closeTicket(interaction, ticket, reason);
}

// ───── Save Transcript button ─────

async function onSaveTranscriptClick(interaction) {
  if (!checks.isStaff(interaction.member)) return ephemeral(interaction, 'Staff only.');

  const key  = interaction.customId.slice(`${IDS.TICKET_SAVE_TRANSCRIPT}:`.length);
  const meta = tdb.get(key);
  if (!meta) {
    // Transcript already gone — just remove the button
    return interaction.update({ embeds: interaction.message.embeds, components: [] }).catch(() => {});
  }
  meta.permanent = true;
  delete meta.expires_at;
  await tdb.save();

  // Rebuild embeds with updated footer
  const newEmbeds = interaction.message.embeds.map((e) =>
    EmbedBuilder.from(e).setFooter({ text: 'Transcript saved permanently' }),
  );

  // Rebuild components — disable the Save button
  const newComponents = interaction.message.components.map((row) => {
    const newRow = new ActionRowBuilder();
    for (const btn of row.components) {
      const b = ButtonBuilder.from(btn);
      if (btn.customId === interaction.customId) b.setDisabled(true);
      newRow.addComponents(b);
    }
    return newRow;
  });

  await interaction.update({ embeds: newEmbeds, components: newComponents });
}

// ───── Transcript helpers ─────

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function fetchAllMessages(channel, limit = 500) {
  const messages = [];
  let before = null;
  while (messages.length < limit) {
    const opts = { limit: 100 };
    if (before) opts.before = before;
    const batch = await channel.messages.fetch(opts).catch(() => null);
    if (!batch || batch.size === 0) break;
    messages.push(...batch.values());
    if (batch.size < 100) break;
    before = batch.last().id;
  }
  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return messages.slice(0, limit);
}

function generateHtmlTranscript(messages, ticket, panel, guild, closedBy, reason) {
  const panelName   = panel?.panel_id || 'unknown';
  const openedAt    = new Date(ticket.created_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const closedAt    = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const openedByMsg = messages.find((m) => m.author?.id === ticket.user_id);
  const openedByName = openedByMsg?.author?.username || `${ticket.user_id}`;
  const closedByName = closedBy.username || closedBy.id;

  // Q&A section
  let qaHtml = '';
  if (ticket.answers && Object.keys(ticket.answers).length) {
    const items = Object.entries(ticket.answers)
      .map(([q, a]) => `<div class="qa-item"><div class="qa-q">${escapeHtml(q)}</div><div class="qa-a">${escapeHtml(a || '—')}</div></div>`)
      .join('');
    qaHtml = `<div class="qa-section"><h2>📋 Form Answers</h2>${items}</div>`;
  }

  // Messages — group consecutive messages by same author within 5 min (Discord-style)
  const msgLines = [];
  let lastAuthorId = null;
  let lastMsgTime  = 0;
  for (const msg of messages) {
    const authorId  = msg.author?.id || 'unknown';
    const msgTime   = msg.createdTimestamp;
    const grouped   = authorId === lastAuthorId && (msgTime - lastMsgTime) < 5 * 60 * 1000;
    lastAuthorId    = authorId;
    lastMsgTime     = msgTime;

    const avatarUrl = msg.author?.displayAvatarURL({ extension: 'png', size: 64 }) || '';
    const username  = escapeHtml(msg.author?.username || 'Unknown');
    const ts        = new Date(msgTime).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });

    const contentHtml = msg.content
      ? `<div class="text">${escapeHtml(msg.content)}</div>`
      : '';

    const attachHtml = [...msg.attachments.values()].map((att) => {
      const isImg = /\.(png|jpe?g|gif|webp|svg)$/i.test(att.name || '');
      return isImg
        ? `<div class="att"><img src="${escapeHtml(att.url)}" alt="${escapeHtml(att.name)}" loading="lazy"></div>`
        : `<div class="att"><a href="${escapeHtml(att.url)}" target="_blank" rel="noopener">📎 ${escapeHtml(att.name || 'file')}</a></div>`;
    }).join('');

    const embedHtml = msg.embeds.map((emb) => {
      const col   = emb.color ? `#${emb.color.toString(16).padStart(6, '0')}` : '#5865f2';
      const title = emb.title ? `<div class="emb-title">${escapeHtml(emb.title)}</div>` : '';
      const desc  = emb.description ? `<div class="emb-desc">${escapeHtml(emb.description)}</div>` : '';
      return `<div class="emb-wrap"><div class="emb" style="border-left-color:${col}">${title}${desc}</div></div>`;
    }).join('');

    if (grouped) {
      msgLines.push(`<div class="msg"><div class="av-ph"></div><div class="body">${contentHtml}${attachHtml}${embedHtml}</div></div>`);
    } else {
      msgLines.push(`<div class="msg new-grp"><img class="av" src="${escapeHtml(avatarUrl)}" alt="${username}" onerror="this.style.display='none'"><div class="body"><div class="hdr"><span class="uname">${username}</span><span class="ts">${escapeHtml(ts)}</span></div>${contentHtml}${attachHtml}${embedHtml}</div></div>`);
    }
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Transcript #${ticket.ticket_id} — ${escapeHtml(panelName)}</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#313338;color:#dbdee1;font-family:'gg sans','Noto Sans',Whitney,Helvetica,Arial,sans-serif;font-size:16px}
.hd{background:#1e1f22;padding:14px 20px;border-bottom:2px solid #111214;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.hd h1{font-size:18px;color:#fff;font-weight:700;margin-right:4px;white-space:nowrap}
.badge{background:#2b2d31;border-radius:4px;padding:3px 9px;font-size:12px;color:#b5bac1;white-space:nowrap}
.badge b{color:#fff;font-weight:600}
.qa-section{background:#2b2d31;border-radius:8px;margin:14px 16px;padding:14px}
.qa-section h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#b5bac1;margin-bottom:10px;font-weight:700}
.qa-item{margin-bottom:8px}
.qa-q{font-weight:600;color:#dbdee1;font-size:14px}
.qa-a{color:#b5bac1;font-size:14px;margin-top:2px;white-space:pre-wrap}
.msgs{padding:8px 0 20px}
.msg{display:flex;gap:14px;padding:2px 14px}
.msg:hover{background:#2e3035}
.msg.new-grp{margin-top:17px}
.av{width:40px;height:40px;border-radius:50%;flex-shrink:0;margin-top:1px;object-fit:cover}
.av-ph{width:40px;flex-shrink:0}
.body{flex:1;min-width:0}
.hdr{display:flex;align-items:baseline;gap:8px;margin-bottom:2px}
.uname{font-weight:600;color:#fff;font-size:16px}
.ts{font-size:12px;color:#87898c}
.text{color:#dbdee1;line-height:1.375;word-wrap:break-word;white-space:pre-wrap}
.att{margin-top:4px}.att img{max-width:400px;max-height:300px;border-radius:4px;display:block;margin-top:2px}
.att a{color:#00a8fc;text-decoration:none}.att a:hover{text-decoration:underline}
.emb-wrap{margin-top:4px;max-width:520px}.emb{border-left:4px solid #5865f2;background:#2b2d31;border-radius:0 4px 4px 0;padding:8px 12px}
.emb-title{font-weight:700;color:#fff;margin-bottom:4px;font-size:15px}
.emb-desc{color:#dbdee1;font-size:14px;white-space:pre-wrap;line-height:1.375}
</style></head><body>
<div class="hd">
  <h1>🎫 Ticket #${ticket.ticket_id} — ${escapeHtml(panelName)}</h1>
  <div class="badge">GUILD <b>${escapeHtml(guild?.name || '')}</b></div>
  <div class="badge">OPENED BY <b>${escapeHtml(openedByName)}</b></div>
  <div class="badge">CLOSED BY <b>${escapeHtml(closedByName)}</b></div>
  <div class="badge">OPENED <b>${escapeHtml(openedAt)}</b></div>
  <div class="badge">CLOSED <b>${escapeHtml(closedAt)}</b></div>
  ${reason ? `<div class="badge">REASON <b>${escapeHtml(reason)}</b></div>` : ''}
  <div class="badge">MESSAGES <b>${messages.length}</b></div>
</div>
${qaHtml}
<div class="msgs">${msgLines.join('')}</div>
</body></html>`;
}

// ───── /ticket log handler ─────

async function handleLog(interaction) {
  if (!checks.isAdmin(interaction.member)) return ephemeral(interaction, 'Admin only.');
  const g = db.guild(interaction.guildId);
  const channel = interaction.options.getChannel('channel');
  if (!channel) {
    g.log_ticket_channel_id = null;
    await db.save();
    return ephemeral(interaction, 'Ticket transcript log channel cleared.');
  }
  g.log_ticket_channel_id = channel.id;
  await db.save();
  return ephemeral(interaction, `Ticket transcripts will be sent to ${channel}.`);
}

// ───── Channel creation & teardown ─────

function buildTicketOverwrites(guild, ownerId, g) {
  const me = guild.members.me;
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: ownerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
      ],
    },
  ];
  if (me) {
    overwrites.push({
      id: me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
      ],
    });
  }
  if (g.staff_role_id) {
    overwrites.push({
      id: g.staff_role_id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
      ],
    });
  }
  const seen = new Set([guild.roles.everyone.id, ownerId, g.staff_role_id || '', me?.id || '']);
  for (const rid of (g.view_role_ids || [])) {
    if (seen.has(rid)) continue;
    seen.add(rid);
    overwrites.push({
      id: rid,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
      ],
    });
  }
  return overwrites;
}

async function createTicketChannel(interaction, panel, answers) {
  const guild = interaction.guild;
  const owner = interaction.user;
  const g = db.guild(guild.id);

  const counter  = db.nextTicketNumber(guild.id, panel.panel_id);
  const ticketId = db.nextGlobalTicketId(guild.id);
  await db.save();

  const name = slugChannelName(panel.panel_id, counter);
  const overwrites = buildTicketOverwrites(guild, owner.id, g);

  let channel;
  try {
    channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: panel.category_id || undefined,
      permissionOverwrites: overwrites,
      topic: truncate(`Ticket opened by ${owner.tag} • Panel: ${panel.panel_id}`, 1024),
      reason: `Ticket opened by ${owner.tag}`,
    });
  } catch (err) {
    console.error('[tickets] create channel failed:', err);
    await safeReply(interaction, { content: `Failed to create ticket channel: ${err?.message || 'unknown error'}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    return null;
  }

  g.tickets[channel.id] = {
    ticket_id: ticketId,
    channel_id: channel.id,
    user_id: owner.id,
    panel_id: panel.panel_id,
    panel_number: counter,
    answers,
    close_requested_by: null,
    close_requested_by_user_id: null,
    created_at: Date.now(),
  };
  await db.save();

  // Log "Ticket Opened"
  if (g.log_ticket_channel_id) {
    guild.client.channels.fetch(g.log_ticket_channel_id).then((logCh) => {
      const openedEmbed = new EmbedBuilder()
        .setColor(EMBED_COLOR_OK)
        .setTitle('🎫 Ticket Opened')
        .addFields(
          { name: 'Ticket ID', value: `#${ticketId}`, inline: true },
          { name: 'Panel', value: truncate(panel.panel_id, DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: true },
          { name: 'Opened by', value: `<@${owner.id}>`, inline: true },
          { name: 'Channel', value: `<#${channel.id}>`, inline: true },
          { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
        )
        .setTimestamp();
      return logCh.send({ embeds: [openedEmbed] });
    }).catch((e) => console.error('[tickets] open log failed:', e?.message));
  }

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR_BRAND)
    .setTitle(truncate(`${panel.button_text}`, DISCORD_LIMITS.EMBED_TITLE))
    .setDescription(truncate(`Hey <@${owner.id}>! Our support team will be with you shortly. 🍩\n\nPlease describe your issue and we'll help you out!`, DISCORD_LIMITS.EMBED_DESCRIPTION))
    .setFooter({ text: truncate(`${guild.name} Support`, DISCORD_LIMITS.EMBED_FOOTER) })
    .setTimestamp(new Date());

  if (answers && Object.keys(answers).length) {
    let totalChars = (embed.data.title?.length || 0) + (embed.data.description?.length || 0) + (embed.data.footer?.text?.length || 0);
    let fieldsAdded = 0;
    for (const [q, a] of Object.entries(answers)) {
      if (fieldsAdded >= DISCORD_LIMITS.EMBED_FIELDS_MAX) break;
      const name = truncate(q, DISCORD_LIMITS.EMBED_FIELD_NAME);
      const value = truncate(a || '—', DISCORD_LIMITS.EMBED_FIELD_VALUE);
      if (totalChars + name.length + value.length > DISCORD_LIMITS.EMBED_TOTAL - 200) break;
      totalChars += name.length + value.length;
      embed.addFields({ name, value });
      fieldsAdded++;
    }
  }

  const pingIds = [];
  const pings = [`<@${owner.id}>`];
  for (const rid of (g.ping_role_ids || [])) {
    pings.push(`<@&${rid}>`);
    pingIds.push(rid);
  }
  if (g.staff_role_id && !pingIds.includes(g.staff_role_id)) {
    pings.push(`<@&${g.staff_role_id}>`);
    pingIds.push(g.staff_role_id);
  }

  try {
    await channel.send({
      content: truncate(pings.join(' '), DISCORD_LIMITS.MESSAGE_CONTENT),
      embeds: [embed],
      components: [buildTicketTopButtons()],
      allowedMentions: { users: [owner.id], roles: pingIds },
    });
  } catch (err) {
    console.error('[tickets] send initial msg failed:', err?.message);
  }

  return channel;
}

async function closeTicket(interaction, ticket, reason) {
  const g = db.guild(interaction.guildId);
  const logChannelId  = g.log_ticket_channel_id;
  const panel         = g.panels[ticket.panel_id] || null;
  const channelName   = interaction.channel.name;
  const ticketId      = ticket.ticket_id ?? null;
  const closedBy      = interaction.user;

  delete g.tickets[interaction.channel.id];
  await db.save();

  const ackEmbed = new EmbedBuilder()
    .setColor(EMBED_COLOR_WARN)
    .setTitle(truncate('Ticket closing', DISCORD_LIMITS.EMBED_TITLE))
    .setDescription(truncate(`Closed by <@${closedBy.id}>. This channel will be deleted in 5 seconds.`, DISCORD_LIMITS.EMBED_DESCRIPTION));

  await safeReply(interaction, { embeds: [ackEmbed] });

  const channel = interaction.channel;
  const client  = interaction.client;
  const guild   = interaction.guild;

  (async () => {
    // Generate HTML transcript
    let transcriptKey  = null;
    let transcriptPath = null;
    let transcriptUrl  = null;

    if (logChannelId && ticketId != null) {
      try {
        const messages = await fetchAllMessages(channel);
        const html = generateHtmlTranscript(messages, ticket, panel, guild, closedBy, reason);
        const dir  = path.join(__dirname, '..', 'data', 'transcripts');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        transcriptKey  = `${guild.id}_${ticketId}`;
        transcriptPath = path.join(dir, `${transcriptKey}.html`);
        fs.writeFileSync(transcriptPath, html, 'utf8');
        transcriptUrl  = `${TRANSCRIPT_BASE_URL}/transcripts/${transcriptKey}`;
        const expiresAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
        tdb.set(transcriptKey, {
          ticket_id: ticketId, guild_id: guild.id,
          path: transcriptPath, permanent: false, expires_at: expiresAt,
          log_message_id: null, log_channel_id: logChannelId,
        });
        await tdb.save();
      } catch (e) {
        console.error('[tickets] transcript generation failed:', e?.message);
      }
    }

    await new Promise((r) => setTimeout(r, 5000));

    // Send close log embed
    if (logChannelId) {
      try {
        const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
        if (logChannel) {
          const closedEmbed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle('🔒 Ticket Closed')
            .addFields(
              { name: 'Ticket ID', value: ticketId != null ? `#${ticketId}` : 'N/A', inline: true },
              { name: 'Panel', value: truncate(panel?.panel_id || 'unknown', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: true },
              { name: 'Channel', value: truncate(channelName, DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: true },
              { name: 'Opened by', value: `<@${ticket.user_id}>`, inline: true },
              { name: 'Closed by', value: `<@${closedBy.id}>`, inline: true },
              { name: 'Reason', value: truncate(reason || 'No reason provided', DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: true },
              { name: 'Opened at', value: `<t:${Math.floor(ticket.created_at / 1000)}:F>`, inline: true },
              { name: 'Closed at', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
            )
            .setFooter({ text: transcriptPath ? 'Transcript auto-deletes in 3 days' : 'No transcript log channel configured' })
            .setTimestamp();

          const components = [];
          if (transcriptKey && transcriptUrl) {
            components.push(new ActionRowBuilder().addComponents(
              new ButtonBuilder().setLabel('🌐 View Transcript').setStyle(ButtonStyle.Link).setURL(transcriptUrl),
              new ButtonBuilder()
                .setCustomId(`${IDS.TICKET_SAVE_TRANSCRIPT}:${transcriptKey}`)
                .setLabel('💾 Save Transcript')
                .setStyle(ButtonStyle.Secondary),
            ));
          }

          const logMsg = await logChannel.send({ embeds: [closedEmbed], components });
          if (transcriptKey) {
            const meta = tdb.get(transcriptKey);
            if (meta) { meta.log_message_id = logMsg.id; await tdb.save(); }
          }
        }
      } catch (e) {
        console.error('[tickets] close log failed:', e?.message);
      }
    }

    // DM the ticket opener (unless suppressed for app-linked tickets)
    if (!ticket.no_close_dm) {
      try {
        const opener = await client.users.fetch(ticket.user_id).catch(() => null);
        if (opener) {
          await opener.send(
            `🔒 Your ticket **${channelName}** in **${guild.name}** has been closed.\n` +
            `**Closed by:** ${closedBy.username}\n` +
            `**Reason:** ${reason || 'No reason provided'}`,
          ).catch(() => {});
        }
      } catch { /* ignore */ }
    }

    try {
      await channel.delete(`Ticket closed by ${closedBy.username}`);
    } catch (e) {
      console.error('[tickets] delete channel failed:', e?.message);
    }
  })().catch((e) => console.error('[tickets] close flow error:', e?.message));
}

// ───── Event dispatcher ─────

function register(client) {
  // Clean up expired transcripts on startup
  client.once('ready', async () => {
    let cleaned = 0;
    const now = Date.now();
    for (const [key, meta] of Object.entries(tdb.all())) {
      if (!meta.permanent && meta.expires_at && meta.expires_at < now) {
        try { if (fs.existsSync(meta.path)) fs.unlinkSync(meta.path); } catch {}
        tdb.remove(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      await tdb.save().catch(() => {});
      console.log(`[tickets] cleaned up ${cleaned} expired transcript(s)`);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === 'ticket') {
        if (!interaction.inGuild()) return ephemeral(interaction, 'Guild-only command.');
        const sub = interaction.options.getSubcommand();
        switch (sub) {
          case 'description': return await handleDescription(interaction);
          case 'setup':       return await handleSetup(interaction);
          case 'group':       return await handleGroup(interaction);
          case 'rename':      return await handleRename(interaction);
          case 'add':         return await handleAdd(interaction);
          case 'remove':      return await handleRemove(interaction);
          case 'move':        return await handleMove(interaction);
          case 'view':        return await handleView(interaction);
          case 'ping':        return await handlePing(interaction);
          case 'panels':      return await handlePanels(interaction);
          case 'info':        return await handleInfo(interaction);
          case 'edit':        return await handleEdit(interaction);
          case 'delete':      return await handleDelete(interaction);
          case 'log':         return await handleLog(interaction);
          default:            return ephemeral(interaction, 'Unknown subcommand.');
        }
      }

      if (interaction.isButton()) {
        const id = interaction.customId;
        if (id.startsWith(`${IDS.PANEL_BUTTON}:`))           return await onPanelClick(interaction);
        if (id === IDS.TICKET_CLOSE)                         return await onCloseClick(interaction);
        if (id === IDS.TICKET_REQUEST_CLOSE)                 return await onRequestCloseClick(interaction);
        if (id === IDS.TICKET_CONFIRM_CLOSE)                 return await onConfirmCloseClick(interaction);
        if (id === IDS.TICKET_CANCEL_CLOSE)                  return await onCancelCloseClick(interaction);
        if (id.startsWith(`${IDS.TICKET_SAVE_TRANSCRIPT}:`)) return await onSaveTranscriptClick(interaction);
        return;
      }

      if (interaction.isStringSelectMenu()) {
        if (interaction.customId === IDS.GROUP_SELECT) return await onGroupSelect(interaction);
        return;
      }

      if (interaction.isModalSubmit()) {
        const id = interaction.customId;
        if (id === IDS.DESCRIPTION_MODAL)                   return await onDescriptionModal(interaction);
        if (id === IDS.SETUP_MODAL)                         return await onSetupModal(interaction);
        if (id.startsWith(`${IDS.PANEL_MODAL}:`))           return await onPanelModal(interaction);
        if (id.startsWith(`${IDS.CLOSE_REASON_MODAL}:`))    return await onCloseReasonModal(interaction);
        return;
      }
    } catch (err) {
      console.error('[tickets] interaction handler error:', err);
      try {
        const msg = 'Something went wrong handling this interaction.';
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
        } else if (interaction.isRepliable && interaction.isRepliable()) {
          await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        }
      } catch {/* swallow */}
    }
  });
}

// ───── createLinkedTicket (called from applications module) ─────

async function createLinkedTicket(client, guild, targetUser, staffMember, adminOnly, guildId) {
  const g  = db.guild(guildId);
  const me = guild.members.me;

  const ticketId = db.nextGlobalTicketId(guildId);
  await db.save();

  const name = slugChannelName('app-ticket', ticketId);

  const botPerms = [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
  ];
  const userPerms = [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
  ];

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: targetUser.id, allow: userPerms },
  ];
  if (me) overwrites.push({ id: me.id, allow: botPerms });

  if (adminOnly) {
    // Only roles with Administrator permission + the user
    for (const role of guild.roles.cache.values()) {
      if (role.id === guild.roles.everyone.id) continue;
      if (role.permissions.has(PermissionFlagsBits.Administrator)) {
        overwrites.push({ id: role.id, allow: userPerms });
      }
    }
  } else {
    if (g.staff_role_id) overwrites.push({ id: g.staff_role_id, allow: userPerms });
  }

  let channel;
  try {
    const firstPanel = Object.values(g.panels)[0];
    channel = await guild.channels.create({
      name,
      type: 0, // GuildText
      parent: firstPanel?.category_id || undefined,
      permissionOverwrites: overwrites,
      topic: truncate(`${adminOnly ? 'Admin ticket' : 'Ticket'} for ${targetUser.tag} · opened by ${staffMember.user.tag}`, 1024),
    });
  } catch (e) {
    console.error('[tickets] createLinkedTicket channel failed:', e?.message);
    return null;
  }

  g.tickets[channel.id] = {
    ticket_id: ticketId,
    channel_id: channel.id,
    user_id: targetUser.id,
    panel_id: adminOnly ? 'admin-linked' : 'staff-linked',
    panel_number: ticketId,
    answers: {},
    close_requested_by: null,
    close_requested_by_user_id: null,
    created_at: Date.now(),
    no_close_dm: true,
  };
  await db.save();

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.TICKET_CLOSE)
      .setLabel('🔒 Close Ticket')
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({
    content: `<@${targetUser.id}> <@${staffMember.user.id}>`,
    embeds: [new EmbedBuilder()
      .setColor(adminOnly ? 0xED4245 : 0x5865F2)
      .setTitle(adminOnly ? '🔒 Admin Ticket' : '🎫 Ticket')
      .setDescription(`Opened by <@${staffMember.user.id}> for <@${targetUser.id}>.`)
      .setTimestamp(),
    ],
    components: [closeRow],
    allowedMentions: { users: [targetUser.id, staffMember.user.id] },
  });

  return channel;
}

module.exports = {
  commands: [ticketCommand],
  register,
  createLinkedTicket,
};
