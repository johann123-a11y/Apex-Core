# Apex Core

A self-hosted Discord ticket bot.

## Features

- Custom ticket panels with buttons (Blue / Green / Red / Gray)
- Configurable embed (title, bold subtitle, body, footer)
- Up to 5 pre-ticket questions per panel via modal
- Group multiple panels in one message via dropdown
- Per-guild staff role (configurable, no Discord permission required)
- Ticket management: rename, add user, remove user, move category
- Toggleable extra viewer roles and ping roles
- Two close paths:
  - **Close Ticket** button — staff only
  - **Request Close** button — anyone. If a member requested, only staff can confirm. If staff requested, the ticket owner OR staff can confirm.

## Setup

1. Install Node.js 18+ and npm.
2. `cd apex-core && npm install`
3. Copy `.env.example` to `.env` and fill in:
   - `DISCORD_TOKEN` — bot token from the Discord developer portal
   - `DISCORD_CLIENT_ID` — application ID
   - `DISCORD_DEV_GUILD_ID` (optional) — register commands to one guild only for instant updates during dev
4. In the Discord developer portal, give the bot the following scopes when inviting:
   - `bot`, `applications.commands`
   - Permissions: Manage Channels, Manage Roles, Read Messages/View Channels, Send Messages, Embed Links, Attach Files, Manage Messages, Use Application Commands
5. Start the bot: `npm start`

The bot registers slash commands on boot. Global registration may take up to one hour to propagate; using `DISCORD_DEV_GUILD_ID` is instant.

## Commands

### Staff role

| Command | What it does |
|--|--|
| `/staff role set <role>` | Designate a role that can run every ticket command |
| `/staff role show` | Display the configured staff role |
| `/staff role clear` | Remove the staff role |

`/staff` requires Administrator permission. Server admins always count as staff.

### Tickets

| Command | What it does |
|--|--|
| `/ticket description` | Modal to set title, bold subtitle, body and footer of the panel embed |
| `/ticket setup` | Modal to create / update a panel (id, button text, color, category id, up to 5 questions) |
| `/ticket group` | Sends a dropdown so you can pick which panels to combine into one message |
| `/ticket panels` | List every configured panel |
| `/ticket delete <panel_id>` | Delete a panel |
| `/ticket rename <name>` | Rename the current ticket channel |
| `/ticket add <user>` | Add a user to the current ticket |
| `/ticket remove <user>` | Remove a user from the current ticket |
| `/ticket move <category_id>` | Move the current ticket to another category |
| `/ticket view <role>` | Toggle a role that can see every new ticket |
| `/ticket ping <role>` | Toggle a role that gets pinged when a ticket opens |

All `/ticket` subcommands require the staff role (or Administrator).

## Discord limits respected

Hard-coded in `config.js`:

- Embed title 256, description 4096, footer 2048, field name 256, value 1024, total 6000, fields 25
- Message content 2000
- Button label 80, custom_id 100
- Modal title 45, max 5 inputs; TextInput label 45, placeholder 100, max length 4000
- Select option label/description 100, max 25 options
- Channel name 100

All user-provided text is truncated to the relevant limit before sending to the Discord API.

## Storage

State lives in `apex-core/data/db.json` (auto-created). Back it up if you care about your panels, tickets and counters.

## Layout

```
apex-core/
├── package.json
├── .env.example
├── README.md
├── index.js                 // entry, REST register, event dispatcher
├── config.js                // env vars + Discord limits + custom_id prefixes
├── lib/
│   ├── db.js                // JSON storage (atomic, queued writes)
│   └── checks.js            // isStaff / isAdmin / getTicket helpers
└── modules/
    ├── staff.js             // /staff role set|show|clear
    └── tickets.js           // every /ticket subcommand + buttons + modals
```
