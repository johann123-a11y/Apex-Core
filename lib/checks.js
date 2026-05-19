'use strict';

const { PermissionFlagsBits } = require('discord.js');
const db = require('./db');

function isAdmin(member) {
  if (!member) return false;
  return member.permissions?.has(PermissionFlagsBits.Administrator) === true;
}

function getStaffRoleId(guildId) {
  return db.guild(guildId).staff_role_id || null;
}

function isStaff(member) {
  if (!member) return false;
  if (isAdmin(member)) return true;
  const staffRoleId = getStaffRoleId(member.guild.id);
  if (!staffRoleId) return false;
  return member.roles?.cache?.has(staffRoleId) === true;
}

function getTicket(guildId, channelId) {
  return db.guild(guildId).tickets[String(channelId)] || null;
}

function isTicketOwner(member, ticket) {
  if (!member || !ticket) return false;
  return String(ticket.user_id) === String(member.id);
}

module.exports = {
  isAdmin,
  isStaff,
  getStaffRoleId,
  getTicket,
  isTicketOwner,
};
