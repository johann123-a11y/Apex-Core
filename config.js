'use strict';

require('dotenv').config();

const DISCORD_LIMITS = Object.freeze({
  MESSAGE_CONTENT: 2000,
  EMBED_TITLE: 256,
  EMBED_DESCRIPTION: 4096,
  EMBED_FOOTER: 2048,
  EMBED_AUTHOR_NAME: 256,
  EMBED_FIELD_NAME: 256,
  EMBED_FIELD_VALUE: 1024,
  EMBED_TOTAL: 6000,
  EMBED_FIELDS_MAX: 25,
  BUTTON_LABEL: 80,
  CUSTOM_ID: 100,
  MODAL_TITLE: 45,
  MODAL_INPUTS_MAX: 5,
  TEXT_INPUT_LABEL: 45,
  TEXT_INPUT_PLACEHOLDER: 100,
  TEXT_INPUT_MAX: 4000,
  SELECT_OPTIONS_MAX: 25,
  SELECT_LABEL: 100,
  SELECT_DESCRIPTION: 100,
  SELECT_VALUE: 100,
  CHANNEL_NAME: 100,
});

function truncate(str, limit, suffix = '…') {
  if (str == null) return '';
  const s = String(str);
  if (s.length <= limit) return s;
  if (limit <= suffix.length) return s.slice(0, limit);
  return s.slice(0, limit - suffix.length) + suffix;
}

module.exports = {
  TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.DISCORD_CLIENT_ID,
  DEV_GUILD_ID: process.env.DISCORD_DEV_GUILD_ID || null,
  DISCORD_LIMITS,
  truncate,
  // customId prefixes — keep short, room for suffixes; never exceed 100 chars total
  IDS: Object.freeze({
    PANEL_BUTTON: 'apex:panel',                    // apex:panel:<panel_id>
    PANEL_MODAL: 'apex:panel_modal',               // apex:panel_modal:<panel_id>
    TICKET_CLOSE: 'apex:ticket_close',
    TICKET_REQUEST_CLOSE: 'apex:ticket_request_close',
    TICKET_CONFIRM_CLOSE: 'apex:ticket_confirm_close',
    TICKET_CANCEL_CLOSE: 'apex:ticket_cancel_close',
    DESCRIPTION_MODAL: 'apex:description_modal',
    SETUP_MODAL: 'apex:setup_modal',
    GROUP_SELECT: 'apex:group_select',
  }),
  BUTTON_COLORS: Object.freeze({
    Blue: 1,    // Primary
    Green: 3,   // Success
    Red: 4,     // Danger
    Gray: 2,    // Secondary
  }),
};
