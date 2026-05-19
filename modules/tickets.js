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

const db = require('../lib/db');
const checks = require('../lib/checks');
const { DISCORD_LIMITS, IDS, truncate } = require('../config');

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
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
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
  .addSubcommand((s) =>
    s.setName('delete').setDescription('Delete a configured panel')
      .addStringOption((o) => o.setName('panel_id').setDescription('Panel ID to delete').setRequired(true).setMaxLength(32)),
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
  if (!checks.isStaff(interaction.member)) return ephemeral(interaction, 'Staff only.');
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
  await closeTicket(interaction, ticket);
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

  await closeTicket(interaction, ticket);
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

  const counter = db.nextTicketNumber(guild.id, panel.panel_id);
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

async function closeTicket(interaction, ticket) {
  const g = db.guild(interaction.guildId);
  delete g.tickets[interaction.channel.id];
  await db.save();

  const ackEmbed = new EmbedBuilder()
    .setColor(EMBED_COLOR_WARN)
    .setTitle(truncate('Ticket closing', DISCORD_LIMITS.EMBED_TITLE))
    .setDescription(truncate(`Closed by <@${interaction.user.id}>. This channel will be deleted in 5 seconds.`, DISCORD_LIMITS.EMBED_DESCRIPTION));

  try {
    if (interaction.isButton()) {
      await interaction.update({ embeds: [ackEmbed], components: [] }).catch(async () => {
        await interaction.reply({ embeds: [ackEmbed] }).catch(() => {});
      });
    } else {
      await safeReply(interaction, { embeds: [ackEmbed] });
    }
  } catch (e) {
    console.warn('[tickets] close ack failed:', e?.message);
  }

  const channel = interaction.channel;
  setTimeout(async () => {
    try {
      await channel.delete(`Ticket closed by ${interaction.user.tag}`);
    } catch (e) {
      console.error('[tickets] delete channel failed:', e?.message);
    }
  }, 5000);
}

// ───── Event dispatcher ─────

function register(client) {
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
          case 'delete':      return await handleDelete(interaction);
          default:            return ephemeral(interaction, 'Unknown subcommand.');
        }
      }

      if (interaction.isButton()) {
        const id = interaction.customId;
        if (id.startsWith(`${IDS.PANEL_BUTTON}:`)) return await onPanelClick(interaction);
        if (id === IDS.TICKET_CLOSE)               return await onCloseClick(interaction);
        if (id === IDS.TICKET_REQUEST_CLOSE)       return await onRequestCloseClick(interaction);
        if (id === IDS.TICKET_CONFIRM_CLOSE)       return await onConfirmCloseClick(interaction);
        if (id === IDS.TICKET_CANCEL_CLOSE)        return await onCancelCloseClick(interaction);
        return;
      }

      if (interaction.isStringSelectMenu()) {
        if (interaction.customId === IDS.GROUP_SELECT) return await onGroupSelect(interaction);
        return;
      }

      if (interaction.isModalSubmit()) {
        const id = interaction.customId;
        if (id === IDS.DESCRIPTION_MODAL)             return await onDescriptionModal(interaction);
        if (id === IDS.SETUP_MODAL)                   return await onSetupModal(interaction);
        if (id.startsWith(`${IDS.PANEL_MODAL}:`))     return await onPanelModal(interaction);
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

module.exports = {
  commands: [ticketCommand],
  register,
};
