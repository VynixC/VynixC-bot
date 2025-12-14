# VynixC Bot

**Created by VynixC**  
Professional API system for SA-MP gamemodes built in **NodeJS**, with support for **dynamic bot management**, **runtime command creation**, **webhooks**, **callbacks**, and **remote command execution**.

This README explains how to install, configure, and use the full API.

---

# 🚀 Overview

This project provides a **universal API layer** for SA-MP servers using NodeJS. It allows external bots or systems to:

- Create commands dynamically **without touching the gamemode files**.
- Execute commands remotely via HTTP.
- Register callbacks and trigger local script logic.
- Send and receive webhooks.
- Maintain bot authentication, roles, and permissions.
- Store all dynamic commands using **SQLite** (preferred) or JSON.

All commands created by bots remain active **in runtime**, and the system maintains a full memory registry of them.

---

# 📦 Installation

### 1. Install dependencies
Run inside your NodeJS gamemode project:

```
npm install express body-parser sqlite3 node-fetch
```

---

# 📁 File Placement
Place the API file inside your project and import it in your main gamemode file:

```js
const vynix = require('../Kainure/includes/vynixc-bot/vynixc_bot.js'); 
const app = vynix.init({ port: 3000 });
```

---

# ⚙ Integrating with Your Gamemode
If your environment exposes event hooks such as:

```js
global.vynixc.on('playerCommand', handler)
// or
vynixc.registerCommandHandler(...)
```

the proxy will automatically attach.

If not, call the handler manually inside your gamemode command processor:

```js
await app.proxy.handlePlayerCommand({
  playerId,
  playerName,
  commandName,
  args
});
```

---

# 🌐 API Endpoints

### **GET /** – API Status
Returns a simple JSON confirming the API is online.

---

## 🤖 Bot Management

### **GET /bots**
Returns all registered bots.

### **POST /bots/create**
Creates a new bot.

**Request JSON:**
```json
{
  "name": "MyBot",
  "role": "admin",
  "webhook": "https://example.com/hook"
}
```

**Response:**
- bot ID
- secure token
- role
- webhook

### **GET /bots/:id**
Returns detailed information about a bot.

---

# ⚡ Dynamic Command System
The central feature of this API.

Bots can create commands **at runtime**, which become instantly available to players.

### **POST /command/create**
Registers a new dynamic command.

**Example input:**
```json
{
  "token": "BOT_TOKEN",
  "command": "vip",
  "description": "Activate VIP for a player.",
  "callback": "OnVipActivate",
  "webhook": true
}
```

### What happens when a player types `/vip`?
- The command proxy validates if the command exists.
- If a **callback** is defined → calls the local gamemode function.
- If **webhook** is enabled → POST is sent to the bot webhook.
- If both exist → both trigger.

### Internal structure stored:
- command name
- owner bot ID
- description
- callback
- webhook enabled/disabled
- creation timestamp

---

# 🛰 Remote Command Execution
Bots can execute console-like commands.

### **POST /command/run**
Runs a remote command.

**Input:**
```json
{
  "token": "BOT_TOKEN",
  "cmd": "setworldtime 12"
}
```

**Features:**
- Token validation
- Permission checks
- Execution through internal console or exposed methods
- Output returned to the bot

---

# 📜 Listing Commands

### **GET /commands**
Returns all dynamic commands:

```json
[
  {
    "command": "vip",
    "owner": "MyBot",
    "description": "...",
    "created_at": "..."
  }
]
```

---

# 🗄 Persistence System
By default, the system attempts to use **SQLite** located at:
```
vynixc_data/
```
If `sqlite3` is not installed, it automatically falls back to:

```
vynixc_commands.json
```

### SQLite Tables:
- `bots`
- `commands`

Functions provided:
- `saveCommands()` (JSON fallback)
- `loadCommands()` (JSON fallback)

---

# 🧩 Architecture
The project may be structured in **one or two files**:

### **api.js**
- Bot system
- Tokens & roles
- HTTP Router
- Remote execution
- Logging
- Persistence layer

### **proxy.js**
- Dynamic command registration
- Universal command handler
- Callback execution
- Webhook triggers
- Automatic validation


---

# 🔐 Bot Roles
Each bot has a role defining their permissions:

| Role            | Permissions |
|-----------------|-------------|
| admin           | full access (create commands, execute remote commands) |
| command_creator | can create commands only |
| executor        | can run remote commands only |

---

# 🪝 Webhooks
If a command has `"webhook": true`, the API will POST the event to the bot’s webhook.

**Payload example:**
```json
{
  "event": "command_used",
  "command": "vip",
  "player": "John",
  "args": []
}
```

---

# 🧪 Example Callback
You may define callbacks in your gamemode:

```js
function OnVipActivate(playerId, args) {
  // Your logic here
}
```

The proxy will call this during command execution.

---

# 📣 Credits
This system must always show the visible credit:

```
Created by VynixC
```

You are permitted to modify, extend, and use this system commercially **as long as the credit remains intact**.

---

# 🧷 Notes
- All code is fully documented in-line.
- Designed for high performance and real-time command execution.
- Ideal for multi-bot environments.
- Supports scaling and external automation.

