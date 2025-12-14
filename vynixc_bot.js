/*
  VynixC - API (VynixC + NodeJS)
  -----------------------------------------------------------------
  Single file containing two logical modules (api core + proxy):
  - api.js (Bot manager, HTTP API, auth, remote exec, persistence)
  - proxy.js (Dynamic command registry, runtime handlers, webhooks)

  Mandatory credits: "Created by VynixC"
  Usage: place this file inside your NodeJS gamemode using VynixC and initialize it.

  Notes:
  - Project built in CommonJS for maximum compatibility with Node/VynixC environments.
  - Requires dependencies: express, body-parser, sqlite3 (optional), node-fetch (or native fetch in Node 18+).
  - The code attempts to detect the VynixC runtime and integrates with hooks/commands.
  - Explanatory comments are now in English.
*/

/* =========================
   CONFIGURATION & DEPENDENCIES
   ========================= */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const child_process = require('child_process');
const express = require('express');
const bodyParser = require('body-parser');
let fetchAPI = null;
try {
  // node 18+ has global fetch
  fetchAPI = global.fetch || require('node-fetch');
} catch (e) {
  fetchAPI = null; // webhooks will fallback to child_process curl if necessary
}

// sqlite fallback
let sqlite3 = null;
try {
  sqlite3 = require('sqlite3').verbose();
} catch (e) {
  sqlite3 = null;
}

// Persistence files
const DATA_DIR = path.join(process.cwd(), 'vynixc_data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const JSON_DB = path.join(DATA_DIR, 'vynixc_commands.json');
const SQLITE_DB = path.join(DATA_DIR, 'vynixc_data.sqlite');

// Credits
const CREDITS = 'Created by VynixC';

/* =========================
   UTILITIES
   ========================= */

function log(...args) {
  console.log('[VynixC]', ...args);
}
function logInfo(...args) { console.log('\x1b[36m%s\x1b[0m', '[VynixC]', ...args); }
function logWarn(...args) { console.log('\x1b[33m%s\x1b[0m', '[VynixC]', ...args); }
function logErr(...args) { console.log('\x1b[31m%s\x1b[0m', '[VynixC]', ...args); }

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function nowISO() { return new Date().toISOString(); }

/* =========================
   BOT MANAGER (api.js)
   - Manages creation, listing and storage of bots
   ========================= */

class BotManager {
  constructor(opts = {}){
    this.bots = new Map(); // id -> bot
    this.nextId = 1;
    this.loadFromStorage();
    this.autoSaveInterval = opts.autoSaveInterval || 30 * 1000; // periodic save
    setInterval(() => this.saveToStorage(), this.autoSaveInterval);
  }

  createBot({ name, role = 'command_creator', webhook = null }){
    const id = String(this.nextId++);
    const token = generateToken();
    const bot = {
      id,
      name,
      token,
      role,
      webhook: webhook || null,
      commands: [],
      created_at: nowISO(),
    };
    this.bots.set(id, bot);
    this.saveToStorage();
    return bot;
  }

  listBots(){
    return Array.from(this.bots.values()).map(b => ({ id: b.id, name: b.name, role: b.role, webhook: b.webhook, created_at: b.created_at }));
  }

  getBotById(id){ return this.bots.get(String(id)) || null; }
  getBotByToken(token){
    for (const b of this.bots.values()) if (b.token === token) return b;
    return null;
  }

  attachCommandToBot(botId, commandName){
    const bot = this.getBotById(botId);
    if (!bot) return false;
    if (!bot.commands.includes(commandName)) bot.commands.push(commandName);
    this.saveToStorage();
    return true;
  }

  removeCommandFromBot(botId, commandName){
    const bot = this.getBotById(botId);
    if (!bot) return false;
    bot.commands = bot.commands.filter(c => c !== commandName);
    this.saveToStorage();
    return true;
  }

  // Simple persistence (SQLite preferred, JSON fallback)
  saveToStorage(){
    try {
      if (sqlite3) {
        if (!this._db) this._db = new sqlite3.Database(SQLITE_DB);
        const db = this._db;
        db.serialize(() => {
          db.run("CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, json TEXT)");
          const stmt = db.prepare("REPLACE INTO bots (id, json) VALUES (?, ?)");
          for (const [id, bot] of this.bots) stmt.run(id, JSON.stringify(bot));
          stmt.finalize();
        });
        return;
      }
      // fallback JSON
      const obj = { nextId: this.nextId, bots: Array.from(this.bots.values()) };
      fs.writeFileSync(JSON_DB, JSON.stringify(obj, null, 2));
    } catch (e) { logErr('Error saving bots: ', e.message); }
  }

  loadFromStorage(){
    try {
      if (sqlite3 && fs.existsSync(SQLITE_DB)){
        this._db = new sqlite3.Database(SQLITE_DB);
        this._db.serialize(() => {
          this._db.run("CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, json TEXT)");
          this._db.all("SELECT json FROM bots", (err, rows) => {
            if (err) return logErr('sqlite read bots error', err.message);
            for (const r of rows) {
              const bot = JSON.parse(r.json);
              this.bots.set(bot.id, bot);
              this.nextId = Math.max(this.nextId, Number(bot.id) + 1);
            }
          });
        });
        return;
      }
      if (fs.existsSync(JSON_DB)){
        const raw = fs.readFileSync(JSON_DB, 'utf8');
        const obj = JSON.parse(raw);
        this.nextId = obj.nextId || 1;
        for (const bot of obj.bots || []) this.bots.set(bot.id, bot);
      }
    } catch (e) { logErr('Error loading bots: ', e.message); }
  }
}

/* =========================
   COMMAND PROXY (proxy.js)
   - Registers dynamic commands at runtime
   - Executes callbacks (local in gamemode) or bot webhooks
   - Saves commands (SQLite or JSON)
   ========================= */

class CommandProxy {
  constructor(kainureInstance, botManager, opts = {}){
    this.kainure = kainureInstance || null;
    this.botManager = botManager;
    this.commands = new Map(); // commandName -> meta
    this.autoSaveInterval = opts.autoSaveInterval || 30 * 1000;
    this.initPersistence();
    setInterval(() => this.saveCommands(), this.autoSaveInterval);
    this._registerGlobalHandler();
  }

  // Internal command object:
  // {
  //   command: 'vip', description:'...', ownerId: '1', callback: 'OnVipActivate',
  //   webhook: true, created_at: 'ISO'
  // }

  createCommand({ token, command, description = '', callback = null, webhook = false }){
    const bot = this.botManager.getBotByToken(token);
    if (!bot) throw new Error('Invalid bot token');
    if (!command || typeof command !== 'string') throw new Error('Invalid command');
    command = command.replace(/^\/+/, '').toLowerCase();
    if (this.commands.has(command)) throw new Error('Command already exists');
    const meta = {
      command,
      description,
      ownerId: bot.id,
      callback: callback || null,
      webhook: !!webhook,
      created_at: nowISO(),
    };
    this.commands.set(command, meta);
    this.botManager.attachCommandToBot(bot.id, command);
    this.registerCommandInVynixC(command);
    this.saveCommands();
    return meta;
  }

  listCommands(){
    return Array.from(this.commands.values()).map(c => ({ command: c.command, description: c.description, ownerId: c.ownerId, created_at: c.created_at }));
  }

  getCommand(name){ return this.commands.get(String(name).toLowerCase()) || null; }

  deleteCommand(name){
    name = String(name).toLowerCase();
    const meta = this.commands.get(name);
    if (!meta) return false;
    this.commands.delete(name);
    this.botManager.removeCommandFromBot(meta.ownerId, name);
    // Ideally unregister command from VynixC — depends on its API.
    this.saveCommands();
    return true;
  }

  // Execute a command as if typed in console
  async runCommandAsConsole(cmd, token){
    const bot = this.botManager.getBotByToken(token);
    if (!bot) throw new Error('Invalid bot token');
    if (!['admin', 'executor'].includes(bot.role) && bot.role !== 'admin') throw new Error('Bot permission denied');

    // Try VynixC console execution
    if (this.kainure && typeof this.kainure.execConsoleCommand === 'function'){
      return this.kainure.execConsoleCommand(cmd);
    }

    // fallback: local shell exec
    try {
      const out = child_process.execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return out;
    } catch (e) {
      throw new Error('Exec error: ' + (e.message || 'unknown'));
    }
  }

  registerCommandInVynixC(commandName){
    logInfo('Registering command in proxy:', commandName);
    // real registration happens in _registerGlobalHandler
  }

  async handlePlayerCommand({ playerId, playerName, commandName, args }){
    commandName = String(commandName).replace(/^\/+/, '').toLowerCase();
    const meta = this.getCommand(commandName);
    if (!meta) return false;

    try {
      // 1) Local callback
      if (meta.callback && this.kainure && typeof this.kainure.callCallback === 'function'){
        try {
          await this.kainure.callCallback(meta.callback, { playerId, playerName, args, meta });
        } catch (e) {
          logWarn('Callback execution error for', meta.command, e.message);
        }
      }

      // 2) Webhook
      if (meta.webhook){
        const bot = this.botManager.getBotById(meta.ownerId);
        if (bot && bot.webhook){
          await this._sendWebhook(bot.webhook, {
            event: 'command_trigger',
            command: meta.command,
            playerId, playerName, args,
            meta,
            timestamp: nowISO(),
          }).catch(e => logWarn('Webhook fail', e.message));
        }
      }

      return true;
    } catch (e) {
      logErr('Error handling player command', e.message);
      return false;
    }
  }

  async _sendWebhook(url, payload){
    const body = JSON.stringify(payload);
    if (fetchAPI){
      const res = await fetchAPI(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      return res.text ? await res.text() : null;
    }
    // fallback curl
    return new Promise((resolve, reject) => {
      const tmpFile = path.join(DATA_DIR, 'vynixc_webhook_' + Date.now() + '.json');
      fs.writeFileSync(tmpFile, body);
      child_process.exec(`curl -s -X POST -H "Content-Type: application/json" --data @${tmpFile} "${url}"`, (err, stdout) => {
        try { fs.unlinkSync(tmpFile); } catch(e){}
        if (err) return reject(err);
        resolve(stdout);
      });
    });
  }

  /* =========================
     PERSISTENCE
     ========================= */

  initPersistence(){
    // Load from SQLite if available, otherwise JSON
    try {
      if (sqlite3 && fs.existsSync(SQLITE_DB)){
        this._db = new sqlite3.Database(SQLITE_DB);
        this._db.serialize(() => {
          this._db.run("CREATE TABLE IF NOT EXISTS commands (name TEXT PRIMARY KEY, json TEXT)");
          this._db.all("SELECT json FROM commands", (err, rows) => {
            if (err) return logWarn('sqlite read commands err', err.message);
            for (const r of rows){
              const cmd = JSON.parse(r.json);
              this.commands.set(cmd.command, cmd);
            }
          });
        });
        return;
      }
      if (fs.existsSync(JSON_DB)){
        const raw = fs.readFileSync(JSON_DB, 'utf8');
        const obj = JSON.parse(raw);
        for (const c of obj.commands || []) this.commands.set(c.command, c);
      }
    } catch (e) { logErr('Error loading commands: ', e.message); }
  }

  saveCommands(){
    try {
      if (sqlite3){
        if (!this._db) this._db = new sqlite3.Database(SQLITE_DB);
        const db = this._db;
        db.serialize(() => {
          db.run("CREATE TABLE IF NOT EXISTS commands (name TEXT PRIMARY KEY, json TEXT)");
          const stmt = db.prepare("REPLACE INTO commands (name, json) VALUES (?, ?)");
          for (const [name, c] of this.commands) stmt.run(name, JSON.stringify(c));
          stmt.finalize();
        });
        return;
      }
      const obj = { commands: Array.from(this.commands.values()) };
      fs.writeFileSync(JSON_DB, JSON.stringify(obj, null, 2));
    } catch (e) { logErr('Error saving commands: ', e.message); }
  }

  /* =========================
     KAINURE INTEGRATION
     - Attempts to register a global listener to capture player commands
     - Depends on the exposed event API from VynixC
     ========================= */

  _registerGlobalHandler(){
    if (this.kainure && typeof this.kainure.on === 'function'){
      try {
        // Example: kainure.on('playerCommand', handler)
        this.kainure.on('playerCommand', async (data) => {
          await this.handlePlayerCommand({
            playerId: data.playerId,
            playerName: data.playerName,
            commandName: data.command,
            args: data.args
          });
        });
        logInfo('Proxy: registered to kainure.playerCommand');
        return;
      } catch (e) { logWarn('Proxy registration via kainure.on failed'); }
    }

    // fallback: some VynixC setups may expose a global registerCommandHandler
    if (this.kainure && typeof this.kainure.registerCommandHandler === 'function'){
      this.kainure.registerCommandHandler(async (playerId, playerName, rawCmd) => {
        const parts = String(rawCmd || '').trim().split(/\s+/);
        const cmd = parts.shift().replace(/^\/+/, '');
        const args = parts;
        await this.handlePlayerCommand({ playerId, playerName, commandName: cmd, args });
      });
    }
  }
}
