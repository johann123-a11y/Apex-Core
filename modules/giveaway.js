'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

const checks = require('../lib/checks');
const gdb    = require('../lib/giveaway-db');

const C_ACTIVE = 0xFEE75C;
const C_ENDED  = 0x95A5A6;

const JOIN_ID       = 'apex:gw_join';
const LEAVE_PREFIX  = 'apex:gw_leave:';

// ──── Duration parser ────
// Accepts: 10m 2h 7d 2weeks 1month 8months  (max 8 months = 8 × 30 days)

const UNIT_MS = {
  s: 1e3,       sec: 1e3,     secs: 1e3,     second: 1e3,   seconds: 1e3,
  m: 6e4,       min: 6e4,     mins: 6e4,     minute: 6e4,   minutes: 6e4,
  h: 36e5,      hr: 36e5,     hrs: 36e5,     hour: 36e5,    hours: 36e5,
  d: 864e5,     day: 864e5,   days: 864e5,
  w: 6048e5,    week: 6048e5, weeks: 6048e5,
  month: 2592e6, months: 2592e6,
};
const MAX_MS = 8 * 2592e6;

function parseDuration(str) {
  const s = str.trim().toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^(\d+)(months?|weeks?|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[mhdws])$/);
  if (!m) return null;
  const n  = parseInt(m[1], 10);
  const ms = (UNIT_MS[m[2]] || 0) * n;
  if (!ms || ms <= 0 || ms > MAX_MS) return null;
  return ms;
}

// ──── Embed builders ────

function buildActiveEmbed(g) {
  const lines = [];
  if (g.description) { lines.push(g.description); lines.push(''); }
  lines.push('Click the button below to enter!');
  lines.push('');
  lines.push(`**Winners:** ${g.winnersCount}`);
  lines.push(`**Entries:** ${g.entries.length}`);
  lines.push(`**Hosted by:** <@${g.hostedBy}>`);
  lines.push(`**Ends:** <t:${Math.floor(g.endsAt / 1000)}:R>`);
  lines.push('');
  lines.push(`<t:${Math.floor(g.endsAt / 1000)}:F>`);

  return new EmbedBuilder()
    .setColor(C_ACTIVE)
    .setTitle(`🎉 GIVEAWAY — ${g.prize}`)
    .setDescription(lines.join('\n'));
}

function buildEndedEmbed(g) {
  const lines = [];
  if (g.description) { lines.push(g.description); lines.push(''); }
  lines.push(`**Winners:** ${g.winnersCount}`);
  lines.push(`**Entries:** ${g.entries.length}`);
  lines.push(`**Hosted by:** <@${g.hostedBy}>`);
  lines.push('**Status:** Ended');
  lines.push('');
  if (g.winners?.length) {
    lines.push(`**Winner(s):** ${g.winners.map((id) => `<@${id}>`).join(', ')}`);
  } else {
    lines.push('**Winner(s):** No winners (no entries)');
  }

  return new EmbedBuilder()
    .setColor(C_ENDED)
    .setTitle(`🎉 GIVEAWAY — ${g.prize}`)
    .setDescription(lines.join('\n'));
}

function joinRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(JOIN_ID)
      .setLabel('🎉 Join Giveaway')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}

// ──── Random winner picker (Fisher-Yates) ────

function pickWinners(entries, count) {
  const pool = [...entries];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}

// ──── Core: end a giveaway ────

async function endGiveaway(client, messageId) {
  const g = gdb.get(messageId);
  if (!g || g.status === 'ended') return;

  g.status  = 'ended';
  g.winners = pickWinners(g.entries, g.winnersCount);
  await gdb.save();

  // Update embed + disable button
  try {
    const channel = await client.channels.fetch(g.channelId).catch(() => null);
    if (channel) {
      const msg = await channel.messages.fetch(messageId).catch(() => null);
      if (msg) await msg.edit({ embeds: [buildEndedEmbed(g)], components: [joinRow(true)] });
    }
  } catch (e) {
    console.error('[giveaway] embed update failed:', e?.message);
  }

  // Announce
  try {
    const channel = await client.channels.fetch(g.channelId).catch(() => null);
    if (!channel) return;
    if (!g.winners.length) {
      await channel.send({ content: 'No valid entries. No winners were drawn.' });
    } else {
      const mentions = g.winners.map((id) => `<@${id}>`).join(', ');
      await channel.send({
        content: `🎉 Congratulations ${mentions}! You won **${g.prize}**!`,
        allowedMentions: { users: g.winners },
      });
    }
  } catch (e) {
    console.error('[giveaway] announcement failed:', e?.message);
  }
}

// ──── Timer scheduling (handles delays > setTimeout max ~24.8 days) ────

const MAX_TIMER = 2_147_483_647;

function scheduleGiveaway(client, giveaway) {
  const delay = giveaway.endsAt - Date.now();
  if (delay <= 0) {
    endGiveaway(client, giveaway.id).catch(console.error);
    return;
  }
  if (delay > MAX_TIMER) {
    setTimeout(() => scheduleGiveaway(client, giveaway), MAX_TIMER);
    return;
  }
  setTimeout(() => endGiveaway(client, giveaway.id).catch(console.error), delay);
}

// ──── Commands ────

const gcreateCommand = new SlashCommandBuilder()
  .setName('gcreate')
  .setDescription('Create a giveaway in this channel')
  .setDefaultMemberPermissions(0n)
  .setDMPermission(false)
  .addStringOption((o) => o.setName('prize').setDescription('What is being given away').setRequired(true).setMaxLength(256))
  .addIntegerOption((o) => o.setName('winners').setDescription('Number of winners').setRequired(true).setMinValue(1).setMaxValue(20))
  .addStringOption((o) => o.setName('duration').setDescription('How long (e.g. 10m, 2h, 7d, 1month)').setRequired(true).setMaxLength(20))
  .addStringOption((o) => o.setName('description').setDescription('Optional description').setRequired(false).setMaxLength(1000));

const giveawayCommand = new SlashCommandBuilder()
  .setName('giveaway')
  .setDescription('Manage giveaways')
  .setDefaultMemberPermissions(0n)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s.setName('end').setDescription('End a giveaway immediately')
      .addStringOption((o) => o.setName('giveaway_id').setDescription('Message ID of the giveaway').setRequired(true).setMaxLength(25)),
  )
  .addSubcommand((s) =>
    s.setName('reroll').setDescription('Reroll winners of an ended giveaway')
      .addStringOption((o) => o.setName('giveaway_id').setDescription('Message ID of the giveaway').setRequired(true).setMaxLength(25)),
  );

// ──── /gcreate handler ────

async function handleGCreate(interaction) {
  if (!checks.isStaff(interaction.member)) {
    return interaction.reply({ content: 'Only staff can create giveaways.', flags: MessageFlags.Ephemeral });
  }

  const prize        = interaction.options.getString('prize', true).trim();
  const winnersCount = interaction.options.getInteger('winners', true);
  const durationStr  = interaction.options.getString('duration', true).trim();
  const description  = interaction.options.getString('description')?.trim() || null;

  const durationMs = parseDuration(durationStr);
  if (!durationMs) {
    return interaction.reply({
      content: 'Invalid duration. Examples: `10m`, `2h`, `7d`, `2weeks`, `1month`, `8months`. Max is 8 months.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const endsAt = Date.now() + durationMs;
  const tempG  = { prize, description, winnersCount, hostedBy: interaction.user.id, endsAt, entries: [] };

  let msg;
  try {
    msg = await interaction.channel.send({ embeds: [buildActiveEmbed(tempG)], components: [joinRow()] });
  } catch (e) {
    return interaction.editReply({ content: `Failed to send giveaway: ${e?.message}` });
  }

  const giveaway = {
    id:           msg.id,
    channelId:    interaction.channel.id,
    guildId:      interaction.guildId,
    prize,
    description,
    winnersCount,
    hostedBy:     interaction.user.id,
    endsAt,
    entries:      [],
    status:       'active',
    winners:      null,
  };

  gdb.set(msg.id, giveaway);
  await gdb.save();
  scheduleGiveaway(interaction.client, giveaway);

  await interaction.editReply({
    content: `Giveaway created! → https://discord.com/channels/${interaction.guildId}/${interaction.channel.id}/${msg.id}`,
  });
}

// ──── /giveaway end handler ────

async function handleGiveawayEnd(interaction) {
  if (!checks.isStaff(interaction.member)) {
    return interaction.reply({ content: 'Only staff can end giveaways.', flags: MessageFlags.Ephemeral });
  }

  const messageId = interaction.options.getString('giveaway_id', true).trim();
  const g = gdb.get(messageId);

  if (!g || g.guildId !== interaction.guildId) {
    return interaction.reply({ content: `No giveaway found with ID \`${messageId}\`.`, flags: MessageFlags.Ephemeral });
  }
  if (g.status === 'ended') {
    return interaction.reply({ content: 'This giveaway has already ended.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await endGiveaway(interaction.client, messageId);
  await interaction.editReply({ content: 'Giveaway ended.' });
}

// ──── /giveaway reroll handler ────

async function handleGiveawayReroll(interaction) {
  if (!checks.isStaff(interaction.member)) {
    return interaction.reply({ content: 'Only staff can reroll giveaways.', flags: MessageFlags.Ephemeral });
  }

  const messageId = interaction.options.getString('giveaway_id', true).trim();
  const g = gdb.get(messageId);

  if (!g || g.guildId !== interaction.guildId) {
    return interaction.reply({ content: `No giveaway found with ID \`${messageId}\`.`, flags: MessageFlags.Ephemeral });
  }
  if (g.status !== 'ended') {
    return interaction.reply({ content: 'This giveaway has not ended yet. Use `/giveaway end` first.', flags: MessageFlags.Ephemeral });
  }
  if (!g.entries.length) {
    return interaction.reply({ content: 'No entries — cannot reroll.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const newWinners = pickWinners(g.entries, g.winnersCount);
  g.winners = newWinners;
  await gdb.save();

  try {
    const channel = await interaction.client.channels.fetch(g.channelId).catch(() => null);
    if (channel) {
      const mentions = newWinners.map((id) => `<@${id}>`).join(', ');
      await channel.send({
        content: `🔁 New winner(s) by reroll: ${mentions}! Congratulations!`,
        allowedMentions: { users: newWinners },
      });
    }
  } catch (e) {
    return interaction.editReply({ content: `Reroll done but failed to announce: ${e?.message}` });
  }

  await interaction.editReply({ content: 'Reroll complete!' });
}

// ──── Button: Join ────

async function onJoinClick(interaction) {
  const messageId = interaction.message.id;
  const g = gdb.get(messageId);

  if (!g || g.status === 'ended') {
    return interaction.reply({ content: 'This giveaway has already ended.', flags: MessageFlags.Ephemeral });
  }

  const guildDb = require('../lib/db').guild(interaction.guildId);
  if (guildDb.global_blacklist?.includes(interaction.user.id))
    return interaction.reply({ content: 'You are not allowed to join giveaways.', flags: MessageFlags.Ephemeral });

  const leaveRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${LEAVE_PREFIX}${messageId}`)
      .setLabel('Leave Giveaway')
      .setStyle(ButtonStyle.Danger),
  );

  const alreadyIn = g.entries.includes(interaction.user.id);

  if (!alreadyIn) {
    g.entries.push(interaction.user.id);
    await gdb.save();

    try {
      await interaction.message.edit({ embeds: [buildActiveEmbed(g)], components: [joinRow()] });
    } catch (e) {
      console.error('[giveaway] entry count update failed:', e?.message);
    }

    return interaction.reply({
      content: 'You joined the giveaway. Do you want to leave the Giveaway?',
      components: [leaveRow],
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: 'You already joined this Giveaway. Do you want to leave?',
    components: [leaveRow],
    flags: MessageFlags.Ephemeral,
  });
}

// ──── Button: Leave ────

async function onLeaveClick(interaction) {
  const messageId = interaction.customId.slice(LEAVE_PREFIX.length);
  const g = gdb.get(messageId);

  if (!g) {
    return interaction.update({ content: 'This giveaway no longer exists.', components: [] });
  }

  const idx = g.entries.indexOf(interaction.user.id);
  if (idx >= 0) {
    g.entries.splice(idx, 1);
    await gdb.save();

    if (g.status === 'active') {
      try {
        const channel = await interaction.client.channels.fetch(g.channelId).catch(() => null);
        if (channel) {
          const msg = await channel.messages.fetch(messageId).catch(() => null);
          if (msg) await msg.edit({ embeds: [buildActiveEmbed(g)], components: [joinRow()] });
        }
      } catch (e) {
        console.error('[giveaway] leave embed update failed:', e?.message);
      }
    }
  }

  return interaction.update({ content: 'You have left the giveaway.', components: [] });
}

// ──── Register ────

function register(client) {
  // Restore timers for active giveaways after login
  client.once('ready', () => {
    let restored = 0;
    for (const g of Object.values(gdb.all())) {
      if (g.status === 'active') {
        scheduleGiveaway(client, g);
        restored++;
      }
    }
    console.log(`[giveaway] restored ${restored} active timer(s)`);
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.inGuild()) return;

      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'gcreate') return await handleGCreate(interaction);
        if (interaction.commandName === 'giveaway') {
          const sub = interaction.options.getSubcommand();
          if (sub === 'end')    return await handleGiveawayEnd(interaction);
          if (sub === 'reroll') return await handleGiveawayReroll(interaction);
        }
      }

      if (interaction.isButton()) {
        if (interaction.customId === JOIN_ID)                   return await onJoinClick(interaction);
        if (interaction.customId.startsWith(LEAVE_PREFIX))     return await onLeaveClick(interaction);
      }
    } catch (err) {
      console.error('[giveaway] error:', err);
      const opts = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(opts);
        else if (interaction.isRepliable?.()) await interaction.reply(opts);
      } catch { /* swallow */ }
    }
  });
}

module.exports = {
  commands: [gcreateCommand, giveawayCommand],
  register,
};
