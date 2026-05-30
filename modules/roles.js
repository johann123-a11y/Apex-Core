'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const db = require('../lib/db');
const checks = require('../lib/checks');

// ──── /role all ────

const roleAllCommand = new SlashCommandBuilder()
  .setName('role')
  .setDescription('Role management')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s.setName('all').setDescription('Give a role to every current member in the server')
      .addRoleOption((o) => o.setName('role').setDescription('Role to assign').setRequired(true)),
  );

async function handleRoleAll(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const role = interaction.options.getRole('role', true);

  if (role.managed || role.id === interaction.guild.id)
    return interaction.reply({ content: 'That role cannot be assigned manually.', flags: MessageFlags.Ephemeral });

  if (role.position >= interaction.guild.members.me.roles.highest.position)
    return interaction.reply({ content: 'That role is higher than or equal to my highest role. Move my role above it first.', flags: MessageFlags.Ephemeral });

  await interaction.reply({ content: `⏳ Assigning **${role.name}** to all members… this may take a while.`, flags: MessageFlags.Ephemeral });

  // Fetch all members
  let members;
  try {
    members = await interaction.guild.members.fetch();
  } catch (e) {
    return interaction.editReply({ content: `Failed to fetch members: ${e?.message}` });
  }

  const targets = members.filter((m) => !m.user.bot && !m.roles.cache.has(role.id));

  let success = 0;
  let failed = 0;

  for (const [, member] of targets) {
    try {
      await member.roles.add(role, `/role all by ${interaction.user.username}`);
      success++;
    } catch {
      failed++;
    }
  }

  await interaction.editReply({
    content: `✅ Done. **${success}** member(s) received **${role.name}**.${failed ? `\n⚠️ Failed for **${failed}** member(s) (missing permissions or hierarchy issue).` : ''}`,
  });
}

// ──── /autorole ────

const autoRoleCommand = new SlashCommandBuilder()
  .setName('autorole')
  .setDescription('Manage the auto-role assigned to new members')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s.setName('set').setDescription('Set the role new members automatically receive')
      .addRoleOption((o) => o.setName('role').setDescription('Role to auto-assign').setRequired(true)),
  )
  .addSubcommand((s) => s.setName('remove').setDescription('Remove the auto-role'))
  .addSubcommand((s) => s.setName('info').setDescription('Show the current auto-role'));

async function handleAutoRoleSet(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const role = interaction.options.getRole('role', true);

  if (role.managed || role.id === interaction.guild.id)
    return interaction.reply({ content: 'That role cannot be assigned automatically.', flags: MessageFlags.Ephemeral });

  if (role.position >= interaction.guild.members.me.roles.highest.position)
    return interaction.reply({ content: 'That role is higher than or equal to my highest role. Move my role above it first.', flags: MessageFlags.Ephemeral });

  const g = db.guild(interaction.guildId);
  g.autorole_id = role.id;
  await db.save();

  return interaction.reply({ content: `✅ Auto-role set to ${role}. All new members will receive it on join.`, flags: MessageFlags.Ephemeral });
}

async function handleAutoRoleRemove(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const g = db.guild(interaction.guildId);
  g.autorole_id = null;
  await db.save();

  return interaction.reply({ content: '✅ Auto-role removed. New members will no longer receive a role automatically.', flags: MessageFlags.Ephemeral });
}

async function handleAutoRoleInfo(interaction) {
  if (!checks.isAdmin(interaction.member))
    return interaction.reply({ content: 'Admins only.', flags: MessageFlags.Ephemeral });

  const g = db.guild(interaction.guildId);
  const roleId = g.autorole_id;

  if (!roleId)
    return interaction.reply({ content: 'No auto-role is currently set. Use `/autorole set` to configure one.', flags: MessageFlags.Ephemeral });

  const role = interaction.guild.roles.cache.get(roleId);
  return interaction.reply({
    content: role ? `Current auto-role: ${role}` : `Configured role ID \`${roleId}\` no longer exists. Use \`/autorole set\` to update it.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function onMemberJoin(member) {
  const g = db.guild(member.guild.id);
  if (!g.autorole_id) return;

  const role = member.guild.roles.cache.get(g.autorole_id);
  if (!role) return;

  try {
    await member.roles.add(role, 'Auto-role on join');
  } catch (e) {
    console.error('[autorole] failed to assign role:', e?.message);
  }
}

// ──── Register ────

function register(client) {
  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.inGuild() || !interaction.isChatInputCommand()) return;
      const sub = interaction.options.getSubcommand(false);

      if (interaction.commandName === 'role') {
        if (sub === 'all') return await handleRoleAll(interaction);
      }

      if (interaction.commandName === 'autorole') {
        if (sub === 'set')    return await handleAutoRoleSet(interaction);
        if (sub === 'remove') return await handleAutoRoleRemove(interaction);
        if (sub === 'info')   return await handleAutoRoleInfo(interaction);
      }
    } catch (err) {
      console.error('[roles] error:', err);
      const opts = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(opts);
        else await interaction.reply(opts);
      } catch { /* swallow */ }
    }
  });

  client.on('guildMemberAdd', (member) => onMemberJoin(member).catch((e) => console.error('[autorole:join]', e?.message)));
}

module.exports = { commands: [roleAllCommand, autoRoleCommand], register };
