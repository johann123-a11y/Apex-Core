'use strict';

const {
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags,
  EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ComponentType,
} = require('discord.js');

const adb     = require('../lib/app-db');
const db      = require('../lib/db');
const checks  = require('../lib/checks');
const tickets = require('./tickets');
const { truncate, DISCORD_LIMITS } = require('../config');

const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const Q_TIMEOUT   = 10 * 60 * 1000;

// ─── Custom ID constants ───────────────────────────────────────────────────────
const ID = {
  SETUP_MODAL:  'app:setup_modal',
  DESC_MODAL:   'app:desc_modal',
  ADD_YN:       'app:add_yn:',     // + appId
  ADD_TXT:      'app:add_txt:',    // + appId
  DONE:         'app:done:',       // + appId
  YN_MODAL:     'app:yn_modal:',   // + appId
  TXT_MODAL:    'app:txt_modal:',  // + appId
  GROUP_SELECT: 'app:group',
  APPLY_SELECT: 'app:apply',
  ACCEPT:       'app:accept:',     // + submissionId
  DENY:         'app:deny:',       // + submissionId
  ACCEPT_R:     'app:acptr:',      // + submissionId  (different prefix — no startsWith conflict)
  DENY_R:       'app:denyr:',      // + submissionId
  R_ACCEPT:     'app:r_accept:',   // + submissionId (modal)
  R_DENY:       'app:r_deny:',     // + submissionId (modal)
  // ── /application info ──
  INFO_SEL:     'app:info_sel',    // overview select menu
  EDIT_DET:     'app:edet:',       // edit details button + appId
  EDIT_DET_M:   'app:edetm:',      // edit details modal + appId
  IAYN:         'app:iayn:',       // info-context add yes/no Q button + appId
  IATXT:        'app:iatxt:',      // info-context add text Q button + appId
  IAYN_M:       'app:iaynm:',      // info-context yes/no Q modal + appId
  IATXT_M:      'app:iatxtm:',     // info-context text Q modal + appId
  RMQ_BTN:      'app:rmqbtn:',     // show remove-question select + appId
  RMQ_SEL:      'app:rmqsel:',     // remove-question select menu + appId
  DEL_BTN:      'app:delbtn:',     // delete app button + appId
  DEL_CONF:     'app:delcnf:',     // confirm delete button + appId
  BACK:         'app:back:',       // back to detail view + appId
  OPEN_TKT:     'app:opentkt:',    // open ticket with applicant + submissionId
  OPEN_ATKT:    'app:openatkt:',   // open admin ticket with applicant + submissionId
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || `app-${Date.now()}`;
}

function fmtDuration(ms) {
  if (ms < 60000)    return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000)  return `${Math.floor(ms / 60000)}m`;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ─── Command builder ──────────────────────────────────────────────────────────

const command = new SlashCommandBuilder()
  .setName('application')
  .setDescription('Manage the application system')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('setup').setDescription('Create or edit an application'))
  .addSubcommand((s) => s.setName('description').setDescription('Set the panel embed description'))
  .addSubcommand((s) => s.setName('group').setDescription('Send an application panel in this channel'))
  .addSubcommand((s) =>
    s.setName('pending').setDescription('Set channel for pending applications')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true)),
  )
  .addSubcommand((s) =>
    s.setName('accepted').setDescription('Set channel for accepted applications')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true)),
  )
  .addSubcommand((s) =>
    s.setName('denied').setDescription('Set channel for denied applications')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true)),
  )
  .addSubcommand((s) => s.setName('info').setDescription('View and manage all applications'));

// ─── Setup embed helpers ──────────────────────────────────────────────────────

function buildSetupEmbed(app) {
  const qLines = app.questions.length
    ? app.questions.map((q, i) => `**${i + 1}.** [${q.type === 'yes_no' ? 'Yes/No' : 'Text'}] ${q.text}`)
    : ['_None yet — add them below!_'];
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('✅ Application Created')
    .addFields(
      { name: 'Name', value: app.name,        inline: true },
      { name: 'For',  value: app.applyingFor, inline: true },
      { name: 'Questions', value: truncate(qLines.join('\n'), DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
    )
    .setTimestamp();
}

function buildSetupButtons(appId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ID.ADD_YN + appId).setLabel('➕ Yes/No Question').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(ID.ADD_TXT + appId).setLabel('➕ Text Question').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(ID.DONE + appId).setLabel('✅ Done').setStyle(ButtonStyle.Success).setDisabled(disabled),
  );
}

// ─── /application setup ───────────────────────────────────────────────────────

async function handleSetup(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const modal = new ModalBuilder().setCustomId(ID.SETUP_MODAL).setTitle('New Application');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('name').setLabel('Application Name (e.g. Staff Application)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('for').setLabel('Applying for (e.g. Moderator)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('role_id').setLabel('Role ID to give on accept (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(30),
    ),
  );
  return interaction.showModal(modal);
}

async function onSetupModal(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const name    = interaction.fields.getTextInputValue('name').trim();
  const forRole = interaction.fields.getTextInputValue('for').trim();
  const roleId  = interaction.fields.getTextInputValue('role_id')?.trim() || null;
  const appId   = slugify(name);

  const g = adb.guild(interaction.guildId);
  g.applications[appId] = {
    id: appId, name, applyingFor: forRole,
    roleOnAccept: roleId || null,
    questions: [], status: 'draft', draft: true,
  };
  await adb.save();

  return interaction.reply({
    embeds: [buildSetupEmbed(g.applications[appId])],
    components: [buildSetupButtons(appId)],
    flags: MessageFlags.Ephemeral,
  });
}

// ─── Add question buttons ─────────────────────────────────────────────────────

async function onAddQuestionBtn(interaction, type) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const appId   = interaction.customId.slice((type === 'yes_no' ? ID.ADD_YN : ID.ADD_TXT).length);
  const modalId = (type === 'yes_no' ? ID.YN_MODAL : ID.TXT_MODAL) + appId;

  const modal = new ModalBuilder().setCustomId(modalId).setTitle('Add Question');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('question')
      .setLabel(type === 'yes_no' ? 'Yes/No question text' : 'Text question text')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(300),
  ));
  return interaction.showModal(modal);
}

async function onQuestionModal(interaction, type) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const prefix = type === 'yes_no' ? ID.YN_MODAL : ID.TXT_MODAL;
  const appId  = interaction.customId.slice(prefix.length);
  const text   = interaction.fields.getTextInputValue('question').trim();

  const g = adb.guild(interaction.guildId);
  const app = g.applications[appId];
  if (!app) return interaction.reply({ content: 'Application not found.', flags: MessageFlags.Ephemeral });

  app.questions.push({ text, type });
  await adb.save();

  return interaction.update({ embeds: [buildSetupEmbed(app)], components: [buildSetupButtons(appId)] });
}

// ─── Done button ──────────────────────────────────────────────────────────────

async function onDoneBtn(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const appId = interaction.customId.slice(ID.DONE.length);
  const g     = adb.guild(interaction.guildId);
  const app   = g.applications[appId];
  if (!app) return interaction.update({ content: 'Application not found.', embeds: [], components: [] });

  app.status = 'ready';
  app.draft  = false;
  await adb.save();

  const qLines = app.questions.length
    ? app.questions.map((q, i) => `**${i + 1}.** [${q.type === 'yes_no' ? 'Yes/No' : 'Text'}] ${q.text}`)
    : ['_No questions added._'];

  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('✅ Application Ready')
    .addFields(
      { name: 'Name', value: app.name,        inline: true },
      { name: 'For',  value: app.applyingFor, inline: true },
      { name: 'Questions', value: truncate(qLines.join('\n'), DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
      { name: 'Status', value: '✅ Application is ready! Use `/application group` to post it.', inline: false },
    )
    .setTimestamp();

  return interaction.update({ embeds: [embed], components: [buildSetupButtons(appId, true)] });
}

// ─── /application description ─────────────────────────────────────────────────

async function handleDescription(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const d = adb.guild(interaction.guildId).panelDescription;
  const modal = new ModalBuilder().setCustomId(ID.DESC_MODAL).setTitle('Panel Description');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(256).setValue(d.title || ''),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('subtitle').setLabel('Subtitle (shown bold)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(256).setValue(d.subtitle || ''),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('description').setLabel('Description / Rules').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(3000).setValue(d.description || ''),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('footer').setLabel('Footer text (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200).setValue(d.footer || ''),
    ),
  );
  return interaction.showModal(modal);
}

async function onDescriptionModal(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const g = adb.guild(interaction.guildId);
  g.panelDescription = {
    title:       interaction.fields.getTextInputValue('title').trim(),
    subtitle:    interaction.fields.getTextInputValue('subtitle').trim(),
    description: interaction.fields.getTextInputValue('description').trim(),
    footer:      interaction.fields.getTextInputValue('footer').trim(),
  };
  await adb.save();
  return interaction.reply({ content: '✅ Panel description saved.', flags: MessageFlags.Ephemeral });
}

// ─── /application group ───────────────────────────────────────────────────────

async function handleGroup(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const g    = adb.guild(interaction.guildId);
  const apps = Object.values(g.applications);
  if (!apps.length)
    return interaction.reply({ content: 'No applications found. Create one with `/application setup`.', flags: MessageFlags.Ephemeral });

  const options = apps.slice(0, 25).map((a) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(truncate((a.draft ? '⚠️ ' : '') + a.name, 90))
      .setValue(a.id)
      .setDescription(truncate(`Applying for: ${a.applyingFor}`, 90)),
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(ID.GROUP_SELECT)
    .setPlaceholder('Select applications to include...')
    .setMinValues(1)
    .setMaxValues(options.length)
    .addOptions(options);

  return interaction.reply({
    content: 'Select which applications to include in the panel:',
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

async function onGroupSelect(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const selectedIds = interaction.values;
  const g = adb.guild(interaction.guildId);
  const d = g.panelDescription;

  const descParts = [];
  if (d.subtitle)    descParts.push(`**${d.subtitle}**`);
  if (d.description) descParts.push(d.description);

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(d.title || 'Applications')
    .setTimestamp();
  if (descParts.length) embed.setDescription(truncate(descParts.join('\n\n'), DISCORD_LIMITS.EMBED_DESCRIPTION));
  if (d.footer) embed.setFooter({ text: d.footer });

  const options = selectedIds.map((id) => {
    const a = g.applications[id];
    return new StringSelectMenuOptionBuilder()
      .setLabel(truncate(a.name, 90))
      .setValue(id)
      .setDescription(truncate(`Apply for: ${a.applyingFor}`, 90));
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(ID.APPLY_SELECT)
    .setPlaceholder('Select an application...')
    .setMinValues(1).setMaxValues(1)
    .addOptions(options);

  const sent = await interaction.channel.send({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
  });

  g.activeMessages = g.activeMessages.filter((m) => m.messageId !== sent.id);
  g.activeMessages.push({ messageId: sent.id, channelId: interaction.channel.id, applicationIds: selectedIds });
  await adb.save();

  return interaction.update({ content: '✅ Panel sent!', components: [] });
}

// ─── Channel config ───────────────────────────────────────────────────────────

async function handleChannel(interaction, type) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const ch = interaction.options.getChannel('channel', true);
  if (!ch.isTextBased() || ch.isDMBased())
    return interaction.reply({ content: 'Please select a text channel.', flags: MessageFlags.Ephemeral });

  const g = db.guild(interaction.guildId);
  const keyMap = {
    pending:  'application_pending_channel_id',
    accepted: 'application_accepted_channel_id',
    denied:   'application_denied_channel_id',
  };
  g[keyMap[type]] = ch.id;
  await db.save();

  const labels = { pending: 'Pending', accepted: 'Accepted', denied: 'Denied' };
  return interaction.reply({ content: `✅ ${labels[type]} channel set to ${ch}.`, flags: MessageFlags.Ephemeral });
}

// ─── Apply select (user picks application) ────────────────────────────────────

async function onApplySelect(interaction) {
  const appId = interaction.values[0];
  const g     = adb.guild(interaction.guildId);
  const app   = g.applications[appId];

  if (!app)
    return interaction.reply({ content: 'That application no longer exists.', flags: MessageFlags.Ephemeral });

  const userId = interaction.user.id;

  // Blacklist check
  const guildDb = db.guild(interaction.guildId);
  if (guildDb.global_blacklist?.includes(userId) || guildDb.app_blacklist?.includes(userId) || guildDb.application_blacklist?.includes(userId))
    return interaction.reply({ content: 'You are blacklisted from opening applications.', flags: MessageFlags.Ephemeral });

  // Cooldown check
  const cooldown = g.cooldowns.find((c) => c.userId === userId && c.applicationId === appId);
  if (cooldown && (Date.now() - cooldown.lastApplied) < COOLDOWN_MS) {
    const remaining = COOLDOWN_MS - (Date.now() - cooldown.lastApplied);
    const days  = Math.floor(remaining / 86400000);
    const hours = Math.floor((remaining % 86400000) / 3600000);
    const str   = days > 0 ? `${days} day${days !== 1 ? 's' : ''}` : `${hours} hour${hours !== 1 ? 's' : ''}`;
    return interaction.reply({ content: `You already applied for **${app.name}** recently. You can apply again in **${str}**.`, flags: MessageFlags.Ephemeral });
  }

  // Pending check
  if (g.submissions.some((s) => s.userId === userId && s.applicationId === appId && s.status === 'pending'))
    return interaction.reply({ content: `You already have a pending application for **${app.name}**.`, flags: MessageFlags.Ephemeral });

  // Test DM
  let dmChannel;
  try {
    dmChannel = await interaction.user.createDM();
    await dmChannel.send(
      `📋 **${app.name}** — ${app.applyingFor}\nPlease answer the following questions. Take your time — you have **10 minutes** per question.`,
    );
  } catch {
    return interaction.reply({ content: "I couldn't DM you. Please open your DMs and try again.", flags: MessageFlags.Ephemeral });
  }

  await interaction.reply({ content: '📬 Check your DMs! I sent you the application questions.', flags: MessageFlags.Ephemeral });

  runApplicationFlow(interaction.client, interaction.guild, interaction.user, app, interaction.guildId, dmChannel)
    .catch((e) => console.error('[applications] flow error:', e?.message));
}

// ─── DM question flow ─────────────────────────────────────────────────────────

async function runApplicationFlow(client, guild, user, app, guildId, dmChannel) {
  const answers = [];

  for (let i = 0; i < app.questions.length; i++) {
    const q = app.questions[i];

    if (q.type === 'yes_no') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`app:ynbtn:yes:${i}`).setLabel('✅ Yes').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`app:ynbtn:no:${i}`).setLabel('❌ No').setStyle(ButtonStyle.Danger),
      );
      const qMsg = await dmChannel.send({ content: `**${i + 1}. ${q.text}**`, components: [row] });

      let answer;
      try {
        const btn = await qMsg.awaitMessageComponent({
          filter: (b) => b.user.id === user.id,
          time: Q_TIMEOUT,
          componentType: ComponentType.Button,
        });
        answer = btn.customId.includes(':yes:') ? 'Yes' : 'No';
        await btn.update({ content: `**${i + 1}. ${q.text}**\n> ${answer}`, components: [] });
      } catch {
        await dmChannel.send('⏰ Application timed out. You can restart it anytime.').catch(() => {});
        return;
      }
      answers.push({ question: q.text, type: q.type, answer });

    } else {
      await dmChannel.send(`**${i + 1}. ${q.text}**`);
      let answer;
      try {
        const collected = await dmChannel.awaitMessages({
          filter: (m) => m.author.id === user.id,
          max: 1, time: Q_TIMEOUT, errors: ['time'],
        });
        answer = collected.first().content.trim().slice(0, 1000);
      } catch {
        await dmChannel.send('⏰ Application timed out. You can restart it anytime.').catch(() => {});
        return;
      }
      answers.push({ question: q.text, type: q.type, answer });
    }
  }

  await dmChannel.send('✅ Your application has been submitted! You will be notified of the decision.');

  // Save submission
  const g            = adb.guild(guildId);
  const submissionId = adb.nextSubmissionId(guildId);
  const submission   = {
    submissionId, applicationId: app.id,
    userId: user.id, username: user.username, userTag: user.tag ?? user.username,
    answers, submittedAt: new Date().toISOString(),
    status: 'pending', reviewedBy: null, reviewedAt: null, reason: null, timeSpentMs: null,
    guildId, pendingMessageId: null, pendingChannelId: null,
  };
  g.submissions.push(submission);

  // Set cooldown
  const cIdx = g.cooldowns.findIndex((c) => c.userId === user.id && c.applicationId === app.id);
  if (cIdx >= 0) g.cooldowns[cIdx].lastApplied = Date.now();
  else g.cooldowns.push({ userId: user.id, applicationId: app.id, lastApplied: Date.now() });
  await adb.save();

  // Send to pending channel
  const guildDb = db.guild(guildId);
  if (!guildDb.application_pending_channel_id) return;

  const pendingCh = await client.channels.fetch(guildDb.application_pending_channel_id).catch(() => null);
  if (!pendingCh?.isTextBased()) return;

  const member = await guild.members.fetch(user.id).catch(() => null);
  const joinedStr = member?.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>` : '_Unknown_';

  const answerLines = answers.map((a, i) => `**${i + 1}. ${a.question}**\n${a.answer}`).join('\n\n');

  const pendingEmbed = new EmbedBuilder()
    .setColor(0xFAA61A)
    .setTitle(`📋 ${app.name}`)
    .setDescription(truncate(answerLines, DISCORD_LIMITS.EMBED_DESCRIPTION))
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'User',     value: `<@${user.id}>`,  inline: true },
      { name: 'Username', value: user.username,    inline: true },
      { name: 'Joined',   value: joinedStr,         inline: true },
      { name: 'User ID',  value: user.id,           inline: false },
    )
    .setFooter({ text: `Submission #${submissionId} • ${app.applyingFor}` })
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ID.ACCEPT    + submissionId).setLabel('✅ Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(ID.DENY      + submissionId).setLabel('❌ Deny').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(ID.ACCEPT_R  + submissionId).setLabel('✅ Accept with reason').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(ID.DENY_R    + submissionId).setLabel('❌ Deny with reason').setStyle(ButtonStyle.Secondary),
  );
  const ticketButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ID.OPEN_TKT  + submissionId).setLabel('🎫 Open Ticket').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ID.OPEN_ATKT + submissionId).setLabel('🔒 Open Admin Ticket').setStyle(ButtonStyle.Secondary),
  );

  const sent = await pendingCh.send({ embeds: [pendingEmbed], components: [buttons, ticketButtons] });

  const sub = g.submissions.find((s) => s.submissionId === submissionId);
  if (sub) { sub.pendingMessageId = sent.id; sub.pendingChannelId = pendingCh.id; }
  await adb.save();
}

// ─── Review flow ──────────────────────────────────────────────────────────────

async function onAcceptBtn(interaction) {
  return processReview(interaction, 'accepted', null);
}
async function onDenyBtn(interaction) {
  return processReview(interaction, 'denied', null);
}

async function onAcceptReasonBtn(interaction) {
  const sid   = interaction.customId.slice(ID.ACCEPT_R.length);
  const modal = new ModalBuilder().setCustomId(ID.R_ACCEPT + sid).setTitle('Accept — Add Reason');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500),
  ));
  return interaction.showModal(modal);
}

async function onDenyReasonBtn(interaction) {
  const sid   = interaction.customId.slice(ID.DENY_R.length);
  const modal = new ModalBuilder().setCustomId(ID.R_DENY + sid).setTitle('Deny — Add Reason');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('reason').setLabel('Reason').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500),
  ));
  return interaction.showModal(modal);
}

async function onReasonModal(interaction, decision) {
  const reason = interaction.fields.getTextInputValue('reason')?.trim() || null;
  return processReview(interaction, decision, reason);
}

async function processReview(interaction, decision, reason) {
  if (!checks.isStaff(interaction.member))
    return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });

  // Extract submissionId from customId
  let submissionId;
  if (interaction.isButton()) {
    const prefix = interaction.customId.startsWith(ID.ACCEPT_R) ? ID.ACCEPT_R
      : interaction.customId.startsWith(ID.DENY_R) ? ID.DENY_R
      : interaction.customId.startsWith(ID.ACCEPT) ? ID.ACCEPT : ID.DENY;
    submissionId = parseInt(interaction.customId.slice(prefix.length), 10);
  } else {
    const prefix = interaction.customId.startsWith(ID.R_ACCEPT) ? ID.R_ACCEPT : ID.R_DENY;
    submissionId = parseInt(interaction.customId.slice(prefix.length), 10);
  }

  const g   = adb.guild(interaction.guildId);
  const sub = g.submissions.find((s) => s.submissionId === submissionId);
  if (!sub)
    return interaction.reply({ content: 'Submission not found.', flags: MessageFlags.Ephemeral });
  if (sub.status !== 'pending')
    return interaction.reply({ content: 'This application has already been reviewed.', flags: MessageFlags.Ephemeral });

  sub.status      = decision;
  sub.reviewedBy  = interaction.user.username;
  sub.reviewedAt  = new Date().toISOString();
  sub.reason      = reason;
  sub.timeSpentMs = Date.now() - new Date(sub.submittedAt).getTime();
  await adb.save();

  const app     = g.applications[sub.applicationId];
  const guildDb = db.guild(interaction.guildId);
  const color   = decision === 'accepted' ? 0x57F287 : 0xED4245;
  const titlePfx = decision === 'accepted' ? '✅ Accepted' : '❌ Denied';

  const answerLines = sub.answers.map((a, i) => `**${i + 1}. ${a.question}**\n${a.answer}`).join('\n\n');

  const updatedEmbed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${titlePfx} — ${app?.name ?? sub.applicationId}`)
    .setDescription(truncate(answerLines, DISCORD_LIMITS.EMBED_DESCRIPTION))
    .addFields(
      { name: 'User',        value: `<@${sub.userId}>`,                   inline: true  },
      { name: 'Username',    value: sub.username,                          inline: true  },
      { name: 'User ID',     value: sub.userId,                            inline: true  },
      { name: 'Reviewed by', value: `<@${interaction.user.id}>`,          inline: true  },
      { name: 'Time spent',  value: fmtDuration(sub.timeSpentMs),          inline: true  },
      { name: 'Reason',      value: reason || '_No reason provided_',      inline: false },
    )
    .setFooter({ text: `Submission #${submissionId}` })
    .setTimestamp();

  // Delete pending message
  if (sub.pendingChannelId && sub.pendingMessageId) {
    const ch  = await interaction.client.channels.fetch(sub.pendingChannelId).catch(() => null);
    const msg = ch ? await ch.messages.fetch(sub.pendingMessageId).catch(() => null) : null;
    if (msg) await msg.delete().catch(() => {});
  }

  // Send to accepted/denied channel
  const targetId = decision === 'accepted'
    ? guildDb.application_accepted_channel_id
    : guildDb.application_denied_channel_id;
  if (targetId) {
    const targetCh = await interaction.client.channels.fetch(targetId).catch(() => null);
    if (targetCh?.isTextBased()) await targetCh.send({ embeds: [updatedEmbed] }).catch(() => {});
  }

  // DM applicant + give roles if accepted
  try {
    const applicant = await interaction.client.users.fetch(sub.userId).catch(() => null);
    if (applicant) {
      const dmEmbed = new EmbedBuilder()
        .setColor(color)
        .setTitle(decision === 'accepted' ? '✅ You got accepted!' : '❌ You got denied!')
        .setDescription(
          `You applied for **${app?.applyingFor ?? 'Unknown'}** in **${interaction.guild.name}**.\n\n` +
          `**Decision:** ${decision === 'accepted' ? 'Accepted' : 'Denied'}\n` +
          `**By:** ${interaction.user.username}\n` +
          `**Reason:** ${reason || 'No reason provided'}`,
        )
        .setTimestamp();
      await applicant.send({ embeds: [dmEmbed] }).catch(() => {});

      if (decision === 'accepted') {
        const member = await interaction.guild.members.fetch(sub.userId).catch(() => null);
        if (member) {
          if (guildDb.staff_role_id)  await member.roles.add(guildDb.staff_role_id,    'Application accepted — staff role').catch(() => {});
          if (app?.roleOnAccept && app.roleOnAccept !== guildDb.staff_role_id)
            await member.roles.add(app.roleOnAccept, 'Application accepted').catch(() => {});
        }
      }
    }
  } catch { /* ignore */ }

  // Reply to reviewer
  if (interaction.isModalSubmit()) {
    return interaction.reply({ content: `${decision === 'accepted' ? '✅ Accepted' : '❌ Denied'}.`, flags: MessageFlags.Ephemeral });
  }
  return interaction.update({ embeds: [updatedEmbed], components: [] });
}

// ─── /application info — overview ────────────────────────────────────────────

async function handleInfo(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const g       = adb.guild(interaction.guildId);
  const guildDb = db.guild(interaction.guildId);
  const apps    = Object.values(g.applications);
  const d       = g.panelDescription;

  const chLines = [
    `**Pending:**  ${guildDb.application_pending_channel_id  ? `<#${guildDb.application_pending_channel_id}>`  : '_Not set_'}`,
    `**Accepted:** ${guildDb.application_accepted_channel_id ? `<#${guildDb.application_accepted_channel_id}>` : '_Not set_'}`,
    `**Denied:**   ${guildDb.application_denied_channel_id   ? `<#${guildDb.application_denied_channel_id}>`   : '_Not set_'}`,
  ];

  const descVal = (d.title || d.subtitle || d.description)
    ? [
        d.title       ? `**Title:** ${truncate(d.title, 80)}`       : null,
        d.subtitle    ? `**Subtitle:** ${truncate(d.subtitle, 80)}` : null,
        d.description ? `**Body:** ${truncate(d.description, 150)}` : null,
        d.footer      ? `**Footer:** ${truncate(d.footer, 80)}`     : null,
      ].filter(Boolean).join('\n')
    : '_Not set — use `/application description`_';

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📋 Application System — Overview')
    .addFields(
      { name: '📥 Channels',          value: chLines.join('\n'), inline: false },
      { name: '📝 Panel Description', value: descVal,           inline: false },
    )
    .setTimestamp();

  if (!apps.length) {
    embed.addFields({ name: '📋 Applications', value: '_None yet — use `/application setup`_', inline: false });
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  const appLines = apps.map((a) =>
    `${a.draft ? '⚠️' : '✅'} **${a.name}** (\`${a.id}\`) — for: ${a.applyingFor} · ${a.questions.length} question${a.questions.length !== 1 ? 's' : ''}`,
  );
  embed.addFields({ name: `📋 Applications (${apps.length})`, value: truncate(appLines.join('\n'), DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false });

  const options = apps.slice(0, 25).map((a) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(truncate((a.draft ? '⚠️ ' : '') + a.name, 90))
      .setValue(a.id)
      .setDescription(truncate(`${a.applyingFor} · ${a.questions.length} question${a.questions.length !== 1 ? 's' : ''}`, 90)),
  );

  return interaction.reply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(ID.INFO_SEL)
        .setPlaceholder('Select an application to manage...')
        .setMinValues(1).setMaxValues(1)
        .addOptions(options),
    )],
    flags: MessageFlags.Ephemeral,
  });
}

// ─── App detail view (shared helper) ─────────────────────────────────────────

function buildAppDetailEmbed(app) {
  const qLines = app.questions.length
    ? app.questions.map((q, i) => `**${i + 1}.** [${q.type === 'yes_no' ? 'Yes/No' : 'Text'}] ${q.text}`)
    : ['_No questions yet._'];
  return new EmbedBuilder()
    .setColor(app.draft ? 0xFAA61A : 0x57F287)
    .setTitle(`📋 ${app.name}`)
    .addFields(
      { name: 'Applying For',   value: app.applyingFor,                                         inline: true  },
      { name: 'Status',         value: app.draft ? '⚠️ Draft' : '✅ Ready',                      inline: true  },
      { name: 'ID',             value: `\`${app.id}\``,                                         inline: true  },
      { name: 'Role on Accept', value: app.roleOnAccept ? `<@&${app.roleOnAccept}>` : '_None_', inline: true  },
      { name: `Questions (${app.questions.length})`, value: truncate(qLines.join('\n'), DISCORD_LIMITS.EMBED_FIELD_VALUE), inline: false },
    )
    .setFooter({ text: 'Use the buttons below to edit this application' })
    .setTimestamp();
}

function buildAppDetailComponents(appId, hasQuestions) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(ID.EDIT_DET + appId).setLabel('✏️ Edit Details').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(ID.IAYN     + appId).setLabel('➕ Yes/No Q').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(ID.IATXT    + appId).setLabel('➕ Text Q').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(ID.RMQ_BTN  + appId).setLabel('➖ Remove Q').setStyle(ButtonStyle.Secondary).setDisabled(!hasQuestions),
      new ButtonBuilder().setCustomId(ID.DEL_BTN  + appId).setLabel('🗑️ Delete').setStyle(ButtonStyle.Danger),
    ),
  ];
}

async function showAppDetail(interaction, appId) {
  const g   = adb.guild(interaction.guildId);
  const app = g.applications[appId];
  if (!app) return interaction.update({ content: 'Application not found.', embeds: [], components: [] });
  return interaction.update({ content: '', embeds: [buildAppDetailEmbed(app)], components: buildAppDetailComponents(appId, app.questions.length > 0) });
}

async function onInfoAppSelect(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });
  return showAppDetail(interaction, interaction.values[0]);
}

// ─── Edit details ─────────────────────────────────────────────────────────────

async function onEditDetailsBtn(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const appId = interaction.customId.slice(ID.EDIT_DET.length);
  const app   = adb.guild(interaction.guildId).applications[appId];
  if (!app) return interaction.reply({ content: 'Application not found.', flags: MessageFlags.Ephemeral });

  const modal = new ModalBuilder().setCustomId(ID.EDIT_DET_M + appId).setTitle('Edit Application');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('name').setLabel('Application Name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(app.name),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('for').setLabel('Applying For').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(app.applyingFor),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('role_id').setLabel('Role ID on accept (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(30).setValue(app.roleOnAccept || ''),
    ),
  );
  return interaction.showModal(modal);
}

async function onEditDetailsModal(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const appId = interaction.customId.slice(ID.EDIT_DET_M.length);
  const g     = adb.guild(interaction.guildId);
  const app   = g.applications[appId];
  if (!app) return interaction.reply({ content: 'Application not found.', flags: MessageFlags.Ephemeral });

  app.name         = interaction.fields.getTextInputValue('name').trim();
  app.applyingFor  = interaction.fields.getTextInputValue('for').trim();
  app.roleOnAccept = interaction.fields.getTextInputValue('role_id')?.trim() || null;
  await adb.save();

  return interaction.update({ content: '', embeds: [buildAppDetailEmbed(app)], components: buildAppDetailComponents(appId, app.questions.length > 0) });
}

// ─── Info-context add question ────────────────────────────────────────────────

async function onInfoAddQuestionBtn(interaction, type) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const appId   = interaction.customId.slice((type === 'yes_no' ? ID.IAYN : ID.IATXT).length);
  const modalId = (type === 'yes_no' ? ID.IAYN_M : ID.IATXT_M) + appId;

  const modal = new ModalBuilder().setCustomId(modalId).setTitle('Add Question');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('question')
      .setLabel(type === 'yes_no' ? 'Yes/No question text' : 'Text question text')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true).setMaxLength(300),
  ));
  return interaction.showModal(modal);
}

async function onInfoQuestionModal(interaction, type) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const prefix = type === 'yes_no' ? ID.IAYN_M : ID.IATXT_M;
  const appId  = interaction.customId.slice(prefix.length);
  const text   = interaction.fields.getTextInputValue('question').trim();

  const g   = adb.guild(interaction.guildId);
  const app = g.applications[appId];
  if (!app) return interaction.reply({ content: 'Application not found.', flags: MessageFlags.Ephemeral });

  app.questions.push({ text, type });
  await adb.save();

  return interaction.update({ content: '', embeds: [buildAppDetailEmbed(app)], components: buildAppDetailComponents(appId, true) });
}

// ─── Remove question ──────────────────────────────────────────────────────────

async function onRemoveQBtn(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const appId = interaction.customId.slice(ID.RMQ_BTN.length);
  const app   = adb.guild(interaction.guildId).applications[appId];
  if (!app?.questions.length) return interaction.reply({ content: 'No questions to remove.', flags: MessageFlags.Ephemeral });

  const options = app.questions.map((q, i) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(truncate(`${i + 1}. ${q.text}`, 90))
      .setValue(String(i))
      .setDescription(q.type === 'yes_no' ? 'Yes/No' : 'Text'),
  );

  return interaction.update({
    content: '**Select a question to remove:**',
    embeds: [],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(ID.RMQ_SEL + appId)
          .setPlaceholder('Select question to remove...')
          .setMinValues(1).setMaxValues(1)
          .addOptions(options),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(ID.BACK + appId).setLabel('← Cancel').setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function onRemoveQSelect(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const appId = interaction.customId.slice(ID.RMQ_SEL.length);
  const idx   = parseInt(interaction.values[0], 10);
  const g     = adb.guild(interaction.guildId);
  const app   = g.applications[appId];
  if (!app) return interaction.update({ content: 'Application not found.', embeds: [], components: [] });

  app.questions.splice(idx, 1);
  await adb.save();

  return interaction.update({ content: '', embeds: [buildAppDetailEmbed(app)], components: buildAppDetailComponents(appId, app.questions.length > 0) });
}

// ─── Delete application ───────────────────────────────────────────────────────

async function onDeleteBtn(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const appId = interaction.customId.slice(ID.DEL_BTN.length);
  const app   = adb.guild(interaction.guildId).applications[appId];
  if (!app) return interaction.update({ content: 'Application not found.', embeds: [], components: [] });

  return interaction.update({
    content: `⚠️ Are you sure you want to delete **${app.name}**? This cannot be undone.`,
    embeds: [],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(ID.DEL_CONF + appId).setLabel('🗑️ Yes, delete').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(ID.BACK + appId).setLabel('← Cancel').setStyle(ButtonStyle.Secondary),
    )],
  });
}

async function onDeleteConfirmBtn(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const appId = interaction.customId.slice(ID.DEL_CONF.length);
  const g     = adb.guild(interaction.guildId);
  const name  = g.applications[appId]?.name ?? appId;
  delete g.applications[appId];
  await adb.save();

  return interaction.update({ content: `🗑️ **${name}** has been deleted.`, embeds: [], components: [] });
}

async function onBackBtn(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });
  return showAppDetail(interaction, interaction.customId.slice(ID.BACK.length));
}

// ─── Open ticket from application ────────────────────────────────────────────

async function onOpenTicketBtn(interaction, adminOnly) {
  if (!checks.isStaff(interaction.member))
    return interaction.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });

  const prefix = adminOnly ? ID.OPEN_ATKT : ID.OPEN_TKT;
  const sid    = parseInt(interaction.customId.slice(prefix.length), 10);
  const g      = adb.guild(interaction.guildId);
  const sub    = g.submissions.find((s) => s.submissionId === sid);

  if (!sub)
    return interaction.reply({ content: 'Submission not found.', flags: MessageFlags.Ephemeral });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let targetUser;
  try { targetUser = await interaction.client.users.fetch(sub.userId); }
  catch { return interaction.editReply({ content: 'Could not find that user.' }); }

  const channel = await tickets.createLinkedTicket(
    interaction.client, interaction.guild, targetUser, interaction.member, adminOnly, interaction.guildId,
  );

  if (!channel)
    return interaction.editReply({ content: 'Failed to create ticket channel. Check bot permissions and category setup.' });

  return interaction.editReply({ content: `✅ ${adminOnly ? 'Admin ticket' : 'Ticket'} created: ${channel}.` });
}

// ─── Register ─────────────────────────────────────────────────────────────────

function register(client) {
  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.inGuild()) return;

      if (interaction.isChatInputCommand() && interaction.commandName === 'application') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'setup')       return await handleSetup(interaction);
        if (sub === 'description') return await handleDescription(interaction);
        if (sub === 'group')       return await handleGroup(interaction);
        if (sub === 'pending')     return await handleChannel(interaction, 'pending');
        if (sub === 'accepted')    return await handleChannel(interaction, 'accepted');
        if (sub === 'denied')      return await handleChannel(interaction, 'denied');
        if (sub === 'info')        return await handleInfo(interaction);
      }

      if (interaction.isModalSubmit()) {
        const id = interaction.customId;
        if (id === ID.SETUP_MODAL)            return await onSetupModal(interaction);
        if (id === ID.DESC_MODAL)             return await onDescriptionModal(interaction);
        if (id.startsWith(ID.YN_MODAL))       return await onQuestionModal(interaction, 'yes_no');
        if (id.startsWith(ID.TXT_MODAL))      return await onQuestionModal(interaction, 'text');
        if (id.startsWith(ID.R_ACCEPT))       return await onReasonModal(interaction, 'accepted');
        if (id.startsWith(ID.R_DENY))         return await onReasonModal(interaction, 'denied');
        if (id.startsWith(ID.EDIT_DET_M))     return await onEditDetailsModal(interaction);
        if (id.startsWith(ID.IAYN_M))         return await onInfoQuestionModal(interaction, 'yes_no');
        if (id.startsWith(ID.IATXT_M))        return await onInfoQuestionModal(interaction, 'text');
      }

      if (interaction.isButton()) {
        const id = interaction.customId;
        if (id.startsWith(ID.ADD_YN))         return await onAddQuestionBtn(interaction, 'yes_no');
        if (id.startsWith(ID.ADD_TXT))        return await onAddQuestionBtn(interaction, 'text');
        if (id.startsWith(ID.DONE))           return await onDoneBtn(interaction);
        if (id.startsWith(ID.ACCEPT_R))       return await onAcceptReasonBtn(interaction);
        if (id.startsWith(ID.DENY_R))         return await onDenyReasonBtn(interaction);
        if (id.startsWith(ID.ACCEPT))         return await onAcceptBtn(interaction);
        if (id.startsWith(ID.DENY))           return await onDenyBtn(interaction);
        if (id.startsWith(ID.EDIT_DET))       return await onEditDetailsBtn(interaction);
        if (id.startsWith(ID.IAYN))           return await onInfoAddQuestionBtn(interaction, 'yes_no');
        if (id.startsWith(ID.IATXT))          return await onInfoAddQuestionBtn(interaction, 'text');
        if (id.startsWith(ID.RMQ_BTN))        return await onRemoveQBtn(interaction);
        if (id.startsWith(ID.DEL_CONF))       return await onDeleteConfirmBtn(interaction);
        if (id.startsWith(ID.DEL_BTN))        return await onDeleteBtn(interaction);
        if (id.startsWith(ID.BACK))           return await onBackBtn(interaction);
        if (id.startsWith(ID.OPEN_ATKT))      return await onOpenTicketBtn(interaction, true);
        if (id.startsWith(ID.OPEN_TKT))       return await onOpenTicketBtn(interaction, false);
      }

      if (interaction.isStringSelectMenu()) {
        const id = interaction.customId;
        if (id === ID.GROUP_SELECT)           return await onGroupSelect(interaction);
        if (id === ID.APPLY_SELECT)           return await onApplySelect(interaction);
        if (id === ID.INFO_SEL)               return await onInfoAppSelect(interaction);
        if (id.startsWith(ID.RMQ_SEL))        return await onRemoveQSelect(interaction);
      }
    } catch (err) {
      console.error('[applications] error:', err);
      const opts = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(opts);
        else if (interaction.isRepliable?.()) await interaction.reply(opts);
      } catch { /* swallow */ }
    }
  });
}

module.exports = { commands: [command], register };
