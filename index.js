'use strict';

const { Client, GatewayIntentBits, Partials, REST, Routes } = require('discord.js');
const { TOKEN, CLIENT_ID, DEV_GUILD_ID } = require('./config');
const db = require('./lib/db');

const staff = require('./modules/staff');
const tickets = require('./modules/tickets');

const modules = [staff, tickets];

function buildClient() {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
    partials: [Partials.Channel],
  });
}

async function registerCommands() {
  if (!TOKEN || !CLIENT_ID) {
    throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID must be set in .env');
  }
  const body = modules.flatMap((m) => (m.commands || []).map((c) => c.toJSON()));
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  if (DEV_GUILD_ID) {
    console.log(`[register] Registering ${body.length} commands to dev guild ${DEV_GUILD_ID}…`);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, DEV_GUILD_ID), { body });
  } else {
    console.log(`[register] Registering ${body.length} commands globally…`);
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
  }
  console.log('[register] Done.');
}

async function main() {
  if (!TOKEN) {
    throw new Error('DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.');
  }
  await db.init();
  await registerCommands();

  if (process.argv.includes('--register-only')) return;

  const client = buildClient();
  for (const m of modules) m.register(client);

  client.once('clientReady', (c) => {
    console.log(`[apex-core] Logged in as ${c.user.tag} (id ${c.user.id})`);
  });

  client.on('error', (e) => console.error('[apex-core] client error:', e));
  client.on('shardError', (e) => console.error('[apex-core] shard error:', e));
  process.on('unhandledRejection', (e) => console.error('[apex-core] unhandled rejection:', e));
  process.on('uncaughtException', (e) => console.error('[apex-core] uncaught exception:', e));

  await client.login(TOKEN);
}

main().catch((err) => {
  console.error('[apex-core] fatal:', err);
  process.exit(1);
});
