'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const db = require('../lib/db');
const checks = require('../lib/checks');

const staffCommand = new SlashCommandBuilder()
  .setName('staff')
  .setDescription('Manage staff role used by Apex Core')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommandGroup((group) =>
    group
      .setName('role')
      .setDescription('Staff role management')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Set the staff role (can execute all staff-only ticket commands)')
          .addRoleOption((o) => o.setName('role').setDescription('Role to use as staff').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('show').setDescription('Show the current staff role'))
      .addSubcommand((sub) => sub.setName('clear').setDescription('Remove the staff role')),
  );

async function handleSet(interaction) {
  const role = interaction.options.getRole('role', true);
  // Permission gate: only admins. defaultMemberPermissions already enforces this, but check again.
  if (!checks.isAdmin(interaction.member)) {
    return interaction.reply({ content: 'Only administrators can set the staff role.', flags: MessageFlags.Ephemeral });
  }
  const g = db.guild(interaction.guildId);
  g.staff_role_id = role.id;
  await db.save();
  return interaction.reply({ content: `Staff role set to ${role}.`, flags: MessageFlags.Ephemeral });
}

async function handleShow(interaction) {
  const g = db.guild(interaction.guildId);
  if (!g.staff_role_id) {
    return interaction.reply({ content: 'No staff role configured.', flags: MessageFlags.Ephemeral });
  }
  const role = interaction.guild.roles.cache.get(g.staff_role_id);
  return interaction.reply({
    content: role ? `Current staff role: ${role}` : `Configured role ID \`${g.staff_role_id}\` no longer exists.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleClear(interaction) {
  if (!checks.isAdmin(interaction.member)) {
    return interaction.reply({ content: 'Only administrators can clear the staff role.', flags: MessageFlags.Ephemeral });
  }
  const g = db.guild(interaction.guildId);
  g.staff_role_id = null;
  await db.save();
  return interaction.reply({ content: 'Staff role cleared.', flags: MessageFlags.Ephemeral });
}

function register(client) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'staff') return;
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'Guild-only command.', flags: MessageFlags.Ephemeral });
    }
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    try {
      if (group === 'role' && sub === 'set') return await handleSet(interaction);
      if (group === 'role' && sub === 'show') return await handleShow(interaction);
      if (group === 'role' && sub === 'clear') return await handleClear(interaction);
    } catch (err) {
      console.error('[staff] error:', err);
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });
}

module.exports = {
  commands: [staffCommand],
  register,
};
