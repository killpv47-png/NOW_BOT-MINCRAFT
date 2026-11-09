// ============================================================
// 6b6t BOT | pvp_HSbot
// mineflayer | 1.21.4
// ============================================================
// Features:
//   - !auth / !tpa / !command /... / !go / !go stop
//   - !inv / !sethome / !stop msg / !start msg / !help
//   - !farm Smooth-Stone / !farm stop
//   - Auto Totem / Auto Armor
//   - Session-based auth (30 min re-verify)
//   - Coords never leaked to chat
//   - Portal flow untouched
// v2.2 fixes (verified on a local Paper 1.21.4 server):
//   - MINING NOW USES RAW PACKETS as the primary path (bot.dig crashed with
//     "enchantments is not iterable" on 1.21.4 items and the fallback never
//     engaged). Bot actually breaks blocks and moves now.
//   - FURNACES / CHESTS / CRAFTING TABLES / SHULKERS are protected: the miner
//     never digs them, even if they are inside the tunnel face.
//   - Mining spot is picked AWAY from the base anchor, and before digging the
//     bot checks the whole 3x3 corridor for protected blocks and ROTATES to a
//     clear direction (up to 4 x 90 degrees) instead of eating the machines.
//   - digTime computed per block with a safe floor of 300 ms.
// v3.0 (2026-08) major farm & QoL update:
//   - LAVA/CAVES: the miner now BRIDGES over lava pools and holes with
//     filler blocks (cobble/dirt/...) instead of giving up. One junk stack
//     is always kept as bridge material.
//   - AUTO ARMOR FIXED: mineflayer equipment slots are head/torso/legs/feet;
//     the old helmet/chestplate/... names never matched, so armor never
//     equipped at all.
//   - MOVEMENT: obstacles at feet/head level get dug out, and jump+forward
//     uses proper timing (no more hovering against a wall).
//   - FURNACES: output is collected in a loop until the slot is empty (no
//     more partial pickups), and fuel is pulled from chests AFTER stone is
//     loaded, so a full inventory no longer blocks refueling. Chests that
//     fail once are no longer forgotten.
//   - MOB DEFENSE: when a hostile mob hurts the bot, it flees back to base,
//     walls off the tunnel behind it, waits for the area to clear, then
//     resumes the farm cycle automatically.
//   - AUTO FOOD: eats any food found in the inventory when hungry
//     (enchanted golden apples included, gapples also on low HP).
//   - WEB UI on port 2000: live activity tree, player chat box, controls.
// ============================================================

require('dotenv').config()

const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')

const mineflayer = require('mineflayer')

function optionalRequire (moduleName) {
  try { return require(moduleName) } catch { return null }
}

const pathfinderPlugin = optionalRequire('mineflayer-pathfinder')
const canvasLib = optionalRequire('canvas')
const minecraftAssets = optionalRequire('minecraft-assets')
const Vec3Lib = optionalRequire('vec3')
const TelegramBotLib = optionalRequire('node-telegram-bot-api')
const Vec3 = Vec3Lib ? (Vec3Lib.Vec3 || Vec3Lib) : null

// ============================================================
// CONFIG
// ============================================================

const CONFIG = {
  host: process.env.MC_HOST || 'alt3.6b6t.org',
  port: Number(process.env.MC_PORT || 25565),

  username: process.env.MC_USERNAME || 'pvp_HSbot',
  password: process.env.MC_PASSWORD,

  version: process.env.MC_VERSION || '1.21.4',
  viewDistance: Number(process.env.MC_VIEW_DISTANCE || 8),

  owner: process.env.BOT_OWNER || 'pvp_HS',
  chatPrefix: process.env.CHAT_PREFIX || '!',

  chatDelay: Number(process.env.CHAT_DELAY || 2000),

  // ---------- SECURITY / !auth ----------
  authPassword: process.env.BOT_AUTH_PASSWORD || 'AZHAN8585@#@#ABOL1234',
  authMaxAttempts: Number(process.env.AUTH_MAX_ATTEMPTS || 5),
  authLockMs: Number(process.env.AUTH_LOCK_MS || 120_000),
  authSessionMs: Number(process.env.AUTH_SESSION_MS || 1_800_000), // 30 min

  // ---------- AUTO TOTEM ----------
  autoTotem: process.env.AUTO_TOTEM !== 'false',
  totemCheckInterval: Number(process.env.TOTEM_INTERVAL || 750),

  // ---------- AUTO ARMOR ----------
  autoArmor: process.env.AUTO_ARMOR !== 'false',
  armorCheckInterval: Number(process.env.ARMOR_INTERVAL || 3000),

  // ---------- AUTO FOOD ----------
  autoFood: process.env.AUTO_FOOD !== 'false',
  foodCheckInterval: Number(process.env.FOOD_INTERVAL || 2000),
  foodEatAt: Number(process.env.FOOD_EAT_AT || 14),

  // ---------- !go ----------
  goTimeout: Number(process.env.GO_TIMEOUT || 300_000),
  goCanDig: process.env.GO_CAN_DIG === 'true',

  // ---------- !inv ----------
  invScale: Number(process.env.INV_SCALE || 4),
  invUpload: process.env.INV_UPLOAD !== 'false',
  invDir: process.env.INV_DIR || path.join(__dirname, 'inventory'),

  // ---------- !farm Smooth-Stone ----------
  farmScanRadius: Number(process.env.FARM_SCAN_RADIUS || 24),
  farmStairDepth: Number(process.env.FARM_STAIR_DEPTH || 10),
  farmTunnelLength: Number(process.env.FARM_TUNNEL_LENGTH || 64),
  farmSaveFile: process.env.FARM_SAVE_FILE || path.join(__dirname, 'farm_memory.json'),

  // ---------- WEB UI ----------
  uiEnabled: process.env.UI_ENABLED !== 'false',
  uiPort: Number(process.env.UI_PORT || 2000),

  // ---------- LOG ----------
  hidePacketSpam: process.env.HIDE_PACKET_SPAM !== 'false'
}

if (!CONFIG.password) {
  console.error('MC_PASSWORD is not configured in .env')
  process.exit(1)
}

if (!Number.isFinite(CONFIG.chatDelay) || CONFIG.chatDelay < 500) {
  CONFIG.chatDelay = 2000
}

const SETTINGS_FILE = process.env.BOT_SETTINGS_FILE || path.join(__dirname, 'bot_settings.json')
const RUNTIME_STATE_FILE = process.env.BOT_RUNTIME_STATE_FILE || path.join(__dirname, 'bot_runtime_state.json')

const SETTINGS_SECRET = crypto
  .createHash('sha256')
  .update(`${CONFIG.username}|${CONFIG.password}|${CONFIG.authPassword}`)
  .digest()

function encryptText (plain) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', SETTINGS_SECRET, iv)
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

function decryptText (cipherText) {
  const raw = String(cipherText || '')
  if (!raw.startsWith('enc:')) return raw
  const parts = raw.split(':')
  if (parts.length !== 4) return ''
  const iv = Buffer.from(parts[1], 'hex')
  const tag = Buffer.from(parts[2], 'hex')
  const enc = Buffer.from(parts[3], 'hex')
  const decipher = crypto.createDecipheriv('aes-256-gcm', SETTINGS_SECRET, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}

const runtimeSettings = {
  langByChat: {},
  telegram: {
    enabled: process.env.TELEGRAM_ENABLED !== 'false',
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    adminIds: (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(v => v.trim()).filter(Boolean)
  },
  server: {
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    password: CONFIG.password,
    version: CONFIG.version
  },
  bot: {
    owner: CONFIG.owner,
    chatPrefix: CONFIG.chatPrefix,
    authPassword: CONFIG.authPassword,
    sixb6tMode: process.env.SIXB6T_MODE !== 'false',
    requireAuth: process.env.REQUIRE_OWNER_AUTH !== 'false',
    noPasswordMode: process.env.NO_PASSWORD_MODE === 'true',
    autoTpaAccept: process.env.AUTO_TPA_ACCEPT !== 'false',
    tpaAcceptCommand: process.env.TPA_ACCEPT_COMMAND || '/tpaccept {player}'
  },
  customCommands: {},
  ai: {
    enabled: process.env.AI_ENABLED !== 'false',
    baseUrl: process.env.AI_BASE_URL || '',
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || '',
    allowedCmdPrefixes: ['say', 'msg', 'tpa', 'tpaccept', 'warp', 'home']
  }
}

const runtimeState = {
  afkMode: false,
  mineTask: null,
  resumableTask: null,
  aiTask: null,
  skillSnapshot: null,
  skillTraining: null
}

function readJsonFileSafe (filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    log('SETTINGS', `Could not read ${path.basename(filePath)}: ${error.message}`)
    return fallback
  }
}

function writeJsonFileSafe (filePath, value) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
    return true
  } catch (error) {
    log('SETTINGS', `Could not write ${path.basename(filePath)}: ${error.message}`)
    return false
  }
}

function loadRuntimeSettings () {
  const loaded = readJsonFileSafe(SETTINGS_FILE, null)
  if (!loaded || typeof loaded !== 'object') return

  if (loaded.server?.host) runtimeSettings.server.host = String(loaded.server.host)
  if (loaded.server?.port) runtimeSettings.server.port = Number(loaded.server.port) || runtimeSettings.server.port
  if (loaded.server?.username) runtimeSettings.server.username = String(loaded.server.username)
  if (loaded.server?.version) runtimeSettings.server.version = String(loaded.server.version)
  if (loaded.server?.password) runtimeSettings.server.password = decryptText(loaded.server.password)

  if (loaded.bot?.owner) runtimeSettings.bot.owner = String(loaded.bot.owner)
  if (loaded.bot?.chatPrefix) runtimeSettings.bot.chatPrefix = String(loaded.bot.chatPrefix)
  if (loaded.bot?.authPassword) runtimeSettings.bot.authPassword = decryptText(loaded.bot.authPassword)
  if (typeof loaded.bot?.sixb6tMode === 'boolean') runtimeSettings.bot.sixb6tMode = loaded.bot.sixb6tMode
  if (typeof loaded.bot?.requireAuth === 'boolean') runtimeSettings.bot.requireAuth = loaded.bot.requireAuth
  if (typeof loaded.bot?.noPasswordMode === 'boolean') runtimeSettings.bot.noPasswordMode = loaded.bot.noPasswordMode
  if (typeof loaded.bot?.autoTpaAccept === 'boolean') runtimeSettings.bot.autoTpaAccept = loaded.bot.autoTpaAccept
  if (loaded.bot?.tpaAcceptCommand) runtimeSettings.bot.tpaAcceptCommand = String(loaded.bot.tpaAcceptCommand)

  if (loaded.telegram?.token) runtimeSettings.telegram.token = decryptText(loaded.telegram.token)
  if (Array.isArray(loaded.telegram?.adminIds)) runtimeSettings.telegram.adminIds = loaded.telegram.adminIds.map(v => String(v))
  if (loaded.langByChat && typeof loaded.langByChat === 'object') runtimeSettings.langByChat = loaded.langByChat

  if (loaded.ai?.baseUrl) runtimeSettings.ai.baseUrl = String(loaded.ai.baseUrl)
  if (loaded.ai?.apiKey) runtimeSettings.ai.apiKey = decryptText(loaded.ai.apiKey)
  if (loaded.ai?.model) runtimeSettings.ai.model = String(loaded.ai.model)
  if (typeof loaded.ai?.enabled === 'boolean') runtimeSettings.ai.enabled = loaded.ai.enabled

  if (loaded.customCommands && typeof loaded.customCommands === 'object') {
    runtimeSettings.customCommands = loaded.customCommands
  }
}

function saveRuntimeSettings () {
  const out = {
    langByChat: runtimeSettings.langByChat,
    telegram: {
      enabled: runtimeSettings.telegram.enabled,
      token: runtimeSettings.telegram.token ? encryptText(runtimeSettings.telegram.token) : '',
      adminIds: runtimeSettings.telegram.adminIds
    },
    server: {
      host: runtimeSettings.server.host,
      port: runtimeSettings.server.port,
      username: runtimeSettings.server.username,
      version: runtimeSettings.server.version,
      password: runtimeSettings.server.password ? encryptText(runtimeSettings.server.password) : ''
    },
    bot: {
      owner: runtimeSettings.bot.owner,
      chatPrefix: runtimeSettings.bot.chatPrefix,
      authPassword: runtimeSettings.bot.authPassword ? encryptText(runtimeSettings.bot.authPassword) : '',
      sixb6tMode: runtimeSettings.bot.sixb6tMode,
      requireAuth: runtimeSettings.bot.requireAuth,
      noPasswordMode: runtimeSettings.bot.noPasswordMode,
      autoTpaAccept: runtimeSettings.bot.autoTpaAccept,
      tpaAcceptCommand: runtimeSettings.bot.tpaAcceptCommand
    },
    customCommands: runtimeSettings.customCommands,
    ai: {
      enabled: runtimeSettings.ai.enabled,
      baseUrl: runtimeSettings.ai.baseUrl,
      apiKey: runtimeSettings.ai.apiKey ? encryptText(runtimeSettings.ai.apiKey) : '',
      model: runtimeSettings.ai.model
    }
  }
  return writeJsonFileSafe(SETTINGS_FILE, out)
}

function loadRuntimeState () {
  const loaded = readJsonFileSafe(RUNTIME_STATE_FILE, null)
  if (!loaded || typeof loaded !== 'object') return
  if (typeof loaded.afkMode === 'boolean') runtimeState.afkMode = loaded.afkMode
  if (loaded.mineTask && typeof loaded.mineTask === 'object') runtimeState.mineTask = loaded.mineTask
  if (loaded.resumableTask && typeof loaded.resumableTask === 'object') runtimeState.resumableTask = loaded.resumableTask
  if (loaded.aiTask && typeof loaded.aiTask === 'object') runtimeState.aiTask = loaded.aiTask
  if (loaded.skillSnapshot && typeof loaded.skillSnapshot === 'object') runtimeState.skillSnapshot = loaded.skillSnapshot
  if (loaded.skillTraining && typeof loaded.skillTraining === 'object') runtimeState.skillTraining = loaded.skillTraining
}

function saveRuntimeState () {
  writeJsonFileSafe(RUNTIME_STATE_FILE, runtimeState)
}

function applyRuntimeSettingsToConfig () {
  CONFIG.host = runtimeSettings.server.host || CONFIG.host
  CONFIG.port = Number(runtimeSettings.server.port || CONFIG.port)
  CONFIG.username = runtimeSettings.server.username || CONFIG.username
  CONFIG.password = runtimeSettings.server.password || CONFIG.password
  CONFIG.version = runtimeSettings.server.version || CONFIG.version

  CONFIG.owner = runtimeSettings.bot.owner || CONFIG.owner
  CONFIG.chatPrefix = runtimeSettings.bot.chatPrefix || CONFIG.chatPrefix
  CONFIG.authPassword = runtimeSettings.bot.authPassword || CONFIG.authPassword
}

loadRuntimeSettings()
loadRuntimeState()
applyRuntimeSettingsToConfig()

// ============================================================
// STATE
// ============================================================

let bot = null
let shuttingDown = false
let loggedIn = false
let authCommandPending = false
let inConfiguration = false
let portalFlowStarted = false
let loginSuccessAt = 0

let sessionTimers = []
let playerSyncTimer = null
let playerSyncStartedAt = 0
let playerListReady = false
let knownPlayers = new Set()
const PLAYER_SYNC_MAX_TIME = 15_000

let chatQueue = []
let chatQueueRunning = false
let chatQueueTimer = null
let lastChatSentAt = 0

let ownerVerified = false
let ownerVerifiedAt = 0
let authFailedAttempts = 0
let authLockedUntil = 0
let lastAuthPromptAt = 0
let lastDenyNoticeAt = 0

let totemTimer = null
let totemBusy = false
let lastTotemAttemptAt = 0

let armorTimer = null
let armorBusy = false

let foodTimer = null
let foodBusy = false

let fleeInProgress = false
let lastFleeAt = 0

// ---------- Web UI state ----------
let uiServer = null
let uiChatLog = []
let activityState = { label: 'Booting', detail: '', since: Date.now() }
let taskTree = []

let goActive = false
let goCancelRequested = false
let invBusy = false
let welcomeOthersEnabled = true

let lastTpaCommandAt = 0
let lastOwnerCommandAt = 0

let lastPrivateKey = ''
let lastPrivateAt = 0

let reconnectTimer = null
let reconnectAttempt = 0

let packetSpamSummaryTimer = null
let suppressedPacketLogs = 0
let transferCount = 0

const textureImageCache = new Map()

// ---------- Farm state ----------
let farmActive = false
let farmStopRequested = false
let farmLoopPromise = null

let farmMemory = {
  furnaces: [],
  blastFurnaces: [],
  fuelChests: [],
  pickaxeChests: [],
  craftingTables: [],
  emptyChests: []
}

let farmScan = null
let farmBaseAnchor = null

let telegramBot = null
const telegramChatState = new Map()
let mineLoopRunning = false
let mineStopRequested = false
let botWatchdogTimer = null
let aiBusy = false
let skillTrainingLoopRunning = false
let skillTrainingStopRequested = false
let skillScanCollector = null

// ============================================================
// LOGGING
// ============================================================

const PARTIAL_PACKET_PATTERN = /partial packet/i
const nativeConsoleLog = console.log

console.log = (...args) => {
  if (
    CONFIG.hidePacketSpam &&
    typeof args[0] === 'string' &&
    PARTIAL_PACKET_PATTERN.test(args[0])
  ) {
    suppressedPacketLogs++
    return
  }
  nativeConsoleLog(...args)
}

function startPacketSpamSummary () {
  if (!CONFIG.hidePacketSpam) return
  if (packetSpamSummaryTimer) return
  packetSpamSummaryTimer = setInterval(() => {
    if (suppressedPacketLogs < 1) return
    nativeConsoleLog(`[PACKET-SPAM] suppressed ${suppressedPacketLogs} partial-packet logs`)
    suppressedPacketLogs = 0
  }, 30_000)
  packetSpamSummaryTimer.unref?.()
}

function log (tag, message) {
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '')
  nativeConsoleLog(`[${now}] [${tag}] ${message}`)
}

function section (title) {
  nativeConsoleLog('')
  nativeConsoleLog('============================================================')
  nativeConsoleLog(`  ${title}`)
  nativeConsoleLog('============================================================')
}

// ============================================================
// ACTIVITY / TASK TREE (drives the Web UI)
// ============================================================

function setActivity (label, detail = '') {
  activityState = { label, detail, since: Date.now() }
}

function uiChatPush (entry) {
  uiChatLog.push(entry)
  if (uiChatLog.length > 120) uiChatLog = uiChatLog.slice(-120)
}

function updateTaskNode (id, patch) {
  const node = taskTree.find(n => n.id === id)
  if (!node) return
  Object.assign(node, patch)
}

function taskStart (id, label, detail = '') {
  updateTaskNode(id, { status: 'active', startedAt: Date.now(), detail })
  const active = taskTree.find(n => n.id === id && n.status === 'active')
  if (active) setActivity(label, detail)
}

function taskDone (id) {
  updateTaskNode(id, { status: 'done' })
}

function taskIdle (id) {
  updateTaskNode(id, { status: 'idle' })
}

function taskDetail (id, detail) {
  updateTaskNode(id, { detail })
}

function resetTaskTree () {
  taskTree = [
    { id: 'idle', label: 'Idle', status: 'active', icon: '⏸' },
    { id: 'travel', label: 'Travelling', status: 'idle', icon: '🥾' },
    { id: 'mining', label: 'Mining', status: 'idle', icon: '⛏' },
    { id: 'smelting', label: 'Smelting', status: 'idle', icon: '🔥' },
    { id: 'depositing', label: 'Depositing', status: 'idle', icon: '📦' },
    { id: 'fleeing', label: 'Fleeing from mob', status: 'idle', icon: '🏃' },
    { id: 'eating', label: 'Eating', status: 'idle', icon: '🍗' },
    { id: 'memory', label: 'Using memory (base path)', status: 'idle', icon: '🧠' }
  ]
}
resetTaskTree()

function currentModeId () {
  if (fleeInProgress) return 'fleeing'
  if (farmActive || mineLoopRunning || skillTrainingLoopRunning) return 'mining'
  if (goActive) return 'travel'
  return 'idle'
}

// ============================================================
// UTILS
// ============================================================

function clearSessionTimers () {
  for (const t of sessionTimers) {
    try { clearTimeout(t) } catch {}
  }
  sessionTimers = []
}

function later (currentBot, fn, ms) {
  const timeout = setTimeout(() => {
    sessionTimers = sessionTimers.filter(t => t !== timeout)
    if (shuttingDown) return
    if (bot !== currentBot) return
    fn()
  }, ms)
  sessionTimers.push(timeout)
  return timeout
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function stopMovement (currentBot = bot) {
  if (!currentBot) return
  try { currentBot.clearControlStates() } catch {}
  const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
  for (const control of controls) {
    try { currentBot.setControlState(control, false) } catch {}
  }
}

function position (currentBot = bot) {
  const p = currentBot?.entity?.position
  if (!p) return 'unknown'
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
    return 'invalid-position'
  }
  return `X=${p.x.toFixed(2)} Y=${p.y.toFixed(2)} Z=${p.z.toFixed(2)}`
}

function hasValidPosition (currentBot = bot) {
  const p = currentBot?.entity?.position
  return Boolean(p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))
}

function setPhysics (currentBot, state) {
  if (!currentBot) return
  try {
    if (currentBot.physicsEnabled !== state) {
      currentBot.physicsEnabled = state
      log('PHYSICS', state ? 'ON' : 'OFF')
    }
  } catch (error) {
    log('PHYSICS', `Could not change physics: ${error.message}`)
  }
}

function formatKickReason (reason) {
  try {
    if (typeof reason === 'string') return reason
    return JSON.stringify(reason, null, 2)
  } catch { return String(reason) }
}

function isValidMinecraftUsername (username) {
  return typeof username === 'string' && /^[a-zA-Z0-9_]{1,16}$/.test(username)
}

function normalizeUsername (username) {
  return String(username || '').toLowerCase()
}

function isOwner (username) {
  return normalizeUsername(username) === normalizeUsername(CONFIG.owner)
}

function stripColorCodes (text) {
  return String(text || '').replace(/§[0-9a-fk-orA-FK-OR]/g, '')
}

function escapeRegExp (text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getPlayerPing (currentBot, username) {
  if (!currentBot || !username) return null
  let player = currentBot.players?.[username]
  if (!player) {
    const realName = Object.keys(currentBot.players || {}).find(name => {
      return normalizeUsername(name) === normalizeUsername(username)
    })
    if (realName) player = currentBot.players[realName]
  }
  const ping = player?.ping
  if (!Number.isFinite(ping) || ping < 0) return null
  return ping
}

function safeEquals (a, b) {
  const sa = String(a || '')
  const sb = String(b || '')
  if (sa.length !== sb.length) return false
  let diff = 0
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i)
  }
  return diff === 0
}

// Coord-leak guard for outgoing chat
function containsSelfCoords (currentBot, text) {
  const p = currentBot?.entity?.position
  if (!p) return false
  const t = String(text)
  const x = Math.round(p.x)
  const y = Math.round(p.y)
  const z = Math.round(p.z)
  const rx = new RegExp(`(?<![0-9-])${x}(?![0-9])`)
  const ry = new RegExp(`(?<![0-9-])${y}(?![0-9])`)
  const rz = new RegExp(`(?<![0-9-])${z}(?![0-9])`)
  return rx.test(t) && ry.test(t) && rz.test(t)
}

// per-item sanitizer (1.21.x component items can crash the enchants getter)
function sanitizeItem (item) {
  if (!item) return
  try { void item.enchants } catch {
    try { Object.defineProperty(item, 'enchants', { value: [], configurable: true }) } catch {}
  }
  try { void item.lore } catch {
    try { Object.defineProperty(item, 'lore', { value: null, configurable: true }) } catch {}
  }
}

// ============================================================
// CHAT QUEUE
// ============================================================

function resetChatQueue () {
  chatQueue = []
  chatQueueRunning = false
  if (chatQueueTimer) {
    clearTimeout(chatQueueTimer)
    chatQueueTimer = null
  }
  lastChatSentAt = 0
}

function enqueueChat (currentBot, text, { priority = false, type = 'CHAT' } = {}) {
  if (bot !== currentBot) return
  if (!loggedIn) return
  if (typeof text !== 'string' || !text.trim()) return

  if (containsSelfCoords(currentBot, text)) {
    log('SECURITY', 'Blocked outgoing message containing self coords')
    return
  }

  const item = { text, type, bot: currentBot }
  if (priority) chatQueue.unshift(item)
  else chatQueue.push(item)

  processChatQueue(currentBot)
}

function processChatQueue (currentBot) {
  if (chatQueueRunning) return
  if (!chatQueue.length) return
  if (bot !== currentBot) return
  if (!loggedIn) return

  chatQueueRunning = true

  const now = Date.now()
  const waitTime = Math.max(0, CONFIG.chatDelay - (now - lastChatSentAt))

  if (chatQueueTimer) clearTimeout(chatQueueTimer)

  chatQueueTimer = setTimeout(() => {
    chatQueueTimer = null

    if (shuttingDown || bot !== currentBot || !loggedIn) {
      chatQueueRunning = false
      return
    }

    const item = chatQueue.shift()
    if (!item || item.bot !== currentBot) {
      chatQueueRunning = false
      processChatQueue(currentBot)
      return
    }

    try {
      currentBot.chat(item.text)
      lastChatSentAt = Date.now()
      log(item.type, item.text)
    } catch (error) {
      log('CHAT-ERROR', `Could not send message: ${error.message}`)
    }

    chatQueueRunning = false
    processChatQueue(currentBot)
  }, waitTime)
}

function sendPrivateMessage (currentBot, username, message, priority = false) {
  if (bot !== currentBot) return
  if (!loggedIn) return
  if (!isValidMinecraftUsername(username)) return
  enqueueChat(currentBot, `/msg ${username} ${message}`, { priority, type: 'PRIVATE' })
}

function messageOwner (currentBot, message, priority = true) {
  sendPrivateMessage(currentBot, CONFIG.owner, message, priority)
}

// ============================================================
// FANCY NOTIFICATIONS
// ============================================================

const FANCY_ICONS = ['★', '✦', '✧', '❖', '✪', '➤', '⚡', '☘', '⛏', '⚒', '♦', '◈']

function fancy (label, text) {
  const icon = FANCY_ICONS[Math.floor(Math.random() * FANCY_ICONS.length)]
  return `${icon} [${label}] ${text}`
}

function notifyOwner (currentBot, label, text) {
  messageOwner(currentBot, fancy(label, text))
}

// ============================================================
// PLAYER LIST SYNC
// ============================================================

function clearPlayerSyncTimer () {
  if (playerSyncTimer) {
    clearTimeout(playerSyncTimer)
    playerSyncTimer = null
  }
}

function beginPlayerListSync (currentBot, reason) {
  if (bot !== currentBot) return
  clearPlayerSyncTimer()

  knownPlayers = new Set()
  playerListReady = false
  playerSyncStartedAt = Date.now()

  log('PLAYER-SYNC', `Player list sync started: ${reason}`)

  playerSyncTimer = setTimeout(() => {
    finishPlayerListSync(currentBot)
  }, 8000)
}

function updatePlayerSyncTimer (currentBot) {
  if (bot !== currentBot) return
  if (playerListReady) return

  clearPlayerSyncTimer()

  const elapsed = Date.now() - playerSyncStartedAt
  const remaining = PLAYER_SYNC_MAX_TIME - elapsed
  const delay = Math.max(2000, Math.min(remaining, 5000))

  playerSyncTimer = setTimeout(() => {
    finishPlayerListSync(currentBot)
  }, delay)
}

function finishPlayerListSync (currentBot) {
  if (bot !== currentBot) return
  clearPlayerSyncTimer()

  knownPlayers = new Set(
    Object.keys(currentBot.players || {}).map(normalizeUsername)
  )
  playerListReady = true

  log('PLAYER-SYNC', `Player list ready; ${knownPlayers.size} existing players ignored`)
}

function queueWelcome (currentBot, username) {
  if (bot !== currentBot) return
  if (!loggedIn) return
  if (!playerListReady) return
  if (!isValidMinecraftUsername(username)) return
  if (normalizeUsername(username) === normalizeUsername(currentBot.username)) return

  if (!welcomeOthersEnabled && !isOwner(username)) {
    log('WELCOME-SKIP', `Welcome disabled, skipping ${username}`)
    return
  }

  later(currentBot, () => {
    if (bot !== currentBot) return
    if (!loggedIn) return
    if (!currentBot.players) return

    const playerStillOnline = Object.keys(currentBot.players).some(name => {
      return normalizeUsername(name) === normalizeUsername(username)
    })

    if (!playerStillOnline) {
      log('WELCOME', `${username} left before welcome message`)
      return
    }

    const ping = getPlayerPing(currentBot, username)
    const pingText = ping === null ? 'unknown' : `${ping}ms`

    if (isOwner(username)) {
      sendPrivateMessage(currentBot, username,
        `Welcome ${username} OWNER! Your ping: ${pingText}`, true)
      log('WELCOME', `Owner ${username} added to the front of queue`)
      return
    }

    sendPrivateMessage(currentBot, username,
      `Welcome ${username}! Your ping: ${pingText}`)
  }, 1500)
}

// ============================================================
// SECURITY / !auth (session based, 30 min default)
// ============================================================

function resetAuthState (reason) {
  const wasVerified = ownerVerified
  ownerVerified = false
  ownerVerifiedAt = 0
  authFailedAttempts = 0
  authLockedUntil = 0
  lastAuthPromptAt = 0

  if (wasVerified) {
    log('SECURITY', `Owner verification cleared: ${reason}`)
  }
}

function isAuthSessionValid () {
  if (!runtimeSettings.bot.requireAuth || runtimeSettings.bot.noPasswordMode) return true
  if (!ownerVerified) return false
  if (!ownerVerifiedAt) return false
  return (Date.now() - ownerVerifiedAt) < CONFIG.authSessionMs
}

function isAuthLocked () {
  return Date.now() < authLockedUntil
}

function requestAuth (currentBot, force = false) {
  if (!runtimeSettings.bot.requireAuth || runtimeSettings.bot.noPasswordMode) return
  if (!loggedIn) return
  if (isAuthLocked()) return
  if (!force && isAuthSessionValid()) return

  const now = Date.now()
  if (!force && now - lastAuthPromptAt < 30_000) return
  lastAuthPromptAt = now

  sendPrivateMessage(currentBot, CONFIG.owner,
    `Verification required. Send "${CONFIG.chatPrefix}auth <password>" to me in /msg. Session is valid for ${Math.round(CONFIG.authSessionMs / 60000)} minutes.`,
    true)

  log('SECURITY', 'Authentication requested from owner')
}

function denyUnverified (currentBot, username) {
  const now = Date.now()
  if (now - lastDenyNoticeAt < 8_000) return
  lastDenyNoticeAt = now

  sendPrivateMessage(currentBot, username,
    `You are not verified for this session. Use "${CONFIG.chatPrefix}auth <password>" in /msg first.`,
    true)
}

function handleAuthCommand (currentBot, username, rawMessage, isPrivate) {
  if (runtimeSettings.bot.noPasswordMode) {
    ownerVerified = true
    ownerVerifiedAt = Date.now()
    sendPrivateMessage(currentBot, username, 'No-password mode is ON. Verified.', true)
    return
  }

  if (!isPrivate) {
    log('SECURITY', 'auth attempt through public chat rejected')
    messageOwner(currentBot,
      'The auth command only works in /msg. If you typed the password in public chat, change it now.',
      true)
    return
  }

  if (isAuthLocked()) {
    const seconds = Math.ceil((authLockedUntil - Date.now()) / 1000)
    sendPrivateMessage(currentBot, username,
      `Authentication locked. Try again in ${seconds} seconds.`, true)
    return
  }

  const parts = rawMessage.trim().split(/\s+/)
  const supplied = parts.slice(1).join(' ')

  if (!supplied) {
    sendPrivateMessage(currentBot, username,
      `Usage: ${CONFIG.chatPrefix}auth <password>`, true)
    return
  }

  if (safeEquals(supplied, CONFIG.authPassword)) {
    ownerVerified = true
    ownerVerifiedAt = Date.now()
    authFailedAttempts = 0
    authLockedUntil = 0

    section('OWNER VERIFIED')
    log('SECURITY', `Owner ${username} verified successfully (session ${Math.round(CONFIG.authSessionMs / 60000)}m)`)

    sendPrivateMessage(currentBot, username,
      `Verified. Session valid for ${Math.round(CONFIG.authSessionMs / 60000)} minutes.`, true)
    return
  }

  authFailedAttempts++
  log('SECURITY', `Wrong password attempt ${authFailedAttempts}/${CONFIG.authMaxAttempts}`)

  if (authFailedAttempts >= CONFIG.authMaxAttempts) {
    authLockedUntil = Date.now() + CONFIG.authLockMs
    authFailedAttempts = 0
    log('SECURITY', `Authentication locked for ${Math.round(CONFIG.authLockMs / 1000)} seconds`)
    sendPrivateMessage(currentBot, username,
      'Too many wrong attempts. Authentication is locked temporarily.', true)
    return
  }

  sendPrivateMessage(currentBot, username, 'Wrong password.', true)
}

function buildWhisperPatterns (botName) {
  const user = '([A-Za-z0-9_]{1,16})'
  const self = `(?:me|You|you|${escapeRegExp(botName || CONFIG.username)})`
  return [
    new RegExp(`^${user} whispers(?: to you)?:?\\s+(.*)$`),
    new RegExp(`^\\[${user}\\s->\\s${self}\\]\\s(.*)$`),
    new RegExp(`^\\[${user}\\s→\\s${self}\\]\\s(.*)$`),
    new RegExp(`^${user}\\s->\\s${self}\\s:?\\s+(.*)$`),
    new RegExp(`^${user}\\s→\\s${self}\\s:?\\s+(.*)$`),
    new RegExp(`^From ${user}\\s:?\\s+(.*)$`),
    new RegExp(`^\\[MSG\\]\\s${user}\\s:?\\s+(.*)$`)
  ]
}

function parsePrivateMessage (currentBot, rawText) {
  const text = stripColorCodes(rawText).trim()
  if (!text) return null
  for (const pattern of buildWhisperPatterns(currentBot.username)) {
    const match = text.match(pattern)
    if (match) {
      return { username: match[1], message: match[2] }
    }
  }
  return null
}

// ============================================================
// AUTO TOTEM
// ============================================================

function stopTotemLoop () {
  if (totemTimer) {
    clearInterval(totemTimer)
    totemTimer = null
  }
  totemBusy = false
}

function startTotemLoop (currentBot) {
  stopTotemLoop()
  if (!CONFIG.autoTotem) {
    log('TOTEM', 'Auto totem is disabled by configuration')
    return
  }
  log('TOTEM', 'Auto totem enabled')
  totemTimer = setInterval(() => {
    ensureTotem(currentBot)
  }, CONFIG.totemCheckInterval)
  totemTimer.unref?.()
}

async function ensureTotem (currentBot) {
  if (shuttingDown) return
  if (bot !== currentBot) return
  if (!loggedIn) return
  if (totemBusy) return
  if (!currentBot.inventory) return
  if (currentBot.isAlive === false) return

  const now = Date.now()
  if (now - lastTotemAttemptAt < 300) return

  const offhandSlot = currentBot.getEquipmentDestSlot?.('off-hand')
  const offhandItem = offhandSlot != null ? currentBot.inventory.slots[offhandSlot] : null
  if (offhandItem?.name === 'totem_of_undying') return

  const totem = currentBot.inventory.items().find(item => item.name === 'totem_of_undying')
  if (!totem) return

  totemBusy = true
  lastTotemAttemptAt = now
  try {
    await currentBot.equip(totem, 'off-hand')
    log('TOTEM', 'Totem of Undying moved to off-hand')
  } catch (error) {
    log('TOTEM', `Could not equip totem: ${error.message}`)
  } finally {
    totemBusy = false
  }
}

// ============================================================
// AUTO ARMOR
// ============================================================

// mineflayer equipment slots: 'head' | 'torso' | 'legs' | 'feet' | 'hand' | 'off-hand'
// (the old helmet/chestplate/leggings/boots names never matched a real slot,
//  so bot.equip() silently failed every 3s and armor was never equipped)
const ARMOR_TIERS = {
  head: ['netherite_helmet', 'diamond_helmet', 'iron_helmet', 'golden_helmet', 'chainmail_helmet', 'leather_helmet', 'turtle_helmet', 'turtle_shell', 'carved_pumpkin'],
  torso: ['netherite_chestplate', 'diamond_chestplate', 'iron_chestplate', 'golden_chestplate', 'chainmail_chestplate', 'leather_chestplate', 'elytra'],
  legs: ['netherite_leggings', 'diamond_leggings', 'iron_leggings', 'golden_leggings', 'chainmail_leggings', 'leather_leggings'],
  feet: ['netherite_boots', 'diamond_boots', 'iron_boots', 'golden_boots', 'chainmail_boots', 'leather_boots']
}

function stopArmorLoop () {
  if (armorTimer) {
    clearInterval(armorTimer)
    armorTimer = null
  }
  armorBusy = false
}

function startArmorLoop (currentBot) {
  stopArmorLoop()
  if (!CONFIG.autoArmor) {
    log('ARMOR', 'Auto armor is disabled by configuration')
    return
  }
  log('ARMOR', 'Auto armor enabled')
  armorTimer = setInterval(() => {
    ensureBestArmor(currentBot).catch(() => {})
  }, CONFIG.armorCheckInterval)
  armorTimer.unref?.()
}

async function ensureBestArmor (currentBot) {
  if (shuttingDown) return
  if (bot !== currentBot) return
  if (!loggedIn) return
  if (armorBusy) return
  if (!currentBot.inventory) return
  if (currentBot.isAlive === false) return

  armorBusy = true
  try {
    for (const [slotName, tiers] of Object.entries(ARMOR_TIERS)) {
      const destSlot = currentBot.getEquipmentDestSlot(slotName)
      const equipped = currentBot.inventory.slots[destSlot]
      const equippedRank = equipped ? tiers.indexOf(equipped.name) : Infinity
      let bestItem = null
      let bestRank = equippedRank === -1 ? Infinity : equippedRank
      for (const item of currentBot.inventory.items()) {
        const rank = tiers.indexOf(item.name)
        if (rank === -1) continue
        if (rank < bestRank) {
          bestRank = rank
          bestItem = item
        }
      }
      if (bestItem) {
        try {
          sanitizeItem(bestItem)
          await currentBot.equip(bestItem, slotName)
          log('ARMOR', `Equipped ${bestItem.name} to ${slotName}`)
        } catch (error) {
          log('ARMOR', `Could not equip ${bestItem.name}: ${error.message}`)
        }
      }
    }
  } finally {
    armorBusy = false
  }
}

// ============================================================
// AUTO FOOD
// ============================================================

const FOOD_ITEMS = new Set([
  'apple', 'baked_potato', 'beetroot', 'beetroot_soup', 'bread', 'carrot',
  'chorus_fruit', 'cooked_beef', 'cooked_chicken', 'cooked_cod',
  'cooked_mutton', 'cooked_porkchop', 'cooked_rabbit', 'cooked_salmon',
  'cookie', 'dried_kelp', 'glow_berries', 'golden_apple',
  'enchanted_golden_apple', 'golden_carrot', 'honey_bottle', 'melon_slice',
  'mushroom_stew', 'potato', 'pumpkin_pie', 'rabbit_stew', 'raw_beef',
  'raw_chicken', 'raw_cod', 'raw_mutton', 'raw_porkchop', 'raw_rabbit',
  'raw_salmon', 'rotten_flesh', 'spider_eye', 'suspicious_stew',
  'sweet_berries', 'tropical_fish', 'poisonous_potato'
])

const GOOD_FOOD = [
  'enchanted_golden_apple', 'golden_apple', 'golden_carrot', 'cooked_beef',
  'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit',
  'cooked_cod', 'cooked_salmon', 'bread', 'baked_potato', 'pumpkin_pie',
  'cookie', 'apple', 'carrot', 'potato', 'sweet_berries', 'glow_berries',
  'melon_slice', 'dried_kelp', 'chorus_fruit', 'mushroom_stew',
  'rabbit_stew', 'beetroot_soup', 'beetroot', 'suspicious_stew',
  'honey_bottle', 'raw_beef', 'raw_porkchop', 'raw_chicken', 'raw_mutton',
  'raw_cod', 'raw_salmon', 'raw_rabbit', 'tropical_fish', 'poisonous_potato',
  'rotten_flesh', 'spider_eye'
]

function stopFoodLoop () {
  if (foodTimer) {
    clearInterval(foodTimer)
    foodTimer = null
  }
  foodBusy = false
}

function startFoodLoop (currentBot) {
  stopFoodLoop()
  if (!CONFIG.autoFood) {
    log('FOOD', 'Auto food is disabled by configuration')
    return
  }
  log('FOOD', 'Auto food enabled')
  foodTimer = setInterval(() => {
    ensureFood(currentBot).catch(() => {})
  }, CONFIG.foodCheckInterval)
  foodTimer.unref?.()
}

function pickFoodItem (currentBot, urgent) {
  const items = currentBot.inventory.items().filter(it => FOOD_ITEMS.has(it.name))
  if (!items.length) return null
  if (urgent) {
    const gapple = items.find(it => it.name === 'enchanted_golden_apple')
    if (gapple) return gapple
    const normalGapple = items.find(it => it.name === 'golden_apple')
    if (normalGapple) return normalGapple
  }
  for (const name of GOOD_FOOD) {
    const item = items.find(it => it.name === name)
    if (item) return item
  }
  return items[0]
}

async function ensureFood (currentBot) {
  if (shuttingDown) return
  if (bot !== currentBot) return
  if (!loggedIn) return
  if (foodBusy) return
  if (!currentBot.inventory) return
  if (currentBot.isAlive === false) return

  const food = currentBot.food ?? 20
  const health = currentBot.health ?? 20
  const urgent = health <= 12
  if (!urgent && food >= CONFIG.foodEatAt) return
  if (food >= 20) return

  const foodItem = pickFoodItem(currentBot, urgent)
  if (!foodItem) return

  foodBusy = true
  try {
    sanitizeItem(foodItem)
    await currentBot.equip(foodItem, 'hand')
    taskStart('eating', 'Eating', foodItem.name.replace(/_/g, ' '))
    setActivity('Eating', foodItem.name.replace(/_/g, ' '))
    await currentBot.consume()
    log('FOOD', `Ate ${foodItem.name} (food=${food.toFixed(0)} hp=${health.toFixed(0)})`)
  } catch (error) {
    if (!/consuming|Cancelled|cancel/i.test(String(error?.message))) {
      log('FOOD', `Could not eat: ${error.message}`)
    }
  } finally {
    taskDone('eating')
    foodBusy = false
  }
}

// ============================================================
// PATHFINDING (!go / !sethome)
// ============================================================

function pathfinderAvailable () {
  return Boolean(pathfinderPlugin && bot?.pathfinder)
}

function buildMovements (currentBot, { canDig = CONFIG.goCanDig } = {}) {
  const { Movements } = pathfinderPlugin
  const movements = new Movements(currentBot)
  movements.allowSprinting = true
  movements.allowParkour = true
  movements.canDig = canDig
  movements.allow1by1towers = false
  movements.allowFreeMotion = false
  movements.maxDropDown = 4
  // never path THROUGH lava / liquids
  try {
    movements.liquidCost = 30
    movements.lavaCost = 100
  } catch {}
  // let it bridge 1-block gaps with any cheap block we carry
  const scaffoldSet = new Set([
    'cobblestone', 'cobbled_deepslate', 'dirt', 'coarse_dirt', 'grass_block',
    'sand', 'gravel', 'netherrack', 'stone', 'andesite', 'diorite', 'granite',
    'tuff', 'deepslate', 'oak_planks', 'spruce_planks', 'birch_planks',
    'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks',
    'cherry_planks', 'bamboo_planks', 'crimson_planks', 'warped_planks',
    'blackstone', 'basalt', 'end_stone', 'smooth_stone'
  ])
  try {
    const ids = (currentBot.registry?.blocksArray || [])
      .filter(b => scaffoldSet.has(b.name))
      .map(b => b.id)
    if (ids.length) {
      movements.scafoldingBlocks = ids
      movements.scaffoldingBlocks = ids
    }
  } catch {}
  return movements
}

function portalFlowBusy () {
  if (!loginSuccessAt) return false
  return Date.now() - loginSuccessAt < 45_000
}

function cancelPathfinding (currentBot, reason) {
  if (!currentBot?.pathfinder) return
  try {
    goCancelRequested = true
    currentBot.pathfinder.setGoal(null)
    log('PATHFINDER', `Cancelled: ${reason}`)
  } catch {}
}

async function withPathfinding (currentBot, fn, opts = {}) {
  if (!pathfinderAvailable()) throw new Error('Pathfinder not ready')
  const movements = buildMovements(currentBot, opts)
  try { currentBot.pathfinder.setMovements(movements) } catch {}
  setPhysics(currentBot, true)
  try {
    return await fn()
  } finally {
    stopMovement(currentBot)
  }
}

function parseCoordinates (currentBot, argsText) {
  const parts = argsText
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)

  if (!parts.length) return null
  if (parts.some(value => !Number.isFinite(value))) return null

  if (parts.length === 3) {
    return { x: parts[0], y: parts[1], z: parts[2] }
  }
  if (parts.length === 2) {
    return {
      x: parts[0],
      y: Math.round(currentBot.entity.position.y),
      z: parts[1]
    }
  }
  return null
}

async function commandGo (currentBot, username, argsText) {
  const trimmed = argsText.trim().toLowerCase()

  if (trimmed === 'stop' || trimmed === 'cancel') {
    if (!goActive) {
      sendPrivateMessage(currentBot, username, 'No active travel to stop.', true)
      return
    }
    cancelPathfinding(currentBot, 'owner request')
    sendPrivateMessage(currentBot, username, 'Stopping travel.', true)
    return
  }

  if (!pathfinderPlugin) {
    sendPrivateMessage(currentBot, username,
      'Pathfinder is not installed. Run: npm i mineflayer-pathfinder', true)
    return
  }
  if (!pathfinderAvailable()) {
    sendPrivateMessage(currentBot, username, 'Pathfinder is not ready yet.', true)
    return
  }
  if (goActive) {
    sendPrivateMessage(currentBot, username, 'Already travelling. Use !go stop first.', true)
    return
  }
  if (portalFlowBusy()) {
    sendPrivateMessage(currentBot, username,
      'Portal flow is still running. Try again in about a minute.', true)
    return
  }
  if (!hasValidPosition(currentBot)) {
    sendPrivateMessage(currentBot, username, 'My position is not valid yet.', true)
    return
  }

  const target = parseCoordinates(currentBot, argsText)
  if (!target) {
    sendPrivateMessage(currentBot, username,
      `Usage: ${CONFIG.chatPrefix}go <x> <y> <z>  |  ${CONFIG.chatPrefix}go <x> <z>  |  ${CONFIG.chatPrefix}go stop`, true)
    return
  }

  section('TRAVEL REQUEST')
  log('GO', `Target: X=${target.x} Y=${target.y} Z=${target.z}`)

  goActive = true
  goCancelRequested = false

  sendPrivateMessage(currentBot, username, 'Travelling to target...', true)

  const startedAt = Date.now()
  try {
    await withPathfinding(currentBot, async () => {
      const { goals } = pathfinderPlugin
      const goal = new goals.GoalNear(target.x, target.y, target.z, 1)
      const travel = currentBot.pathfinder.goto(goal)
      const timeout = new Promise((resolve, reject) => {
        const handle = setTimeout(() => {
          cancelPathfinding(currentBot, 'timeout')
          reject(new Error('Travel timeout'))
        }, CONFIG.goTimeout)
        travel.finally(() => clearTimeout(handle)).catch(() => {})
      })
      await Promise.race([travel, timeout])
    })

    if (goCancelRequested) {
      sendPrivateMessage(currentBot, username, 'Travel stopped.', true)
    } else {
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      sendPrivateMessage(currentBot, username, `Arrived. (${seconds}s)`, true)
      log('GO', `Arrived at ${position(currentBot)}`)
    }
  } catch (error) {
    if (goCancelRequested) {
      sendPrivateMessage(currentBot, username, 'Travel stopped.', true)
    } else {
      sendPrivateMessage(currentBot, username, `Travel failed: ${error.message}`, true)
      log('GO', `Travel failed: ${error.message}`)
    }
  } finally {
    goActive = false
    goCancelRequested = false
  }
}

// ============================================================
// !sethome
// ============================================================

function findNearbyBed (currentBot) {
  const bedIds = (currentBot.registry?.blocksArray || [])
    .filter(block => block.name.endsWith('_bed'))
    .map(block => block.id)
  if (!bedIds.length) return null
  return currentBot.findBlock({ matching: bedIds, maxDistance: 64, count: 1 })
}

async function commandSetHome (currentBot, username) {
  if (!hasValidPosition(currentBot)) {
    sendPrivateMessage(currentBot, username, 'My position is not valid yet.', true)
    return
  }
  const dimension = String(currentBot.game?.dimension || '')
  if (!dimension.includes('overworld')) {
    sendPrivateMessage(currentBot, username,
      `Refusing: beds explode outside the Overworld (current: ${dimension || 'unknown'}).`, true)
    return
  }
  const bed = findNearbyBed(currentBot)
  if (!bed) {
    sendPrivateMessage(currentBot, username, 'No bed found within 64 blocks.', true)
    return
  }

  section('SET HOME')
  log('SETHOME', `Bed found at ${bed.position.x} ${bed.position.y} ${bed.position.z}`)
  sendPrivateMessage(currentBot, username, 'Bed found. Walking to it ...', true)

  const respawnConfirmed = waitForRespawnMessage(currentBot, 8000)

  try {
    const distance = currentBot.entity.position.distanceTo(bed.position)
    if (distance > 3) {
      if (!pathfinderAvailable()) {
        sendPrivateMessage(currentBot, username,
          'Bed is too far and pathfinder is not installed (npm i mineflayer-pathfinder).', true)
        return
      }
      if (portalFlowBusy()) {
        sendPrivateMessage(currentBot, username,
          'Portal flow is still running. Try again in about a minute.', true)
        return
      }
      goActive = true
      try {
        await withPathfinding(currentBot, async () => {
          const { goals } = pathfinderPlugin
          await currentBot.pathfinder.goto(
            new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2)
          )
        })
      } finally {
        goActive = false
      }
    }

    setPhysics(currentBot, true)
    const freshBed = currentBot.blockAt(bed.position) || bed
    await currentBot.lookAt(freshBed.position.offset(0.5, 0.5, 0.5), true)
    await currentBot.activateBlock(freshBed)
    log('SETHOME', 'Bed activated (single click)')

    const confirmation = await respawnConfirmed
    if (currentBot.isSleeping) {
      await sleep(1500)
      try { await currentBot.wake() } catch {}
    }

    if (confirmation) {
      messageOwner(currentBot, 'Respawn point set.', true)
    } else {
      messageOwner(currentBot, 'Bed clicked but the server sent no confirmation.', true)
    }
  } catch (error) {
    sendPrivateMessage(currentBot, username, `Set home failed: ${error.message}`, true)
    log('SETHOME', `Failed: ${error.message}`)
  } finally {
    stopMovement(currentBot)
  }
}

function waitForRespawnMessage (currentBot, timeoutMs) {
  return new Promise(resolve => {
    const pattern = /(respawn point set|spawn point set|home set|new spawn)/i
    const listener = message => {
      if (pattern.test(stripColorCodes(message))) {
        cleanup(); resolve(true)
      }
    }
    const handle = setTimeout(() => { cleanup(); resolve(false) }, timeoutMs)
    function cleanup () {
      clearTimeout(handle)
      currentBot.removeListener('messagestr', listener)
    }
    currentBot.on('messagestr', listener)
  })
}

// ============================================================
// !inv  (2D inventory render)
// ============================================================

const INV_LAYOUT = {
  width: 178, height: 160, slot: 18,
  armorX: 8, armorY: 22,
  offhandX: 90, offhandY: 22,
  craftX: 118, craftY: 22,
  resultX: 156, resultY: 31,
  mainX: 8, mainY: 70, hotbarY: 130
}

function getAssets () {
  if (!minecraftAssets) return null
  try {
    return (
      minecraftAssets(CONFIG.version) ||
      minecraftAssets('1.21.4') ||
      minecraftAssets('1.21.1')
    )
  } catch { return null }
}

async function getTextureImage (assets, itemName) {
  if (textureImageCache.has(itemName)) return textureImageCache.get(itemName)
  let image = null
  try {
    const entry = assets.findItemOrBlockByName(itemName)
    if (entry?.texture) {
      const relative = entry.texture.replace('minecraft:', '')
      const file = path.join(assets.directory, `${relative}.png`)
      if (fs.existsSync(file)) {
        image = await canvasLib.loadImage(file)
      }
    }
  } catch { image = null }
  textureImageCache.set(itemName, image)
  return image
}

function drawSlot (ctx, x, y, size) {
  ctx.fillStyle = '#8b8b8b'; ctx.fillRect(x, y, size, size)
  ctx.fillStyle = '#373737'
  ctx.fillRect(x, y, size, 2); ctx.fillRect(x, y, 2, size)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(x, y + size - 2, size, 2); ctx.fillRect(x + size - 2, y, 2, size)
}

function drawTextWithShadow (ctx, text, x, y, color = '#ffffff', shadow = 2) {
  ctx.fillStyle = 'rgba(0,0,0,0.75)'
  ctx.fillText(text, x + shadow, y + shadow)
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
}

async function drawItem (ctx, assets, item, x, y, size, scale) {
  if (!item) return
  const image = await getTextureImage(assets, item.name)
  const padding = Math.round(scale * 1)
  const inner = size - padding * 2

  if (image) {
    const sourceSize = image.height > image.width ? image.width : image.height
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(image, 0, 0, image.width, sourceSize, x + padding, y + padding, inner, inner)
  } else {
    ctx.fillStyle = '#3a3a3a'
    ctx.fillRect(x + padding, y + padding, inner, inner)
    ctx.font = `${Math.round(scale * 4)}px "Minecraftia","DejaVu Sans",sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    drawTextWithShadow(ctx, item.name.slice(0, 6), x + size / 2, y + size / 2, '#dddddd', 1)
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  }

  let enchanted = false
  try { enchanted = Boolean(item.enchants && item.enchants.length) } catch {}
  if (enchanted) {
    ctx.fillStyle = 'rgba(170, 90, 255, 0.22)'
    ctx.fillRect(x + padding, y + padding, inner, inner)
  }

  try {
    const maxDurability = item.maxDurability
    const used = item.durabilityUsed
    if (Number.isFinite(maxDurability) && maxDurability > 0 && used > 0) {
      const ratio = Math.max(0, 1 - used / maxDurability)
      const barWidth = Math.round(inner * 0.85)
      const barHeight = Math.max(2, Math.round(scale * 1))
      const barX = x + padding + Math.round(scale * 1)
      const barY = y + size - padding - barHeight * 2
      ctx.fillStyle = '#000000'
      ctx.fillRect(barX, barY, barWidth, barHeight)
      ctx.fillStyle = `hsl(${Math.round(ratio * 120)}, 100%, 45%)`
      ctx.fillRect(barX, barY, Math.round(barWidth * ratio), barHeight)
    }
  } catch {}

  if (item.count > 1) {
    ctx.font = `bold ${Math.round(scale * 7)}px "Minecraftia","DejaVu Sans",sans-serif`
    ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'
    drawTextWithShadow(ctx, String(item.count),
      x + size - padding, y + size - padding - Math.round(scale * 0.5),
      '#ffffff', Math.max(1, Math.round(scale / 2)))
    ctx.textAlign = 'left'
  }
}

async function renderInventoryImage (currentBot) {
  if (!canvasLib || !minecraftAssets) return null
  const assets = getAssets()
  if (!assets) return null

  const fontFile = path.join(__dirname, 'assets', 'minecraft.ttf')
  if (fs.existsSync(fontFile)) {
    try { canvasLib.registerFont(fontFile, { family: 'Minecraftia' }) } catch {}
  }

  const scale = Math.max(2, Math.min(8, CONFIG.invScale))
  const L = INV_LAYOUT

  const canvas = canvasLib.createCanvas(L.width * scale, L.height * scale)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false

  ctx.fillStyle = '#c6c6c6'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, 2 * scale)
  ctx.fillRect(0, 0, 2 * scale, canvas.height)
  ctx.fillStyle = '#555555'
  ctx.fillRect(0, canvas.height - 2 * scale, canvas.width, 2 * scale)
  ctx.fillRect(canvas.width - 2 * scale, 0, 2 * scale, canvas.height)

  ctx.font = `bold ${Math.round(scale * 7)}px "Minecraftia","DejaVu Sans",sans-serif`
  ctx.fillStyle = '#404040'
  ctx.textAlign = 'left'
  ctx.fillText(`${currentBot.username}`, 8 * scale, 15 * scale)

  ctx.font = `${Math.round(scale * 5)}px "Minecraftia","DejaVu Sans",sans-serif`
  ctx.fillText(
    `HP ${Math.round(currentBot.health ?? 0)}/20   Food ${Math.round(currentBot.food ?? 0)}/20`,
    58 * scale, 15 * scale)

  const slots = currentBot.inventory?.slots || []
  const size = L.slot * scale
  const step = L.slot * scale

  const drawGroup = async (indexes, startX, startY, columns) => {
    for (let i = 0; i < indexes.length; i++) {
      const col = i % columns
      const row = Math.floor(i / columns)
      const x = startX * scale + col * step
      const y = startY * scale + row * step
      drawSlot(ctx, x, y, size)
      await drawItem(ctx, assets, slots[indexes[i]], x, y, size, scale)
    }
  }

  await drawGroup([5, 6, 7, 8], L.armorX, L.armorY, 1)
  await drawGroup([45], L.offhandX, L.offhandY, 1)
  const mainInvIdx = []
  for (let i = 9; i <= 35; i++) mainInvIdx.push(i)
  await drawGroup(mainInvIdx, L.mainX, L.mainY, 9)
  const hotbarIdx = []
  for (let i = 36; i <= 44; i++) hotbarIdx.push(i)
  await drawGroup(hotbarIdx, L.mainX, L.hotbarY, 9)

  return canvas.toBuffer('image/png')
}

async function commandInventory (currentBot, username) {
  if (invBusy) {
    sendPrivateMessage(currentBot, username, 'Inventory render already running.', true)
    return
  }
  invBusy = true
  try {
    const buffer = await renderInventoryImage(currentBot)
    if (!buffer) {
      sendPrivateMessage(currentBot, username,
        'Inventory render unavailable (missing canvas / minecraft-assets).', true)
      return
    }
    try { fs.mkdirSync(CONFIG.invDir, { recursive: true }) } catch {}
    const fileName = `inv_${Date.now()}.png`
    const filePath = path.join(CONFIG.invDir, fileName)
    fs.writeFileSync(filePath, buffer)
    sendPrivateMessage(currentBot, username, `Inventory saved: ${fileName}`, true)
    log('INV', `Saved to ${filePath}`)
  } catch (error) {
    sendPrivateMessage(currentBot, username, `Inventory render failed: ${error.message}`, true)
  } finally {
    invBusy = false
  }
}

// ============================================================
// OWNER SERVER COMMANDS
// ============================================================

const BLOCKED_OWNER_COMMANDS = new Set([
  'register', 'login', 'changepassword', 'changepass', 'changepw',
  'unregister', 'logout', '2fa', 'setpassword', 'email'
])

function getBaseCommand (serverCommand) {
  const m = serverCommand.match(/^\/(\w+)/)
  return m ? m[1].toLowerCase() : ''
}

function isBlockedOwnerCommand (serverCommand) {
  return BLOCKED_OWNER_COMMANDS.has(getBaseCommand(serverCommand))
}

function commandRunOwnerCommand (currentBot, username, rawText) {
  const now = Date.now()
  if (now - lastOwnerCommandAt < 1500) {
    messageOwner(currentBot, 'Slow down, wait a moment before another command.')
    return
  }
  lastOwnerCommandAt = now

  const argsText = rawText.replace(new RegExp(`^${escapeRegExp(CONFIG.chatPrefix)}command\\s+`, 'i'), '').trim()
  if (!argsText) {
    messageOwner(currentBot, `Usage: ${CONFIG.chatPrefix}command /<server-command>`)
    return
  }
  const serverCommand = argsText.startsWith('/') ? argsText : `/${argsText}`
  if (serverCommand.length > 240) {
    messageOwner(currentBot, 'Command is too long. Maximum: 240 characters.')
    return
  }
  if (isBlockedOwnerCommand(serverCommand)) {
    log('SECURITY', `Blocked sensitive command from chat: ${getBaseCommand(serverCommand)}`)
    messageOwner(currentBot, 'This authentication command is blocked for account safety.')
    return
  }

  section('OWNER SERVER COMMAND')
  log('OWNER', `${username} requested: ${serverCommand}`)
  enqueueChat(currentBot, serverCommand, { priority: true, type: 'OWNER-COMMAND' })
}

// ============================================================
// FARM: Smooth-Stone system
// ============================================================

const FUEL_BURN_VALUE = {
  coal_block: 80,
  blaze_rod: 12,
  coal: 8,
  charcoal: 8,
  dried_kelp_block: 10,
  lava_bucket: 100
}

const FUEL_ITEMS = new Set([
  'coal', 'charcoal', 'coal_block', 'blaze_rod', 'dried_kelp_block',
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log',
  'dark_oak_log', 'mangrove_log', 'cherry_log',
  'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks',
  'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks', 'bamboo'
])

const STORAGE_BLOCKS = new Set([
  'chest', 'trapped_chest', 'barrel',
  'shulker_box', 'white_shulker_box', 'orange_shulker_box', 'magenta_shulker_box',
  'light_blue_shulker_box', 'yellow_shulker_box', 'lime_shulker_box',
  'pink_shulker_box', 'gray_shulker_box', 'light_gray_shulker_box',
  'cyan_shulker_box', 'purple_shulker_box', 'blue_shulker_box',
  'brown_shulker_box', 'green_shulker_box', 'red_shulker_box', 'black_shulker_box'
])

// blocks that are impossible or dangerous to mine
const NO_DIG_BLOCKS = new Set([
  'air', 'cave_air', 'void_air', 'lava', 'water', 'bedrock', 'barrier',
  'end_portal', 'end_portal_frame', 'nether_portal', 'obsidian',
  'crying_obsidian', 'reinforced_deepslate', 'command_block', 'structure_block'
])

// pure stone-family blocks we actually want to mine (smooth-stone input)
const STONE_FAMILY = new Set([
  'stone', 'cobblestone', 'deepslate', 'tuff', 'diorite', 'andesite', 'granite'
])

// items that just clog the inventory — tossed before mining starts
const JUNK_ITEMS = new Set([
  'dirt', 'coarse_dirt', 'rooted_dirt', 'mud', 'grass_block', 'sand', 'red_sand',
  'gravel', 'flint', 'clay_ball', 'diorite', 'andesite', 'granite', 'tuff',
  'calcite', 'rotten_flesh', 'bone', 'string', 'spider_eye', 'gunpowder',
  'arrow', 'egg', 'snowball', 'seeds', 'wheat_seeds', 'pumpkin_seeds',
  'melon_seeds', 'beetroot_seeds', 'torch', 'stick', 'feather', 'leather',
  'red_mushroom', 'brown_mushroom', 'sugar_cane', 'kelp', 'slime_ball'
])

// blocks the miner must NEVER touch (base machines + storage)
const PROTECTED_BLOCKS = new Set([
  'furnace', 'blast_furnace', 'smoker', 'crafting_table',
  'chest', 'trapped_chest', 'barrel', 'hopper', 'dropper', 'dispenser',
  'shulker_box', 'white_shulker_box', 'orange_shulker_box', 'magenta_shulker_box',
  'light_blue_shulker_box', 'yellow_shulker_box', 'lime_shulker_box',
  'pink_shulker_box', 'gray_shulker_box', 'light_gray_shulker_box',
  'cyan_shulker_box', 'purple_shulker_box', 'blue_shulker_box',
  'brown_shulker_box', 'green_shulker_box', 'red_shulker_box', 'black_shulker_box',
  'spawner', 'beacon', 'anvil', 'enchanting_table', 'ender_chest',
  'sign', 'oak_sign', 'spruce_sign', 'birch_sign', 'jungle_sign', 'acacia_sign',
  'dark_oak_sign', 'mangrove_sign', 'cherry_sign', 'bamboo_sign', 'crimson_sign', 'warped_sign'
])

// -------------- memory persistence --------------

function loadFarmMemory () {
  try {
    if (fs.existsSync(CONFIG.farmSaveFile)) {
      const raw = fs.readFileSync(CONFIG.farmSaveFile, 'utf8')
      const data = JSON.parse(raw)
      farmMemory = {
        furnaces: data.furnaces || [],
        blastFurnaces: data.blastFurnaces || [],
        fuelChests: data.fuelChests || [],
        pickaxeChests: data.pickaxeChests || [],
        craftingTables: data.craftingTables || [],
        emptyChests: data.emptyChests || []
      }
      log('FARM', 'Memory loaded from disk')
    }
  } catch (error) {
    log('FARM', `Could not load memory: ${error.message}`)
  }
}

function saveFarmMemory () {
  try {
    fs.writeFileSync(CONFIG.farmSaveFile, JSON.stringify(farmMemory, null, 2))
  } catch (error) {
    log('FARM', `Could not save memory: ${error.message}`)
  }
}

function posKey (p) {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
}

function rememberPos (bucket, pos) {
  if (!pos) return
  const key = posKey(pos)
  if (!farmMemory[bucket].some(p => posKey(p) === key)) {
    farmMemory[bucket].push({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) })
    saveFarmMemory()
  }
}

function forgetPos (bucket, pos) {
  if (!pos) return
  const key = posKey(pos)
  farmMemory[bucket] = farmMemory[bucket].filter(p => posKey(p) !== key)
  saveFarmMemory()
}

// -------------- helpers --------------

function toVec3 (p) {
  if (Vec3) return new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

function distXZ (a, b) {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dz * dz)
}

async function walkTo (currentBot, target, distance = 1, timeoutMs = 60_000) {
  if (!pathfinderAvailable()) throw new Error('Pathfinder not ready')
  const { goals } = pathfinderPlugin
  const goal = new goals.GoalNear(
    Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), distance)

  const movements = buildMovements(currentBot, { canDig: false })
  currentBot.pathfinder.setMovements(movements)
  setPhysics(currentBot, true)

  let lastPos = currentBot.entity.position.clone()
  let lastMoveAt = Date.now()

  const stuckCheck = setInterval(() => {
    if (!currentBot.entity) return
    const now = Date.now()
    if (currentBot.entity.position.distanceTo(lastPos) > 0.5) {
      lastPos = currentBot.entity.position.clone()
      lastMoveAt = now
      return
    }
    if (now - lastMoveAt > 8000) {
      try { currentBot.setControlState('jump', true) } catch {}
      setTimeout(() => { try { currentBot.setControlState('jump', false) } catch {} }, 400)
      lastMoveAt = now
    }
  }, 1500)

  try {
    const travel = currentBot.pathfinder.goto(goal)
    const timeout = new Promise((_, reject) => {
      const h = setTimeout(() => {
        try { currentBot.pathfinder.setGoal(null) } catch {}
        reject(new Error('walkTo timeout'))
      }, timeoutMs)
      travel.finally(() => clearTimeout(h)).catch(() => {})
    })
    await Promise.race([travel, timeout])
  } finally {
    clearInterval(stuckCheck)
    stopMovement(currentBot)
  }
}

function countItems (currentBot, names) {
  const set = Array.isArray(names) ? new Set(names) : new Set([names])
  return currentBot.inventory.items()
    .filter(it => set.has(it.name))
    .reduce((s, it) => s + it.count, 0)
}

function botInventoryNearlyFull (currentBot) {
  const items = currentBot.inventory.items()
  return items.length >= 34
}

// free inventory slots (excluding armor/offhand)
function freeInventorySlots (currentBot) {
  const items = currentBot.inventory.items()
  return 36 - items.length
}

// how many stone items we still want this cycle
function stoneNeeded (currentBot, targetStacks) {
  const target = targetStacks * 64
  const have = countItems(currentBot, ['stone'])
  return Math.max(0, target - have)
}

// toss junk items out of the inventory so pure stone has room
// (one stack of a bridge-capable block is ALWAYS kept for lava bridging)
async function clearJunkItems (currentBot) {
  let tossed = 0
  let bridgeStackKept = false
  const junk = currentBot.inventory.items().filter(it => JUNK_ITEMS.has(it.name))
  for (const it of junk) {
    if (farmStopRequested) return tossed
    if (!bridgeStackKept && BRIDGE_ITEMS.has(it.name)) {
      bridgeStackKept = true
      continue // keep one filler stack for bridging over lava / holes
    }
    try {
      await currentBot.tossStack(it)
      tossed += it.count
      await sleep(150)
    } catch {}
  }
  if (tossed > 0) {
    log('FARM', `Tossed ${tossed} junk items (kept 1 bridge stack)`)
  }
  return tossed
}

// ---------- ground / lava safety ----------
function blockIsLava (b) {
  return b && (b.name === 'lava' || b.name === 'flowing_lava')
}

// is it safe to stand at (x,y,z)? checks the block under feet + around it
function isSafeToStand (currentBot, pos) {
  const floor = currentBot.blockAt(pos.offset(0, -1, 0))
  if (!floor || floor.boundingBox === 'empty') return false        // hole
  if (blockIsLava(floor)) return false
  const feet = currentBot.blockAt(pos)
  if (feet && blockIsLava(feet)) return false
  const head = currentBot.blockAt(pos.offset(0, 1, 0))
  if (head && blockIsLava(head)) return false
  return true
}

// the block the bot would step onto if it moved forward one block
function nextStepIsSafe (currentBot, dx, dz, dropY = 0) {
  const base = currentBot.entity.position.floored()
  const target = base.offset(dx, dropY, dz)
  return isSafeToStand(currentBot, target)
}

// ---------- bridging material (kept in JUNK_ITEMS, one stack spared) ----------

const BRIDGE_ITEMS = new Set([
  'cobblestone', 'cobbled_deepslate', 'dirt', 'coarse_dirt', 'netherrack',
  'sand', 'gravel', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate',
  'blackstone', 'basalt', 'end_stone', 'smooth_stone', 'stone'
])

function findBridgeItem (currentBot) {
  return currentBot.inventory.items().find(it => BRIDGE_ITEMS.has(it.name) && it.count > 1) || null
}

// place a filler block at pos using an adjacent reference block face
async function placeBlockAt (currentBot, pos) {
  const item = findBridgeItem(currentBot)
  if (!item) return false

  const neighbors = [
    [0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]
  ]
  let refBlock = null
  let faceVec = null
  for (const [dx, dy, dz] of neighbors) {
    const b = currentBot.blockAt(pos.offset(dx, dy, dz))
    if (b && b.boundingBox === 'block') {
      refBlock = b
      faceVec = pos.offset(-dx, -dy, -dz).minus(pos.offset(dx, dy, dz))
      // face from reference block toward target position
      faceVec = pos.minus(refBlock.position)
      break
    }
  }
  if (!refBlock || !faceVec) return false

  try {
    sanitizeItem(item)
    await currentBot.equip(item, 'hand')
  } catch { return false }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await currentBot.lookAt(pos.offset(0.5, 0.5, 0.5), true)
      await currentBot.placeBlock(refBlock, faceVec)
      return true
    } catch (error) {
      if (attempt === 2) {
        log('FARM-BRIDGE', `placeBlock failed: ${error.message}`)
      }
      await sleep(150)
    }
  }
  return false
}

// make the next step safe: bridge over lava / holes in the way
async function bridgeNextStep (currentBot, dx, dz, dropY = 0) {
  const base = currentBot.entity.position.floored()
  const target = base.offset(dx, dropY, dz)
  if (isSafeToStand(currentBot, target)) return true

  const floor = currentBot.blockAt(target.offset(0, -1, 0))
  const feet = currentBot.blockAt(target)
  const head = currentBot.blockAt(target.offset(0, 1, 0))

  // 1) lava at feet/head level → plug it with a filler block
  for (const pos of [target, target.offset(0, 1, 0)]) {
    const b = currentBot.blockAt(pos)
    if (b && blockIsLava(b)) {
      log('FARM-BRIDGE', `Plugging lava at ${pos.x} ${pos.y} ${pos.z}`)
      const ok = await placeBlockAt(currentBot, pos)
      if (!ok) return false
    }
  }

  // 2) missing / lava floor → bridge it
  const floorNow = currentBot.blockAt(target.offset(0, -1, 0))
  if (!floorNow || floorNow.boundingBox === 'empty' || blockIsLava(floorNow)) {
    log('FARM-BRIDGE', `Bridging over gap at ${target.x} ${target.y - 1} ${target.z}`)
    const ok = await placeBlockAt(currentBot, target.offset(0, -1, 0))
    if (!ok) return false
  }

  return isSafeToStand(currentBot, target)
}

function botHasPickaxe (currentBot) {
  return currentBot.inventory.items().some(it => /pickaxe/.test(it.name))
}

async function equipBestPickaxe (currentBot) {
  const order = [
    'netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe',
    'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe'
  ]
  const items = currentBot.inventory.items()
  for (const name of order) {
    const p = items.find(it => it.name === name)
    if (p) {
      sanitizeItem(p)
      try {
        await currentBot.equip(p, 'hand')
        return true
      } catch {}
    }
  }
  return false
}

function fuelUnitsInInventory (currentBot) {
  let units = 0
  for (const it of currentBot.inventory.items()) {
    if (!FUEL_ITEMS.has(it.name)) continue
    units += (FUEL_BURN_VALUE[it.name] || 1) * it.count
  }
  return units
}

function sortedFuelStacks (currentBot) {
  return currentBot.inventory.items()
    .filter(it => FUEL_ITEMS.has(it.name))
    .sort((a, b) => (FUEL_BURN_VALUE[b.name] || 1) - (FUEL_BURN_VALUE[a.name] || 1))
}

// ============================================================
// FARM — PACKET-BASED MINING (verified on Paper 1.21.4)
// bot.dig() crashes with "enchantments is not iterable" on this
// version's component-based items, so packet digging is PRIMARY.
// ============================================================

function safeDigTimeMs (currentBot, block) {
  try {
    sanitizeItem(currentBot.heldItem)
    const t = currentBot.digTime(block)
    if (Number.isFinite(t) && t > 0) return Math.min(Math.max(t, 300), 5000)
  } catch {}
  const n = block?.name || ''
  if (n === 'stone' || n.endsWith('_stone') || n === 'cobblestone' || n === 'deepslate') return 400
  if (n.includes('dirt') || n.includes('sand') || n.includes('gravel')) return 300
  return 600
}

function blockIsAir (b) {
  return !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air'
}

async function packetDig (currentBot, pos) {
  const block = currentBot.blockAt(pos)
  if (!block || NO_DIG_BLOCKS.has(block.name) || PROTECTED_BLOCKS.has(block.name)) return false
  if (block.boundingBox === 'empty') return false

  const digMs = safeDigTimeMs(currentBot, block)

  for (let attempt = 0; attempt < 2; attempt++) {
    if (farmStopRequested) return false
    try {
      currentBot._client.write('block_dig', {
        status: 0, location: block.position, face: 1, sequence: 0
      })
    } catch (error) {
      log('FARM-MINE', `packetDig start failed: ${error.message}`)
      return false
    }

    await sleep(digMs)

    try {
      currentBot._client.write('block_dig', {
        status: 2, location: block.position, face: 1, sequence: 0
      })
    } catch (error) {
      log('FARM-MINE', `packetDig stop failed: ${error.message}`)
      return false
    }

    // verify the block is actually gone
    const deadline = Date.now() + 2500
    while (Date.now() < deadline) {
      if (blockIsAir(currentBot.blockAt(pos))) return true
      await sleep(60)
    }
    log('FARM-MINE', `Retry dig ${block.name} (attempt ${attempt + 1})`)
  }

  log('FARM-MINE', `Could not break ${block.name}`)
  return false
}

async function digBlockSafe (currentBot, block) {
  if (!block || NO_DIG_BLOCKS.has(block.name) || PROTECTED_BLOCKS.has(block.name)) return false
  if (block.boundingBox === 'empty') return false

  sanitizeItem(currentBot.heldItem)

  try {
    await currentBot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
  } catch {}

  // PRIMARY: raw packet dig (immune to the enchantments crash)
  const ok = await packetDig(currentBot, block.position)
  if (ok) return true

  // LAST RESORT: try mineflayer dig once (may work if item was sanitized)
  try {
    await currentBot.dig(block)
    return true
  } catch (error) {
    log('FARM-MINE', `bot.dig failed too: ${error.message}`)
    return false
  }
}

// dig the 3x3 wall one block ahead of base (dy 0..2, side -1..+1)
async function digFace (currentBot, base, dx, dz, sx, sz) {
  for (let dy = 2; dy >= 0; dy--) {
    for (let s = -1; s <= 1; s++) {
      if (farmStopRequested) return
      const pos = base.offset(dx + s * sx, dy, dz + s * sz)
      const b = currentBot.blockAt(pos)
      if (b && !NO_DIG_BLOCKS.has(b.name) && !PROTECTED_BLOCKS.has(b.name)) {
        await digBlockSafe(currentBot, b)
      }
    }
  }
}

// dig out whatever solid block is in front at feet/head level
async function clearObstacleAhead (currentBot, dx, dz) {
  const base = currentBot.entity.position.floored()
  for (const dy of [0, 1]) {
    const b = currentBot.blockAt(base.offset(dx, dy, dz))
    if (b && !blockIsAir(b) && b.boundingBox === 'block' &&
        !NO_DIG_BLOCKS.has(b.name) && !PROTECTED_BLOCKS.has(b.name)) {
      await digBlockSafe(currentBot, b)
    }
  }
}

// one verified step forward (physics must be ON)
// Fixes: obstacle at feet level is DUG first; jump fires with a short
// pre-jump delay so the bot actually lands on the block instead of
// hovering mid-air against the wall; sprint+jump as last resort.
async function stepForward (currentBot, targetPos, dir = null) {
  setPhysics(currentBot, true)

  let dx = 0
  let dz = 0
  if (dir) { dx = dir.dx; dz = dir.dz }
  else {
    const base = currentBot.entity.position.floored()
    dx = Math.sign(Math.floor(targetPos.x) - base.x)
    dz = Math.sign(Math.floor(targetPos.z) - base.z)
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    if (farmStopRequested) return false
    const before = currentBot.entity.position.clone()
    try { await currentBot.lookAt(targetPos.offset(0.5, 0.8, 0.5), true) } catch {}
    currentBot.setControlState('forward', true)
    await sleep(450)
    currentBot.setControlState('forward', false)
    await sleep(120)
    if (currentBot.entity.position.distanceTo(before) > 0.4) return true

    // stuck: a block may be sitting at feet/head level — dig it out
    await clearObstacleAhead(currentBot, dx, dz)

    // jump-nudge with PROPER timing: jump first, move while airborne
    currentBot.setControlState('jump', true)
    await sleep(120)
    currentBot.setControlState('forward', true)
    await sleep(420)
    currentBot.setControlState('forward', false)
    currentBot.setControlState('jump', false)
    await sleep(150)
    if (currentBot.entity.position.distanceTo(before) > 0.4) return true

    // final attempt: sprint + jump
    currentBot.setControlState('sprint', true)
    currentBot.setControlState('jump', true)
    await sleep(100)
    currentBot.setControlState('forward', true)
    await sleep(450)
    currentBot.setControlState('forward', false)
    currentBot.setControlState('jump', false)
    currentBot.setControlState('sprint', false)
    await sleep(150)
    if (currentBot.entity.position.distanceTo(before) > 0.4) return true
  }
  return false
}

// ---------- direction & corridor safety ----------

const MINE_DIRECTIONS = [
  { dx: 0, dz: 1 },
  { dx: 1, dz: 0 },
  { dx: 0, dz: -1 },
  { dx: -1, dz: 0 }
]

// scan the whole 3x3 corridor (dy -1..2) ahead for protected blocks
function corridorProtectedBlock (currentBot, base, dx, dz, sx, sz, depth) {
  for (let f = 1; f <= depth; f++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let s = -1; s <= 1; s++) {
        const b = currentBot.blockAt(base.offset(dx * f + s * sx, dy, dz * f + s * sz))
        if (b && PROTECTED_BLOCKS.has(b.name)) return b
      }
    }
  }
  return null
}

// pick a facing direction whose corridor is clear of base machines
async function chooseMiningDirection (currentBot, depth) {
  const base = currentBot.entity.position.floored()
  for (const d of MINE_DIRECTIONS) {
    const sx = -d.dz
    const sz = d.dx
    const blocker = corridorProtectedBlock(currentBot, base, d.dx, d.dz, sx, sz, depth)
    if (!blocker) {
      const lookTarget = base.offset(d.dx * 5, 1.6, d.dz * 5).offset(0.5, 0, 0.5)
      try { await currentBot.lookAt(lookTarget, true) } catch {}
      log('FARM', `Mining direction chosen: dx=${d.dx} dz=${d.dz}`)
      return { dx: d.dx, dz: d.dz, sx, sz }
    }
    log('FARM', `Direction dx=${d.dx} dz=${d.dz} blocked by ${blocker.name} — rotating`)
  }
  return null
}

// walk AWAY from the base anchor before starting the mine
async function goToMiningSpot (currentBot, minDistance = 8) {
  if (!farmBaseAnchor) return
  const bp = currentBot.entity.position
  const awayX = bp.x - farmBaseAnchor.x
  const awayZ = bp.z - farmBaseAnchor.z
  const dist = Math.hypot(awayX, awayZ)
  if (dist >= minDistance) return

  const len = dist || 1
  const ux = dist ? awayX / len : 1
  const uz = dist ? awayZ / len : 0
  const target = {
    x: Math.floor(bp.x + ux * (minDistance + 2 - dist)),
    y: Math.floor(bp.y),
    z: Math.floor(bp.z + uz * (minDistance + 2 - dist))
  }
  log('FARM', `Moving ${Math.round(minDistance + 2 - dist)} blocks away from base before mining`)
  try { await walkTo(currentBot, target, 1, 30_000) } catch (e) {
    log('FARM', `goToMiningSpot: ${e.message}`)
  }
  setPhysics(currentBot, true)
}

// staircase down ONLY until pure stone-family blocks are reached (max 24 deep)
async function digStairsDown (currentBot, facing) {
  setPhysics(currentBot, true)
  const { dx, dz, sx, sz } = facing
  const maxDepth = 24

  for (let i = 0; i < maxDepth; i++) {
    if (farmStopRequested) return
    const base = currentBot.entity.position.floored()

    // already surrounded by mineable stone? → stop going down
    const below = currentBot.blockAt(base.offset(0, -1, 0))
    const ahead = currentBot.blockAt(base.offset(dx, 0, dz))
    if (
      (below && STONE_FAMILY.has(below.name)) ||
      (ahead && STONE_FAMILY.has(ahead.name))
    ) {
      log('FARM', `Reached stone layer after ${i} stair steps`)
      notifyOwner(currentBot, 'FARM', `Reached stone at depth ${i}`)
      return
    }

    // safety: lava or a hole below → BRIDGE it instead of giving up
    if (!nextStepIsSafe(currentBot, dx, dz, -1)) {
      log('FARM', 'Lava/hole ahead on staircase — bridging over it')
      notifyOwner(currentBot, 'FARM', 'Lava/cave on the staircase, bridging over it...')
      const bridged = await bridgeNextStep(currentBot, dx, dz, -1)
      if (!bridged) {
        log('FARM', 'Could not bridge staircase step — mining right here')
        notifyOwner(currentBot, 'FARM', 'No bridge blocks left! Mining right here instead.')
        return
      }
    }

    // 3x3 face ahead
    await digFace(currentBot, base, dx, dz, sx, sz)

    // 3-wide step one block below-ahead
    for (let s = -1; s <= 1; s++) {
      const pos = base.offset(dx + s * sx, -1, dz + s * sz)
      const b = currentBot.blockAt(pos)
      if (b && !NO_DIG_BLOCKS.has(b.name) && !PROTECTED_BLOCKS.has(b.name)) {
        await digBlockSafe(currentBot, b)
      }
    }

    await stepForward(currentBot, base.offset(dx, -1, dz), { dx, dz })

    if (botInventoryNearlyFull(currentBot)) {
      notifyOwner(currentBot, 'FARM', 'Inventory full during staircase, heading to smelt')
      return
    }
  }
}

// straight 3x3 tunnel until we carry targetStacks of pure stone
async function digTunnel3x3 (currentBot, facing, targetStacks) {
  setPhysics(currentBot, true)
  const { dx, dz, sx, sz } = facing
  const maxSteps = 160

  for (let step = 0; step < maxSteps; step++) {
    if (farmStopRequested) return
    const base = currentBot.entity.position.floored()

    // lava / hole ahead → BRIDGE over it, keep the tunnel going
    if (!nextStepIsSafe(currentBot, dx, dz, 0)) {
      log('FARM', 'Lava/cave ahead in tunnel — bridging over it')
      taskDetail('mining', 'bridging over lava')
      const bridged = await bridgeNextStep(currentBot, dx, dz, 0)
      if (!bridged) {
        log('FARM', 'Bridge failed (no filler blocks) — tunnel stopped')
        notifyOwner(currentBot, 'FARM', 'Tunnel stopped: lava/hole ahead and no blocks to bridge with.')
        return
      }
      notifyOwner(currentBot, 'FARM', 'Bridged over lava/cave, continuing to mine')
    }

    await digFace(currentBot, base, dx, dz, sx, sz)
    await stepForward(currentBot, base.offset(dx, 0, dz), { dx, dz })

    const stoneCount = countItems(currentBot, ['stone'])
    if (stoneCount >= targetStacks * 64) {
      notifyOwner(currentBot, 'FARM', `Target reached: ${stoneCount} stone (${targetStacks} stacks)`)
      return
    }

    if (freeInventorySlots(currentBot) <= 2) {
      // too clogged even after junk toss → bail out
      notifyOwner(currentBot, 'FARM', 'Inventory full, returning to base to smelt')
      return
    }

    if (step % 16 === 0) {
      notifyOwner(currentBot, 'FARM', `Mining ${step} | stone=${stoneCount}/${targetStacks * 64}`)
    }
  }
}

// -------------- SCAN (memory-first, minimal walking) --------------

async function scanEnvironment (currentBot) {
  const radius = CONFIG.farmScanRadius
  const botPos = currentBot.entity.position

  const targets = {
    furnaces: [],
    blastFurnaces: [],
    fuelChests: [],
    pickaxeChests: [],
    craftingTables: [],
    emptyChests: []
  }

  const registry = currentBot.registry
  const idOf = n => registry.blocksByName[n]?.id

  const furIds = [idOf('furnace')].filter(Boolean)
  const blastIds = [idOf('blast_furnace')].filter(Boolean)
  const craftIds = [idOf('crafting_table')].filter(Boolean)

  if (furIds.length) {
    targets.furnaces = currentBot.findBlocks({ matching: furIds, maxDistance: radius, count: 64 })
  }
  if (blastIds.length) {
    targets.blastFurnaces = currentBot.findBlocks({ matching: blastIds, maxDistance: radius, count: 64 })
  }
  if (craftIds.length) {
    targets.craftingTables = currentBot.findBlocks({ matching: craftIds, maxDistance: radius, count: 5 })
  }

  targets.furnaces.forEach(p => rememberPos('furnaces', p))
  targets.blastFurnaces.forEach(p => rememberPos('blastFurnaces', p))
  targets.craftingTables.forEach(p => rememberPos('craftingTables', p))

  const allFurnaces = [...targets.furnaces, ...targets.blastFurnaces]
  allFurnaces.sort((a, b) => a.distanceTo(botPos) - b.distanceTo(botPos))
  farmBaseAnchor = allFurnaces[0] || botPos.floored()

  const inRange = p => distXZ(p, botPos) <= radius && Math.abs(p.y - botPos.y) <= 16
  const validStorage = p => {
    const b = currentBot.blockAt(toVec3(p))
    return Boolean(b && STORAGE_BLOCKS.has(b.name))
  }

  for (const bucket of ['fuelChests', 'pickaxeChests', 'emptyChests']) {
    for (const p of farmMemory[bucket]) {
      if (targets[bucket].length) break
      if (inRange(p) && validStorage(p)) targets[bucket].push(p)
    }
  }

  const missing = !targets.fuelChests.length || !targets.pickaxeChests.length || !targets.emptyChests.length
  if (missing) {
    const storageIds = [...STORAGE_BLOCKS].map(idOf).filter(Boolean)
    if (storageIds.length) {
      const found = currentBot.findBlocks({ matching: storageIds, maxDistance: radius, count: 24 })
      const known = new Set()
      for (const bucket of ['fuelChests', 'pickaxeChests', 'emptyChests']) {
        targets[bucket].forEach(p => known.add(posKey(p)))
      }
      const candidates = found
        .filter(p => !known.has(posKey(p)))
        .sort((a, b) => a.distanceTo(botPos) - b.distanceTo(botPos))
        .slice(0, 8)

      for (const pos of candidates) {
        if (farmStopRequested) break
        if (targets.fuelChests.length && targets.pickaxeChests.length && targets.emptyChests.length) break
        try {
          await walkTo(currentBot, pos, 3, 25_000)
          setPhysics(currentBot, true)
          const block = currentBot.blockAt(toVec3(pos))
          if (!block || !STORAGE_BLOCKS.has(block.name)) continue

          const container = await currentBot.openContainer(block).catch(() => null)
          if (!container) continue

          let contents = []
          try {
            contents = container.containerItems ? container.containerItems() : container.items()
          } catch {}

          let hasFuel = false
          let hasPick = false
          for (const it of contents) {
            if (FUEL_ITEMS.has(it.name)) hasFuel = true
            if (it.name === 'netherite_pickaxe') hasPick = true
          }
          try { container.close() } catch {}

          if (hasPick && !targets.pickaxeChests.length) {
            targets.pickaxeChests.push(pos); rememberPos('pickaxeChests', pos)
          } else if (hasFuel && !targets.fuelChests.length) {
            targets.fuelChests.push(pos); rememberPos('fuelChests', pos)
          } else if (contents.length === 0 && !targets.emptyChests.length) {
            targets.emptyChests.push(pos); rememberPos('emptyChests', pos)
          }
        } catch (error) {
          log('FARM-SCAN', `Skip storage: ${error.message}`)
        }
      }
    }
  }

  if (!targets.emptyChests.length) {
    if (targets.fuelChests.length) targets.emptyChests.push(targets.fuelChests[0])
    else if (targets.pickaxeChests.length) targets.emptyChests.push(targets.pickaxeChests[0])
    if (targets.emptyChests.length) {
      log('FARM-SCAN', 'No dedicated empty chest → fallback to a known chest')
    }
  }

  farmScan = targets
  return targets
}

// -------------- CHEST HELPERS --------------

async function openBlockAt (currentBot, pos) {
  await walkTo(currentBot, pos, 3, 25_000)
  setPhysics(currentBot, true)
  const block = currentBot.blockAt(toVec3(pos))
  if (!block) throw new Error('Block not found at position')
  return currentBot.openContainer(block)
}

async function withdrawItemFromChest (currentBot, chestPos, predicate, maxCount = 1) {
  const container = await openBlockAt(currentBot, chestPos).catch(() => null)
  if (!container) return 0
  let taken = 0
  try {
    let items = []
    try {
      items = container.containerItems ? container.containerItems() : container.items()
    } catch {}
    items = items
      .filter(predicate)
      .sort((a, b) => (FUEL_BURN_VALUE[b.name] || 1) - (FUEL_BURN_VALUE[a.name] || 1))
    for (const it of items) {
      if (taken >= maxCount) break
      const amount = Math.min(it.count, maxCount - taken)
      try {
        await container.withdraw(it.type, null, amount)
        taken += amount
      } catch (error) {
        log('FARM', `Withdraw failed: ${error.message}`)
        break
      }
    }
  } finally {
    try { container.close() } catch {}
  }
  return taken
}

async function depositAllMatchingIntoChest (currentBot, chestPos, predicate) {
  const container = await openBlockAt(currentBot, chestPos).catch(() => null)
  if (!container) return 0
  let deposited = 0
  try {
    const items = currentBot.inventory.items().filter(predicate)
    for (const it of items) {
      try {
        await container.deposit(it.type, null, it.count)
        deposited += it.count
      } catch (error) {
        log('FARM', `Deposit failed: ${error.message}`)
        break
      }
    }
  } finally {
    try { container.close() } catch {}
  }
  return deposited
}

// -------------- FURNACE HELPERS --------------

function isFurnaceBlockName (name) {
  return name === 'furnace' || name === 'blast_furnace'
}

async function loadFurnace (currentBot, pos) {
  await walkTo(currentBot, pos, 2, 25_000)
  setPhysics(currentBot, true)

  const block = currentBot.blockAt(toVec3(pos))
  if (!block || !isFurnaceBlockName(block.name)) {
    return { input: 0, isBlast: false, broken: true }
  }
  const isBlast = block.name === 'blast_furnace'

  const furnace = await currentBot.openFurnace(block).catch(() => null)
  if (!furnace) return { input: 0, isBlast }

  let inputTotal = 0
  try {
    let inCount = 0
    try { inCount = furnace.inputItem()?.count || 0 } catch {}

    // only PURE stone — cobblestone smelts to stone, not smooth stone
    const stoneStacks = currentBot.inventory.items()
      .filter(it => it.name === 'stone')
    for (const st of stoneStacks) {
      if (inCount >= 64) break
      const amount = Math.min(st.count, 64 - inCount)
      try {
        await furnace.putInput(st.type, null, amount)
        inCount += amount
      } catch (error) {
        log('FARM', `putInput failed: ${error.message}`)
        break
      }
    }
    inputTotal = inCount

    let fuelCount = 0
    try { fuelCount = furnace.fuelItem()?.count || 0 } catch {}
    if (fuelCount < 16) {
      const fuels = sortedFuelStacks(currentBot)
      for (const fs of fuels) {
        if (fuelCount >= 16) break
        const amount = Math.min(fs.count, 16 - fuelCount)
        try {
          await furnace.putFuel(fs.type, null, amount)
          fuelCount += amount
        } catch (error) {
          log('FARM', `putFuel failed: ${error.message}`)
          break
        }
      }
    }
  } finally {
    try { furnace.close() } catch {}
  }
  return { input: inputTotal, isBlast, broken: false }
}

async function serviceFurnace (currentBot, pos) {
  await walkTo(currentBot, pos, 2, 25_000)
  setPhysics(currentBot, true)

  const block = currentBot.blockAt(toVec3(pos))
  if (!block || !isFurnaceBlockName(block.name)) {
    return { input: 0, output: 0, fuel: 0, collected: 0, broken: true }
  }

  const furnace = await currentBot.openFurnace(block).catch(() => null)
  if (!furnace) return { input: 0, output: 0, fuel: 0, collected: 0, broken: true }

  const res = { input: 0, output: 0, fuel: 0, collected: 0, broken: false }
  try {
    try { res.input = furnace.inputItem()?.count || 0 } catch {}
    try { res.fuel = furnace.fuelItem()?.count || 0 } catch {}

    // COLLECT EVERYTHING: loop until the output slot is really empty
    // (old code took ONE stack per visit → smooth stone piled up, e.g. 90)
    for (let grab = 0; grab < 8; grab++) {
      let out = null
      try { out = furnace.outputItem() } catch {}
      if (!out || out.count <= 0) break
      // if inventory is nearly full, stop — the farm loop will deposit first
      if (freeInventorySlots(currentBot) <= 1) break
      try {
        await furnace.takeOutput()
        res.collected += out.count
        res.output = 0
      } catch { break }
      await sleep(120)
    }

    if (res.input > 0 && res.fuel < 4) {
      const fuels = sortedFuelStacks(currentBot)
      for (const fs of fuels) {
        if (res.fuel >= 8) break
        const amount = Math.min(fs.count, 8 - res.fuel)
        try {
          await furnace.putFuel(fs.type, null, amount)
          res.fuel += amount
        } catch { break }
      }
    }
  } finally {
    try { furnace.close() } catch {}
  }
  return res
}

// -------------- FARM: pickaxe / fuel / smelt / deposit --------------

async function ensurePickaxe (currentBot, scan) {
  const hasNetherite = currentBot.inventory.items().some(it => it.name === 'netherite_pickaxe')
  if (hasNetherite) return true
  if (botHasPickaxe(currentBot)) return true

  const pickaxeChests = scan.pickaxeChests.length ? scan.pickaxeChests : farmMemory.pickaxeChests
  for (const chestPos of pickaxeChests) {
    if (farmStopRequested) return false
    const taken = await withdrawItemFromChest(currentBot, chestPos,
      it => it.name === 'netherite_pickaxe', 1)
    if (taken > 0) {
      notifyOwner(currentBot, 'FARM', 'Picked up Netherite Pickaxe (Silk Touch)')
      return true
    }
    forgetPos('pickaxeChests', chestPos)
  }
  return botHasPickaxe(currentBot)
}

async function ensureFuelInInventory (currentBot, scan, minUnits = 64) {
  if (fuelUnitsInInventory(currentBot) >= minUnits) return true

  const chests = scan.fuelChests.length ? scan.fuelChests : farmMemory.fuelChests
  for (const pos of chests) {
    if (farmStopRequested) return false
    const taken = await withdrawItemFromChest(currentBot, pos,
      it => FUEL_ITEMS.has(it.name), 32)
    if (taken > 0) {
      notifyOwner(currentBot, 'FARM', `Restocked fuel x${taken}`)
      return true
    }
    // a failed withdraw (full inventory / empty chest) no longer deletes the
    // chest from memory — next cycle may still find fuel in it
    log('FARM', `No fuel withdrawn from chest at ${posKey(pos)} (kept in memory)`)
  }
  return fuelUnitsInInventory(currentBot) >= 8
}

async function smeltAllStone (currentBot, scan) {
  const uniq = new Map()
  const addF = (p, isBlast) => {
    const k = posKey(p)
    if (!uniq.has(k)) uniq.set(k, { pos: p, isBlast })
  }
  scan.furnaces.forEach(p => addF(p, false))
  scan.blastFurnaces.forEach(p => addF(p, true))
  farmMemory.furnaces.forEach(p => addF(p, false))
  farmMemory.blastFurnaces.forEach(p => addF(p, true))

  const furnaces = [...uniq.values()]
  if (!furnaces.length) {
    notifyOwner(currentBot, 'FARM', 'No furnaces available!')
    return 0
  }

  // NOTE: fuel restock happens AFTER stone is loaded (see below), otherwise
  // a full stone inventory makes the withdraw fail and the chest was dropped
  // from memory — that is why fuel (planks etc.) never reached the furnaces.

  const loadedList = []
  let totalLoaded = 0
  let maxNormal = 0
  let maxBlast = 0

  for (const f of furnaces) {
    if (farmStopRequested) return 0
    const hasStone = currentBot.inventory.items()
      .some(it => it.name === 'stone')
    if (!hasStone) break

    const res = await loadFurnace(currentBot, f.pos)
    if (res.broken) {
      forgetPos(res.isBlast ? 'blastFurnaces' : 'furnaces', f.pos)
      continue
    }
    if (res.input > 0) {
      loadedList.push({ ...f, input: res.input })
      totalLoaded += res.input
      if (res.isBlast) maxBlast = Math.max(maxBlast, res.input)
      else maxNormal = Math.max(maxNormal, res.input)
    }
  }

  if (!loadedList.length) {
    notifyOwner(currentBot, 'FARM', 'No stone loaded into furnaces (inventory empty?)')
    return 0
  }

  // stone is loaded now → inventory has room again → restock fuel from chests
  await ensureFuelInInventory(currentBot, scan, 64)

  // second pass: push fuel into every loaded furnace that is still hungry
  for (const f of loadedList) {
    if (farmStopRequested) break
    if (fuelUnitsInInventory(currentBot) < 1) break
    try {
      await serviceFurnace(currentBot, f.pos)
    } catch (error) {
      log('FARM', `Fuel top-up error: ${error.message}`)
    }
  }

  const etaSec = Math.max(maxNormal * 10, maxBlast * 5)
  notifyOwner(currentBot, 'FARM',
    `Loaded ${totalLoaded} stone into ${loadedList.length}/${furnaces.length} furnaces. ETA ~${Math.max(1, Math.ceil(etaSec / 60))} min`)
  log('FARM', `Loaded ${totalLoaded} stone into ${loadedList.length} furnaces (ETA ${etaSec}s)`)

  const deadline = Date.now() + etaSec * 1000 + 240_000
  let collected = 0
  let cycles = 0

  while (!farmStopRequested && Date.now() < deadline) {
    await sleep(25_000)
    if (farmStopRequested) break
    cycles++

    let anyInput = false
    for (const f of loadedList) {
      if (farmStopRequested) break
      try {
        const st = await serviceFurnace(currentBot, f.pos)
        collected += st.collected
        if (st.input > 0) anyInput = true
      } catch (error) {
        log('FARM', `serviceFurnace error: ${error.message}`)
      }
    }

    if (cycles % 2 === 0) {
      notifyOwner(currentBot, 'FARM', `Smelting... collected ${collected}/${totalLoaded} so far`)
    }

    if (!anyInput) break
  }

  for (const f of loadedList) {
    if (farmStopRequested) break
    try {
      const st = await serviceFurnace(currentBot, f.pos)
      collected += st.collected
    } catch {}
  }

  notifyOwner(currentBot, 'FARM', `Smelting done. Collected ${collected} Smooth Stone`)
  return collected
}

async function depositSmoothStone (currentBot, scan) {
  const emptyChests = scan.emptyChests.length ? scan.emptyChests : farmMemory.emptyChests
  if (!emptyChests.length) {
    notifyOwner(currentBot, 'FARM', 'No output chest found! Keeping smooth stone in inventory.')
    return 0
  }
  let total = 0
  for (const pos of emptyChests) {
    if (farmStopRequested) break
    const deposited = await depositAllMatchingIntoChest(currentBot, pos,
      it => it.name === 'smooth_stone')
    if (deposited > 0) {
      total += deposited
      notifyOwner(currentBot, 'FARM', `Deposited ${deposited} Smooth Stone → output chest`)
    } else {
      forgetPos('emptyChests', pos)
    }
  }
  return total
}

// ============================================================
// MOB DEFENSE — flee to base, seal the tunnel, wait, resume
// ============================================================

const HOSTILE_MOBS = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray',
  'creeper', 'spider', 'cave_spider', 'witch', 'slime', 'phantom',
  'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'silverfish',
  'enderman', 'blaze', 'magma_cube', 'ghast', 'wither_skeleton',
  'hoglin', 'zoglin', 'piglin_brute', 'zombified_piglin', 'guardian',
  'elder_guardian', 'shulker', 'warden'
])

function nearestHostile (currentBot, maxDist = 8) {
  if (!currentBot?.entity) return null
  let best = null
  let bestDist = maxDist
  for (const entity of Object.values(currentBot.entities || {})) {
    if (!entity || !entity.position) continue
    const kind = String(entity.name || entity.mobType || '').toLowerCase()
    if (!HOSTILE_MOBS.has(kind)) continue
    const dist = entity.position.distanceTo(currentBot.entity.position)
    if (dist < bestDist) { best = entity; bestDist = dist }
  }
  return best
}

// place a 3x3 wall one block toward the threat so the mob cannot follow
async function wallOffTunnel (currentBot, threatPos) {
  if (!hasValidPosition(currentBot)) return
  const base = currentBot.entity.position.floored()
  let dx = Math.sign(base.x - Math.floor(threatPos.x))
  let dz = Math.sign(base.z - Math.floor(threatPos.z))
  if (dx === 0 && dz === 0) { dx = 0; dz = 1 }
  // perpendicular side vector of the wall
  const sx = -dz
  const sz = dx
  const wallBase = base.offset(-dx, 0, -dz) // one block toward the mob
  log('FLEE', `Sealing tunnel at ${wallBase.x} ${wallBase.y} ${wallBase.z}`)
  for (let dy = 0; dy <= 2; dy++) {
    for (let s = -1; s <= 1; s++) {
      const pos = wallBase.offset(s * sx, dy, s * sz)
      const b = currentBot.blockAt(pos)
      if (!b || !blockIsAir(b)) continue
      try { await placeBlockAt(currentBot, pos) } catch {}
      await sleep(120)
    }
  }
  // re-equip the pickaxe after walling
  await equipBestPickaxe(currentBot)
}

async function fleeFromMob (currentBot, threat) {
  if (fleeInProgress) return
  if (bot !== currentBot) return
  if (!loggedIn) return
  if (shuttingDown) return
  if (Date.now() - lastFleeAt < 15_000) return
  fleeInProgress = true
  lastFleeAt = Date.now()

  const threatName = threat?.name || 'hostile mob'
  taskStart('fleeing', 'Fleeing from mob', threatName)
  setActivity('Fleeing from mob', threatName)

  try {
    stopMovement(currentBot)
    try { currentBot.pathfinder?.setGoal(null) } catch {}
    log('FLEE', `${threatName} attacked the bot — falling back`)
    notifyOwner(currentBot, 'DANGER',
      `${threatName} is attacking me! Falling back and sealing the tunnel.`)

    const threatPos = threat?.position ? threat.position.clone() : null

    if (farmBaseAnchor && pathfinderAvailable() && hasValidPosition(currentBot)) {
      // step a few blocks toward base first, then wall the tunnel behind us
      const bp = currentBot.entity.position
      const stepTarget = {
        x: bp.x + Math.sign(farmBaseAnchor.x - bp.x) * 4,
        y: bp.y,
        z: bp.z + Math.sign(farmBaseAnchor.z - bp.z) * 4
      }
      try { await walkTo(currentBot, stepTarget, 1, 10_000) } catch {}
      if (threatPos) await wallOffTunnel(currentBot, threatPos)
      try { await walkTo(currentBot, farmBaseAnchor, 3, 60_000) } catch {}
    } else if (threatPos && pathfinderAvailable() && hasValidPosition(currentBot)) {
      // no base known: just run the other way
      const bp = currentBot.entity.position
      const away = {
        x: bp.x + (Math.sign(bp.x - threatPos.x) || 1) * 12,
        y: bp.y,
        z: bp.z + (Math.sign(bp.z - threatPos.z) || 0) * 12
      }
      try { await walkTo(currentBot, away, 2, 20_000) } catch {}
    }

    // wait until no hostile is nearby (max 60s), then go back to work
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline && !farmStopRequested && !shuttingDown) {
      if (bot !== currentBot) return
      if (!nearestHostile(currentBot, 12)) break
      await sleep(3000)
    }
    notifyOwner(currentBot, 'SAFE', 'Area is clear. Going back to work.')
    setActivity('Idle', 'back from flee')
  } catch (error) {
    log('FLEE', `Error: ${error.message}`)
  } finally {
    taskDone('fleeing')
    fleeInProgress = false
  }
}

async function waitForFleeEnd (currentBot) {
  if (!fleeInProgress) return
  notifyOwner(currentBot, 'FARM', 'Waiting until the area is safe...')
  while (fleeInProgress && !farmStopRequested && !shuttingDown) {
    await sleep(1000)
  }
}

// -------------- MAIN FARM LOOP --------------

async function farmSmoothStoneLoop (currentBot) {
  section('!farm Smooth-Stone STARTED')
  notifyOwner(currentBot, 'FARM', 'Starting Smooth-Stone production')
  setActivity('Farm: starting', 'smooth-stone')
  taskIdle('idle')

  loadFarmMemory()

  try {
    notifyOwner(currentBot, 'FARM', `Scanning ${CONFIG.farmScanRadius} blocks around me`)
    setActivity('Scanning base area', 'furnaces / chests')
    let scan = await scanEnvironment(currentBot)

    const totalFurnaces = scan.furnaces.length + scan.blastFurnaces.length
    if (totalFurnaces === 0) {
      notifyOwner(currentBot, 'FARM', 'ERROR: No furnace/blast-furnace in scan area. Aborting.')
      return
    }

    notifyOwner(currentBot, 'FARM',
      `Found: ${scan.furnaces.length} furnaces + ${scan.blastFurnaces.length} blast | fuel=${scan.fuelChests.length} pick=${scan.pickaxeChests.length} craft=${scan.craftingTables.length} out=${scan.emptyChests.length}`)

    // target: one full stack of stone per furnace (normal + blast)
    const targetStacks = Math.max(1, totalFurnaces)
    notifyOwner(currentBot, 'FARM', `Target: ${targetStacks} stacks of stone for ${totalFurnaces} furnaces`)

    setPhysics(currentBot, true)

    while (!farmStopRequested) {
      // wait out any ongoing mob-flee before starting a new cycle
      await waitForFleeEnd(currentBot)
      if (farmStopRequested) break

      const havePick = await ensurePickaxe(currentBot, scan)
      if (!havePick) {
        notifyOwner(currentBot, 'FARM', 'No pickaxe available anywhere. Aborting.')
        return
      }
      await equipBestPickaxe(currentBot)

      // toss junk so pure stone has room (1 stack per furnace)
      await clearJunkItems(currentBot)

      // move AWAY from base before mining, so we never eat the machines
      taskStart('travel', 'Walking to mine', 'leaving base')
      await goToMiningSpot(currentBot, 8)
      taskDone('travel')

      // pick a corridor direction that contains NO protected blocks
      const facing = await chooseMiningDirection(
        currentBot, CONFIG.farmStairDepth + CONFIG.farmTunnelLength + 3)
      if (!facing) {
        notifyOwner(currentBot, 'FARM', 'All 4 directions blocked by protected blocks! Move me somewhere else.')
        return
      }

      // stairs: only until we reach a pure stone layer (or lava/hole stops us)
      notifyOwner(currentBot, 'FARM', 'Digging stairs down until pure stone layer...')
      taskStart('mining', 'Mining', 'stairs down to stone layer')
      await equipBestPickaxe(currentBot)
      await digStairsDown(currentBot, facing)
      if (farmStopRequested) break

      // tunnel: mine until we hold targetStacks of stone
      notifyOwner(currentBot, 'FARM', `Mining tunnel until ${targetStacks} stacks of stone...`)
      taskDetail('mining', `tunnel → ${targetStacks} stacks`)
      await digTunnel3x3(currentBot, facing, targetStacks)
      if (farmStopRequested) break
      taskDone('mining')

      if (farmBaseAnchor) {
        notifyOwner(currentBot, 'FARM', 'Returning to base to smelt')
        taskStart('memory', 'Using memory (base path)', 'walking back')
        setActivity('Walking to base', 'from memory')
        try { await walkTo(currentBot, farmBaseAnchor, 3, 120_000) } catch (e) {
          log('FARM', `Return path issue: ${e.message}`)
        }
        setPhysics(currentBot, true)
        taskDone('memory')
      }

      taskStart('smelting', 'Smelting', 'loading furnaces')
      await smeltAllStone(currentBot, scan)
      taskDone('smelting')
      if (farmStopRequested) break

      // final sweep: collect every remaining smooth stone from every furnace
      let leftovers = 0
      const allFurnaces = [...scan.furnaces.map(p => ({ pos: p })), ...scan.blastFurnaces.map(p => ({ pos: p })), ...farmMemory.furnaces.map(p => ({ pos: p })), ...farmMemory.blastFurnaces.map(p => ({ pos: p }))]
      for (const f of allFurnaces) {
        if (farmStopRequested) break
        try {
          const st = await serviceFurnace(currentBot, f.pos)
          leftovers += st.collected
        } catch {}
      }
      if (leftovers > 0) {
        notifyOwner(currentBot, 'FARM', `Collected ${leftovers} leftover smooth stone`)
      }

      taskStart('depositing', 'Depositing', 'smooth stone → chest')
      await depositSmoothStone(currentBot, scan)
      taskDone('depositing')
      if (farmStopRequested) break

      scan = await scanEnvironment(currentBot)

      notifyOwner(currentBot, 'FARM', 'Cycle complete, starting next round')
      setActivity('Farm: next cycle', 'restarting')
    }
  } catch (error) {
    section('!farm Smooth-Stone ERROR')
    log('FARM', error.stack || error.message)
    notifyOwner(currentBot, 'FARM', `Fatal error: ${error.message}`)
  } finally {
    farmActive = false
    farmStopRequested = false
    farmLoopPromise = null
    if (runtimeState.resumableTask?.type === 'farm') runtimeState.resumableTask = null
    saveRuntimeState()
    stopMovement(currentBot)
    for (const n of taskTree) {
      if (['mining', 'smelting', 'depositing', 'memory'].includes(n.id)) taskIdle(n.id)
    }
    setActivity('Idle', 'farm stopped')
    notifyOwner(currentBot, 'FARM', 'Loop terminated')
  }
}

function commandFarm (currentBot, username, argsText) {
  const arg = argsText.trim().toLowerCase()

  if (arg === 'stop' || arg === 'cancel') {
    if (!farmActive) {
      sendPrivateMessage(currentBot, username, 'Farm is not active.', true)
      return
    }
    farmStopRequested = true
    runtimeState.resumableTask = null
    saveRuntimeState()
    try { currentBot.pathfinder?.setGoal(null) } catch {}
    sendPrivateMessage(currentBot, username, 'Stop signal sent to farm loop.', true)
    return
  }

  if (arg !== 'smooth-stone' && arg !== 'smoothstone' && arg !== 'smooth_stone') {
    sendPrivateMessage(currentBot, username,
      `Usage: ${CONFIG.chatPrefix}farm Smooth-Stone  |  ${CONFIG.chatPrefix}farm stop`, true)
    return
  }

  if (farmActive) {
    sendPrivateMessage(currentBot, username, 'Farm is already running.', true)
    return
  }
  if (!pathfinderAvailable()) {
    sendPrivateMessage(currentBot, username, 'Pathfinder not ready.', true)
    return
  }
  if (portalFlowBusy()) {
    sendPrivateMessage(currentBot, username, 'Portal flow busy, try in a minute.', true)
    return
  }

  farmActive = true
  farmStopRequested = false
  setActivity('Farm: starting', 'smooth-stone production')
  sendPrivateMessage(currentBot, username, 'Farm Smooth-Stone starting ...', true)

  farmLoopPromise = farmSmoothStoneLoop(currentBot)
}

function commandAfk (currentBot, username, argsText) {
  const arg = String(argsText || '').trim().toLowerCase()
  if (!arg) {
    sendPrivateMessage(currentBot, username, `AFK is ${runtimeState.afkMode ? 'ON' : 'OFF'}. Usage: ${CONFIG.chatPrefix}afk on|off`, true)
    return
  }

  if (['on', 'start', '1'].includes(arg)) {
    runtimeState.afkMode = true
    mineStopRequested = true
    farmStopRequested = true
    cancelPathfinding(currentBot, 'afk mode')
    stopMovement(currentBot)
    saveRuntimeState()
    sendPrivateMessage(currentBot, username, 'AFK mode enabled. I will stay idle here.', true)
    return
  }

  if (['off', 'stop', '0'].includes(arg)) {
    runtimeState.afkMode = false
    saveRuntimeState()
    sendPrivateMessage(currentBot, username, 'AFK mode disabled.', true)
    return
  }

  sendPrivateMessage(currentBot, username, `Usage: ${CONFIG.chatPrefix}afk on|off`, true)
}

function commandCustom (currentBot, username, argsText) {
  const parts = String(argsText || '').trim().split(/\s+/).filter(Boolean)
  const mode = (parts.shift() || '').toLowerCase()

  if (mode === 'list') {
    const names = Object.keys(runtimeSettings.customCommands)
    if (!names.length) {
      sendPrivateMessage(currentBot, username, 'No custom commands configured.', true)
      return
    }
    sendPrivateMessage(currentBot, username, `Custom commands: ${names.map(n => `${CONFIG.chatPrefix}${n}`).join(', ')}`, true)
    return
  }

  if (mode === 'del' || mode === 'remove') {
    const name = (parts.shift() || '').toLowerCase()
    if (!name) {
      sendPrivateMessage(currentBot, username, `Usage: ${CONFIG.chatPrefix}custom del <name>`, true)
      return
    }
    if (!runtimeSettings.customCommands[name]) {
      sendPrivateMessage(currentBot, username, `Custom command ${name} not found.`, true)
      return
    }
    delete runtimeSettings.customCommands[name]
    saveRuntimeSettings()
    sendPrivateMessage(currentBot, username, `Custom command ${name} deleted.`, true)
    return
  }

  if (mode === 'add') {
    const name = (parts.shift() || '').toLowerCase()
    const type = (parts.shift() || '').toLowerCase()
    const payload = parts.join(' ').trim()
    if (!name || !type || !payload || !['chat', 'cmd'].includes(type)) {
      sendPrivateMessage(currentBot, username,
        `Usage: ${CONFIG.chatPrefix}custom add <name> <chat|cmd> <message-or-command>`, true)
      return
    }
    runtimeSettings.customCommands[name] = { type, payload }
    saveRuntimeSettings()
    sendPrivateMessage(currentBot, username, `Custom command saved: ${CONFIG.chatPrefix}${name}`, true)
    return
  }

  sendPrivateMessage(currentBot, username,
    `${CONFIG.chatPrefix}custom add <name> <chat|cmd> <payload> | ${CONFIG.chatPrefix}custom del <name> | ${CONFIG.chatPrefix}custom list`, true)
}

function executeCustomCommandIfExists (currentBot, username, messageTextLower) {
  const prefix = CONFIG.chatPrefix.toLowerCase()
  if (!messageTextLower.startsWith(prefix)) return false
  const cmdName = messageTextLower.slice(prefix.length).trim().split(/\s+/)[0]
  if (!cmdName) return false
  const def = runtimeSettings.customCommands[cmdName]
  if (!def) return false

  if (def.type === 'chat') {
    enqueueChat(currentBot, def.payload, { priority: true, type: 'CUSTOM' })
  } else {
    const cmd = def.payload.startsWith('/') ? def.payload : `/${def.payload}`
    if (!isBlockedOwnerCommand(cmd)) enqueueChat(currentBot, cmd, { priority: true, type: 'CUSTOM' })
  }
  sendPrivateMessage(currentBot, username, `Executed custom command: ${cmdName}`, true)
  return true
}

function findOrePredicate (oreName) {
  const token = oreName.toLowerCase().replace(/\s+/g, '_')
  return block => {
    if (!block?.name) return false
    const n = block.name.toLowerCase()
    if (!n.includes('ore')) return false
    return n.includes(token)
  }
}

async function mineOreLoop (currentBot, oreName, username) {
  if (mineLoopRunning) return
  if (!pathfinderAvailable()) {
    sendPrivateMessage(currentBot, username, 'Pathfinder is not ready for mining.', true)
    return
  }

  mineLoopRunning = true
  mineStopRequested = false
  runtimeState.mineTask = { ore: oreName, startedAt: Date.now() }
  runtimeState.resumableTask = { type: 'mine', ore: oreName }
  saveRuntimeState()

  const orePredicate = findOrePredicate(oreName)
  sendPrivateMessage(currentBot, username, `Mining started for ore: ${oreName}`, true)

  while (!mineStopRequested && bot === currentBot && loggedIn && !runtimeState.afkMode) {
    let target = null
    try {
      target = currentBot.findBlock({ matching: orePredicate, maxDistance: 48, count: 1 })
    } catch {}

    if (!target) {
      sendPrivateMessage(currentBot, username, `No ${oreName} found nearby.`, true)
      break
    }

    try {
      await walkTo(currentBot, target.position, 1, 120_000)
      const b = currentBot.blockAt(target.position)
      if (!b) continue
      await digBlockSafe(currentBot, b)
      await sleep(200)
    } catch (error) {
      log('MINE', `mine loop error: ${error.message}`)
      await sleep(1000)
    }
  }

  mineLoopRunning = false
  mineStopRequested = false
  runtimeState.mineTask = null
  if (runtimeState.resumableTask?.type === 'mine') runtimeState.resumableTask = null
  saveRuntimeState()
  sendPrivateMessage(currentBot, username, 'Mine loop stopped.', true)
}

function commandMine (currentBot, username, argsText) {
  const arg = String(argsText || '').trim().toLowerCase()
  if (!arg) {
    sendPrivateMessage(currentBot, username, `Usage: ${CONFIG.chatPrefix}mine <ore-name> | ${CONFIG.chatPrefix}mine stop`, true)
    return
  }

  if (arg === 'stop' || arg === 'cancel') {
    mineStopRequested = true
    cancelPathfinding(currentBot, 'mine stop')
    sendPrivateMessage(currentBot, username, 'Stopping mine loop...', true)
    return
  }

  if (mineLoopRunning) {
    sendPrivateMessage(currentBot, username, 'Mine loop already running.', true)
    return
  }

  mineOreLoop(currentBot, arg, username).catch(error => {
    log('MINE', `Unhandled error: ${error.message}`)
  })
}

async function executeAiPlan (currentBot, username, taskText) {
  if (!runtimeSettings.ai.enabled) {
    sendPrivateMessage(currentBot, username, 'AI module is disabled.', true)
    return
  }
  if (!runtimeSettings.ai.baseUrl || !runtimeSettings.ai.model) {
    sendPrivateMessage(currentBot, username, 'AI base_url/model not configured from Telegram panel.', true)
    return
  }
  if (aiBusy) {
    sendPrivateMessage(currentBot, username, 'AI is already processing another task.', true)
    return
  }

  aiBusy = true
  runtimeState.aiTask = { text: taskText, updatedAt: Date.now(), step: 'planning' }
  saveRuntimeState()

  try {
    const payload = {
      model: runtimeSettings.ai.model,
      messages: [
        {
          role: 'system',
          content: 'You are a Minecraft bot planner. Return strict JSON with {summary, steps:[{type, action, command, note}]}. You are a planner, not direct executor. Keep steps minimal and safe.'
        },
        { role: 'user', content: taskText }
      ]
    }

    let tries = 0
    let result = null
    while (tries < 4) {
      tries++
      try {
        const response = await fetch(runtimeSettings.ai.baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(runtimeSettings.ai.apiKey ? { Authorization: `Bearer ${runtimeSettings.ai.apiKey}` } : {})
          },
          body: JSON.stringify(payload)
        })

        if (response.status === 429) {
          log('AI', 'Rate limited, waiting 10s then retry')
          await sleep(10_000)
          continue
        }

        const data = await response.json().catch(() => ({}))
        const text = data?.choices?.[0]?.message?.content || data?.output_text || ''
        result = String(text || '').trim()
        break
      } catch (error) {
        log('AI', `Attempt ${tries} failed: ${error.message}`)
        await sleep(2000)
      }
    }

    if (!result) {
      sendPrivateMessage(currentBot, username, 'AI failed after retries.', true)
      return
    }

    const compact = result.slice(0, 700)
    sendPrivateMessage(currentBot, username, `AI Plan:\n${compact}`, true)
    runtimeState.aiTask = { text: taskText, updatedAt: Date.now(), step: 'planned' }
    saveRuntimeState()
  } finally {
    aiBusy = false
  }
}

function commandAi (currentBot, username, argsText) {
  const text = String(argsText || '').trim()
  if (!text) {
    sendPrivateMessage(currentBot, username, `Usage: ${CONFIG.chatPrefix}ai <task>`, true)
    return
  }
  executeAiPlan(currentBot, username, text).catch(error => {
    log('AI', `Unhandled error: ${error.message}`)
  })
}

function parseSkillLine (line) {
  const clean = stripColorCodes(line)
  const m = clean.match(/([a-zA-Z_ ]{3,24})\s*[:|-]\s*(\d{1,4})(?:\s*[^\d]+(\d{1,3}(?:\.\d+)?)\s*%?)?/)
  if (!m) return null
  const name = m[1].trim().toLowerCase().replace(/\s+/g, '_')
  const level = Number(m[2])
  const progress = m[3] ? Number(m[3]) : null
  if (!Number.isFinite(level)) return null
  return { name, level, progress }
}

function feedSkillScanLine (message) {
  if (!skillScanCollector) return
  const hit = parseSkillLine(message)
  if (!hit) return
  skillScanCollector.map.set(hit.name, hit)
}

async function scanSkillsViaChat (currentBot, targetPlayer = '') {
  if (skillScanCollector) throw new Error('skill scan already running')

  const command = targetPlayer ? `/skills ${targetPlayer}` : '/skills'
  const collector = { map: new Map(), startedAt: Date.now() }
  skillScanCollector = collector
  enqueueChat(currentBot, command, { priority: true, type: 'SKILL-SCAN' })

  await sleep(2600)
  skillScanCollector = null

  const skills = Array.from(collector.map.values())
  if (!skills.length) return null
  const byName = {}
  for (const s of skills) byName[s.name] = { level: s.level, progress: s.progress }

  const snapshot = {
    at: Date.now(),
    target: targetPlayer || currentBot.username,
    skills: byName
  }
  runtimeState.skillSnapshot = snapshot
  saveRuntimeState()
  return snapshot
}

function nearestCombatMob (currentBot, radius = 10) {
  const entities = Object.values(currentBot.entities || {})
  let best = null
  let bestDist = Infinity
  for (const e of entities) {
    if (!e || e.type !== 'mob' || !e.position || !e.mobType) continue
    if (['armor_stand', 'item_frame', 'villager', 'wandering_trader'].includes(String(e.mobType))) continue
    const d = currentBot.entity.position.distanceTo(e.position)
    if (d > radius) continue
    if (d < bestDist) { bestDist = d; best = e }
  }
  return best
}

function findNearestBlockByNames (currentBot, names, maxDistance = 24) {
  const set = new Set(names)
  return currentBot.findBlock({
    matching: b => Boolean(b?.name && set.has(b.name)),
    maxDistance,
    count: 1
  })
}

function findBestSword (currentBot) {
  const pref = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword']
  const items = currentBot.inventory?.items?.() || []
  for (const p of pref) {
    const it = items.find(x => x?.name === p)
    if (it) return it
  }
  return null
}

async function equipBestSword (currentBot) {
  const sword = findBestSword(currentBot)
  if (!sword) return false
  sanitizeItem(sword)
  await currentBot.equip(sword, 'hand')
  return true
}

function normalizeSkillMode (raw) {
  const key = String(raw || '').toLowerCase().trim()
  const map = {
    agi: 'agility', agility: 'agility', چابکی: 'agility',
    fight: 'fighting', fighting: 'fighting', pve: 'fighting', combat: 'fighting', فایت: 'fighting',
    mine: 'mining', mining: 'mining', miner: 'mining', ماین: 'mining',
    forage: 'foraging', foraging: 'foraging', wood: 'foraging', lumber: 'foraging', چوب: 'foraging',
    farm: 'farming', farming: 'farming', کشاورزی: 'farming',
    dig: 'excavation', excavation: 'excavation', shovel: 'excavation', خاک: 'excavation',
    def: 'defense', defense: 'defense', defend: 'defense', دفاع: 'defense'
  }
  return map[key] || key
}

function availableSkillModes () {
  return ['agility', 'fighting', 'mining', 'foraging', 'farming', 'excavation', 'defense']
}

async function moveAndBreakNearest (currentBot, names, range = 28) {
  const target = findNearestBlockByNames(currentBot, names, range)
  if (!target) return false
  await walkTo(currentBot, target.position, 2, 45_000).catch(() => {})
  const block = currentBot.blockAt(target.position)
  if (!block) return false
  await digBlockSafe(currentBot, block)
  return true
}

function isCropMature (block) {
  if (!block?.name) return false
  const ages = {
    wheat: 7,
    carrots: 7,
    potatoes: 7,
    beetroots: 3,
    nether_wart: 3,
    cocoa: 2
  }
  const maxAge = ages[block.name]
  if (!Number.isFinite(maxAge)) return false
  const age = Number(block.metadata)
  if (Number.isFinite(age)) return age >= maxAge
  return true
}

async function trainAgilityLoop (currentBot, username) {
  const started = Date.now()
  while (!skillTrainingStopRequested && bot === currentBot && loggedIn && !runtimeState.afkMode) {
    try {
      setPhysics(currentBot, true)
      currentBot.setControlState('sprint', true)
      currentBot.setControlState('forward', true)
      currentBot.setControlState('jump', true)
      await sleep(1000)
      currentBot.setControlState('jump', false)
      await sleep(300)
      currentBot.setControlState('left', true)
      await sleep(280)
      currentBot.setControlState('left', false)
      currentBot.setControlState('right', true)
      await sleep(280)
      currentBot.setControlState('right', false)
      await sleep(300)
    } catch (error) {
      log('SKILL', `agility loop issue: ${error.message}`)
      await sleep(800)
    }
  }
  stopMovement(currentBot)
  sendPrivateMessage(currentBot, username, `Agility training stopped (${Math.round((Date.now() - started) / 1000)}s).`, true)
}

async function trainFightingLoop (currentBot, username) {
  await equipBestSword(currentBot).catch(() => {})
  while (!skillTrainingStopRequested && bot === currentBot && loggedIn && !runtimeState.afkMode) {
    try {
      if ((currentBot.health ?? 20) < 10) {
        await ensureFood(currentBot).catch(() => {})
      }
      const target = nearestCombatMob(currentBot, 14)
      if (!target) {
        await sleep(700)
        continue
      }
      await walkTo(currentBot, target.position, 2, 30_000).catch(() => {})
      if (target?.isValid !== false) {
        await currentBot.lookAt(target.position.offset(0, 1.2, 0), true).catch(() => {})
        currentBot.attack(target)
      }
      await sleep(430)
    } catch (error) {
      log('SKILL', `fighting loop issue: ${error.message}`)
      await sleep(900)
    }
  }
  stopMovement(currentBot)
  sendPrivateMessage(currentBot, username, 'Fighting training stopped.', true)
}

async function trainMiningLoop (currentBot, username) {
  const ores = ['diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore', 'gold_ore', 'deepslate_gold_ore', 'iron_ore', 'deepslate_iron_ore', 'coal_ore', 'deepslate_coal_ore', 'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore']
  const fallback = ['stone', 'deepslate', 'andesite', 'diorite', 'granite']
  while (!skillTrainingStopRequested && bot === currentBot && loggedIn && !runtimeState.afkMode) {
    try {
      const done = await moveAndBreakNearest(currentBot, ores, 40)
      if (!done) {
        await moveAndBreakNearest(currentBot, fallback, 14).catch(() => {})
        await sleep(250)
      }
      await sleep(250)
    } catch (error) {
      log('SKILL', `mining loop issue: ${error.message}`)
      await sleep(1000)
    }
  }
  sendPrivateMessage(currentBot, username, 'Mining training stopped.', true)
}

async function trainForagingLoop (currentBot, username) {
  const logs = [
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
    'mangrove_log', 'cherry_log', 'crimson_stem', 'warped_stem'
  ]
  while (!skillTrainingStopRequested && bot === currentBot && loggedIn && !runtimeState.afkMode) {
    try {
      const ok = await moveAndBreakNearest(currentBot, logs, 36)
      if (!ok) await sleep(900)
      else await sleep(300)
    } catch (error) {
      log('SKILL', `foraging loop issue: ${error.message}`)
      await sleep(900)
    }
  }
  sendPrivateMessage(currentBot, username, 'Foraging training stopped.', true)
}

async function trainFarmingLoop (currentBot, username) {
  const cropNames = ['wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart', 'cocoa']
  while (!skillTrainingStopRequested && bot === currentBot && loggedIn && !runtimeState.afkMode) {
    try {
      const crop = currentBot.findBlock({
        matching: b => Boolean(b?.name && cropNames.includes(b.name) && isCropMature(b)),
        maxDistance: 30,
        count: 1
      })
      if (!crop) {
        await sleep(1000)
        continue
      }
      await walkTo(currentBot, crop.position, 2, 35_000).catch(() => {})
      const block = currentBot.blockAt(crop.position)
      if (block && cropNames.includes(block.name)) {
        await digBlockSafe(currentBot, block).catch(() => {})
      }
      await sleep(380)
    } catch (error) {
      log('SKILL', `farming loop issue: ${error.message}`)
      await sleep(900)
    }
  }
  sendPrivateMessage(currentBot, username, 'Farming training stopped.', true)
}

async function trainExcavationLoop (currentBot, username) {
  const blocks = ['dirt', 'coarse_dirt', 'grass_block', 'sand', 'red_sand', 'gravel', 'clay', 'mud', 'soul_sand']
  while (!skillTrainingStopRequested && bot === currentBot && loggedIn && !runtimeState.afkMode) {
    try {
      const ok = await moveAndBreakNearest(currentBot, blocks, 24)
      if (!ok) await sleep(800)
      else await sleep(260)
    } catch (error) {
      log('SKILL', `excavation loop issue: ${error.message}`)
      await sleep(900)
    }
  }
  sendPrivateMessage(currentBot, username, 'Excavation training stopped.', true)
}

async function trainDefenseLoop (currentBot, username) {
  await equipBestSword(currentBot).catch(() => {})
  while (!skillTrainingStopRequested && bot === currentBot && loggedIn && !runtimeState.afkMode) {
    try {
      if ((currentBot.health ?? 20) <= 10) {
        currentBot.setControlState('back', true)
        await ensureFood(currentBot).catch(() => {})
        await sleep(400)
        currentBot.setControlState('back', false)
      }
      const target = nearestCombatMob(currentBot, 10)
      if (!target) {
        await sleep(600)
        continue
      }
      await currentBot.lookAt(target.position.offset(0, 1.1, 0), true).catch(() => {})
      currentBot.attack(target)
      if ((currentBot.health ?? 20) < 8) {
        currentBot.setControlState('sprint', true)
        currentBot.setControlState('back', true)
        await sleep(500)
        currentBot.setControlState('back', false)
      }
      await sleep(450)
    } catch (error) {
      log('SKILL', `defense loop issue: ${error.message}`)
      await sleep(900)
    }
  }
  stopMovement(currentBot)
  sendPrivateMessage(currentBot, username, 'Defense training stopped.', true)
}

function stopSkillTraining (currentBot, username) {
  skillTrainingStopRequested = true
  runtimeState.skillTraining = null
  saveRuntimeState()
  stopMovement(currentBot)
  sendPrivateMessage(currentBot, username, 'Skill training stop requested.', true)
}

function startSkillTraining (currentBot, username, modeRaw) {
  const mode = normalizeSkillMode(modeRaw)
  if (skillTrainingLoopRunning) {
    sendPrivateMessage(currentBot, username, 'A skill training loop is already running.', true)
    return
  }
  if (!availableSkillModes().includes(mode)) {
    sendPrivateMessage(currentBot, username, `Unsupported mode. Allowed: ${availableSkillModes().join(', ')}`, true)
    return
  }

  skillTrainingLoopRunning = true
  skillTrainingStopRequested = false

  mineStopRequested = true
  farmStopRequested = true
  cancelPathfinding(currentBot, 'start skill training')

  runtimeState.skillTraining = { mode, startedAt: Date.now() }
  runtimeState.resumableTask = { type: 'skills', mode, startedAt: Date.now() }
  saveRuntimeState()

  const runners = {
    agility: trainAgilityLoop,
    fighting: trainFightingLoop,
    mining: trainMiningLoop,
    foraging: trainForagingLoop,
    farming: trainFarmingLoop,
    excavation: trainExcavationLoop,
    defense: trainDefenseLoop
  }

  const runner = runners[mode]
  runner(currentBot, username)
    .catch(error => log('SKILL', `${mode} loop error: ${error.message}`))
    .finally(() => {
      skillTrainingLoopRunning = false
      skillTrainingStopRequested = false
      runtimeState.skillTraining = null
      if (runtimeState.resumableTask?.type === 'skills') runtimeState.resumableTask = null
      saveRuntimeState()
    })

  sendPrivateMessage(currentBot, username, `${mode} training started.`, true)
}

function formatSkillSnapshot (snapshot) {
  if (!snapshot?.skills) return 'No skill snapshot available.'
  const rows = Object.entries(snapshot.skills)
    .sort((a, b) => b[1].level - a[1].level)
    .slice(0, 24)
    .map(([k, v]) => `${k}: L${v.level}${Number.isFinite(v.progress) ? ` (${v.progress}%)` : ''}`)
  return [`Skill snapshot for ${snapshot.target}:`, ...rows].join(' | ')
}

function commandSkills (currentBot, username, argsText) {
  const parts = String(argsText || '').trim().split(/\s+/).filter(Boolean)
  const sub = (parts.shift() || '').toLowerCase()

  if (!sub || sub === 'help') {
    sendPrivateMessage(currentBot, username,
      `Usage: ${CONFIG.chatPrefix}skills scan [player] | ${CONFIG.chatPrefix}skills train <${availableSkillModes().join('|')}> | ${CONFIG.chatPrefix}skills stop | ${CONFIG.chatPrefix}skills status`, true)
    return
  }

  if (sub === 'scan') {
    const target = parts[0] || ''
    scanSkillsViaChat(currentBot, target)
      .then(snapshot => {
        if (!snapshot) {
          sendPrivateMessage(currentBot, username, 'No skill lines detected from chat output.', true)
          return
        }
        sendPrivateMessage(currentBot, username, formatSkillSnapshot(snapshot).slice(0, 240), true)
      })
      .catch(error => sendPrivateMessage(currentBot, username, `Skill scan failed: ${error.message}`, true))
    return
  }

  if (sub === 'train') {
    const mode = normalizeSkillMode(parts[0] || '')
    startSkillTraining(currentBot, username, mode)
    return
  }

  if (sub === 'stop') {
    stopSkillTraining(currentBot, username)
    return
  }

  if (sub === 'status') {
    const active = runtimeState.skillTraining
    if (!active) {
      sendPrivateMessage(currentBot, username, `No active training. ${formatSkillSnapshot(runtimeState.skillSnapshot).slice(0, 160)}`, true)
      return
    }
    sendPrivateMessage(currentBot, username, `Training: ${active.mode} (since ${Math.round((Date.now() - active.startedAt) / 1000)}s)`, true)
    return
  }

  sendPrivateMessage(currentBot, username, 'Unknown skills subcommand.', true)
}

function classifyItemName (name) {
  const n = String(name || '').toLowerCase()
  if (/(_sword|_axe|_pickaxe|_shovel|_hoe|bow|crossbow|trident|mace)$/.test(n)) return 1
  if (/(_helmet|_chestplate|_leggings|_boots|elytra)$/.test(n)) return 2
  if (/(bread|beef|porkchop|chicken|potato|carrot|apple|melon|golden_apple|stew|fish|cod|salmon)/.test(n)) return 3
  if (/(ore|ingot|diamond|emerald|lapis|redstone|coal|quartz|amethyst|netherite|raw_)/.test(n)) return 4
  if (/(cobblestone|stone|deepslate|dirt|sand|gravel|planks|log|wood|terracotta|concrete|glass|brick|obsidian)/.test(n)) return 5
  if (/(torch|lantern|rail|bucket|flint|string|bone|gunpowder|pearl|arrow)/.test(n)) return 6
  return 9
}

function chestItemSortKey (item) {
  if (!item) return '99|zzzz|0000'
  const cat = classifyItemName(item.name)
  const name = item.name || 'unknown'
  const count = String(9999 - (item.count || 0)).padStart(4, '0')
  return `${cat}|${name}|${count}`
}

async function swapWindowSlots (currentBot, a, b) {
  if (a === b) return
  await currentBot.clickWindow(a, 0, 0)
  await sleep(60)
  await currentBot.clickWindow(b, 0, 0)
  await sleep(60)
  await currentBot.clickWindow(a, 0, 0)
  await sleep(70)
}

function getTargetChestBlock (currentBot) {
  const looked = currentBot.blockAtCursor?.(5)
  if (looked && ['chest', 'trapped_chest', 'barrel'].includes(looked.name)) return looked
  return currentBot.findBlock({
    matching: b => ['chest', 'trapped_chest', 'barrel'].includes(b?.name),
    maxDistance: 5,
    count: 1
  })
}

async function sortChestAdvanced (currentBot, username) {
  const chestBlock = getTargetChestBlock(currentBot)
  if (!chestBlock) {
    sendPrivateMessage(currentBot, username, 'No chest/barrel in sight (max 5 blocks).', true)
    return
  }

  await walkTo(currentBot, chestBlock.position, 2, 30_000).catch(() => {})
  const container = await currentBot.openContainer(chestBlock).catch(() => null)
  if (!container) {
    sendPrivateMessage(currentBot, username, 'Cannot open target chest.', true)
    return
  }

  try {
    const chestSlotCount = Number(container.inventoryStart || 27)
    const slots = []
    for (let i = 0; i < chestSlotCount; i++) {
      const item = container.slots[i]
      if (!item) continue
      slots.push({ slot: i, item })
    }

    if (!slots.length) {
      sendPrivateMessage(currentBot, username, 'Chest is empty.', true)
      return
    }

    const desired = [...slots].sort((a, b) => chestItemSortKey(a.item).localeCompare(chestItemSortKey(b.item)))
    let moved = 0

    for (let i = 0; i < desired.length; i++) {
      const targetName = desired[i].item?.name
      const currentItem = container.slots[i]
      if (currentItem?.name === targetName) continue

      let j = -1
      for (let k = i + 1; k < chestSlotCount; k++) {
        const it = container.slots[k]
        if (it?.name === targetName) { j = k; break }
      }
      if (j < 0) continue

      await swapWindowSlots(currentBot, i, j)
      moved++
    }

    const summary = {}
    for (let i = 0; i < chestSlotCount; i++) {
      const it = container.slots[i]
      if (!it) continue
      const cat = classifyItemName(it.name)
      summary[cat] = (summary[cat] || 0) + 1
    }

    sendPrivateMessage(currentBot, username,
      `Chest sorted. moved=${moved}, groups: tools=${summary[1] || 0}, armor=${summary[2] || 0}, food=${summary[3] || 0}, ores=${summary[4] || 0}, blocks=${summary[5] || 0}, misc=${summary[6] || 0}`, true)
  } catch (error) {
    sendPrivateMessage(currentBot, username, `Sort chest failed: ${error.message}`, true)
  } finally {
    try { container.close() } catch {}
  }
}

function commandSortChest (currentBot, username) {
  sortChestAdvanced(currentBot, username).catch(error => {
    log('CHEST', `Sort command failed: ${error.message}`)
    sendPrivateMessage(currentBot, username, `Sort chest error: ${error.message}`, true)
  })
}

function maybeAutoAcceptTpa (currentBot, rawMessage) {
  if (!runtimeSettings.bot.autoTpaAccept) return
  const clean = stripColorCodes(rawMessage).toLowerCase()
  const owner = normalizeUsername(CONFIG.owner)
  if (!clean.includes(owner)) return
  if (!/tpa|teleport request/.test(clean)) return

  const cmd = runtimeSettings.bot.tpaAcceptCommand.replace('{player}', CONFIG.owner)
  enqueueChat(currentBot, cmd.startsWith('/') ? cmd : `/${cmd}`, { priority: true, type: 'TPA-AUTO' })
}

function startStuckWatchdog () {
  if (botWatchdogTimer) return
  let lastPos = null
  let stuckTicks = 0

  botWatchdogTimer = setInterval(() => {
    const currentBot = bot
    if (!currentBot || !loggedIn || runtimeState.afkMode) return
    const mode = currentModeId()
    if (!['travel', 'mining'].includes(mode)) { stuckTicks = 0; lastPos = null; return }
    const p = currentBot?.entity?.position
    if (!p) return
    const key = `${Math.floor(p.x)}:${Math.floor(p.y)}:${Math.floor(p.z)}`
    if (key === lastPos) stuckTicks++
    else stuckTicks = 0
    lastPos = key

    if (stuckTicks >= 5) {
      stuckTicks = 0
      log('WATCHDOG', 'Possible stuck detected, applying unstick controls')
      try {
        currentBot.setControlState('jump', true)
        currentBot.setControlState('forward', true)
        setTimeout(() => {
          try {
            currentBot.setControlState('jump', false)
            currentBot.setControlState('forward', false)
          } catch {}
        }, 700)
      } catch {}
    }
  }, 3000)
  botWatchdogTimer.unref?.()
}

// ============================================================
// COMMAND ROUTER
// ============================================================

function sendHelp (currentBot, username) {
  const p = CONFIG.chatPrefix
  const lines = [
    `${p}auth <password> (only /msg) | ${p}tpa | ${p}command /...`,
    `${p}go <x> <y> <z> | ${p}go stop | ${p}inv | ${p}sethome`,
    `${p}farm Smooth-Stone | ${p}farm stop | ${p}mine <ore> | ${p}mine stop`,
    `${p}skills scan [player] | ${p}skills train agility|fighting|mining|foraging|farming|excavation|defense | ${p}skills stop`,
    `${p}sortchest | ${p}afk on|off | ${p}custom add|del|list | ${p}ai <task>`,
    `${p}stop msg | ${p}start msg | ${p}help`
  ]
  for (const line of lines) sendPrivateMessage(currentBot, username, line, true)
}

function handleCommand (currentBot, username, rawMessage, isPrivate) {
  if (bot !== currentBot) return
  if (!loggedIn) return
  if (!username || !rawMessage) return
  if (!isOwner(username)) return

  const originalMessage = String(rawMessage).trim()
  if (!originalMessage.startsWith(CONFIG.chatPrefix)) return

  const lowerMessage = originalMessage.toLowerCase()
  const prefix = CONFIG.chatPrefix.toLowerCase()

  const authCommand = `${prefix}auth`
  const tpaCommand = `${prefix}tpa`
  const commandPrefix = `${prefix}command`
  const goCommand = `${prefix}go`
  const invCommand = `${prefix}inv`
  const setHomeCommand = `${prefix}sethome`
  const stopMsgCommand = `${prefix}stop msg`
  const startMsgCommand = `${prefix}start msg`
  const helpCommand = `${prefix}help`
  const farmCommand = `${prefix}farm`
  const afkCommand = `${prefix}afk`
  const customCommand = `${prefix}custom`
  const mineCommand = `${prefix}mine`
  const aiCommand = `${prefix}ai`
  const skillsCommand = `${prefix}skills`
  const sortChestCommand = `${prefix}sortchest`

  if (lowerMessage === authCommand || lowerMessage.startsWith(`${authCommand} `)) {
    handleAuthCommand(currentBot, username, originalMessage, isPrivate)
    return
  }

  if (executeCustomCommandIfExists(currentBot, username, lowerMessage)) return

  if (!isAuthSessionValid()) {
    if (ownerVerified && (Date.now() - ownerVerifiedAt) >= CONFIG.authSessionMs) {
      resetAuthState('session expired (30 min)')
    }
    log('SECURITY', `Command ignored (not verified): ${lowerMessage}`)
    denyUnverified(currentBot, username)
    requestAuth(currentBot)
    return
  }

  if (lowerMessage === helpCommand) { sendHelp(currentBot, username); return }

  if (lowerMessage === afkCommand || lowerMessage.startsWith(`${afkCommand} `)) {
    const args = originalMessage.slice(afkCommand.length).trim()
    commandAfk(currentBot, username, args)
    return
  }

  if (runtimeState.afkMode) {
    sendPrivateMessage(currentBot, username, 'AFK mode is ON. Use !afk off first.', true)
    return
  }

  if (lowerMessage === tpaCommand) {
    const now = Date.now()
    if (now - lastTpaCommandAt < 3000) {
      sendPrivateMessage(currentBot, username, 'Slow down on !tpa.', true)
      return
    }
    lastTpaCommandAt = now
    enqueueChat(currentBot, `/tpa ${username}`, { priority: true, type: 'TPA' })
    sendPrivateMessage(currentBot, username, 'TPA request sent.', true)
    return
  }

  if (lowerMessage === stopMsgCommand) {
    welcomeOthersEnabled = false
    sendPrivateMessage(currentBot, username, 'Welcome messages disabled for others.', true)
    return
  }
  if (lowerMessage === startMsgCommand) {
    welcomeOthersEnabled = true
    sendPrivateMessage(currentBot, username, 'Welcome messages enabled for others.', true)
    return
  }

  if (lowerMessage === customCommand || lowerMessage.startsWith(`${customCommand} `)) {
    const args = originalMessage.slice(customCommand.length).trim()
    commandCustom(currentBot, username, args)
    return
  }

  if (lowerMessage === commandPrefix || lowerMessage.startsWith(`${commandPrefix} `)) {
    commandRunOwnerCommand(currentBot, username, originalMessage)
    return
  }

  if (lowerMessage === goCommand || lowerMessage.startsWith(`${goCommand} `)) {
    const args = originalMessage.slice(goCommand.length).trim()
    commandGo(currentBot, username, args).catch(error => {
      log('GO', `Unhandled error: ${error.message}`)
    })
    return
  }

  if (lowerMessage === invCommand) {
    commandInventory(currentBot, username).catch(error => {
      log('INV', `Unhandled error: ${error.message}`)
    })
    return
  }

  if (lowerMessage === setHomeCommand) {
    commandSetHome(currentBot, username).catch(error => {
      log('SETHOME', `Unhandled error: ${error.message}`)
    })
    return
  }

  if (lowerMessage === farmCommand || lowerMessage.startsWith(`${farmCommand} `)) {
    const args = originalMessage.slice(farmCommand.length).trim()
    runtimeState.resumableTask = { type: 'farm', updatedAt: Date.now() }
    saveRuntimeState()
    commandFarm(currentBot, username, args)
    return
  }

  if (lowerMessage === mineCommand || lowerMessage.startsWith(`${mineCommand} `)) {
    const args = originalMessage.slice(mineCommand.length).trim()
    commandMine(currentBot, username, args)
    return
  }

  if (lowerMessage === aiCommand || lowerMessage.startsWith(`${aiCommand} `)) {
    const args = originalMessage.slice(aiCommand.length).trim()
    commandAi(currentBot, username, args)
    return
  }

  if (lowerMessage === skillsCommand || lowerMessage.startsWith(`${skillsCommand} `)) {
    const args = originalMessage.slice(skillsCommand.length).trim()
    commandSkills(currentBot, username, args)
    return
  }

  if (lowerMessage === sortChestCommand) {
    commandSortChest(currentBot, username)
    return
  }
}

function handlePrivateCommand (currentBot, username, message, source) {
  if (!isValidMinecraftUsername(username)) return
  if (!isOwner(username)) return

  const text = stripColorCodes(message).trim()
  if (!text.startsWith(CONFIG.chatPrefix)) return

  const key = `${normalizeUsername(username)}|${text}`
  const now = Date.now()
  if (key === lastPrivateKey && now - lastPrivateAt < 500) return
  lastPrivateKey = key; lastPrivateAt = now

  handleCommand(currentBot, username, text, true)
}

// ============================================================
// RECONNECT
// ============================================================

function scheduleReconnect (reason) {
  if (shuttingDown) return
  reconnectAttempt++
  const delay = Math.min(60_000, 5000 * reconnectAttempt)
  log('RECONNECT', `Scheduling in ${delay}ms after: ${reason}`)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!shuttingDown) start()
  }, delay)
}

// ============================================================
// START
// ============================================================

function start () {
  clearSessionTimers()
  clearPlayerSyncTimer()
  resetChatQueue()
  stopTotemLoop()
  stopArmorLoop()
  stopFoodLoop()
  setActivity('Connecting', `${CONFIG.host}:${CONFIG.port}`)

  loggedIn = false
  authCommandPending = false
  inConfiguration = false
  portalFlowStarted = false
  loginSuccessAt = 0

  knownPlayers = new Set()
  playerListReady = false
  playerSyncStartedAt = 0

  lastTpaCommandAt = 0
  lastOwnerCommandAt = 0

  goActive = false
  goCancelRequested = false
  invBusy = false

  farmActive = false
  farmStopRequested = false

  resetAuthState('new session')

  section('6b6t BOT STARTING')
  log('CONFIG', `Server: ${CONFIG.host}:${CONFIG.port}`)
  log('CONFIG', `Username: ${CONFIG.username}`)
  log('CONFIG', `Owner: ${CONFIG.owner}`)
  log('CONFIG', `Chat prefix: ${CONFIG.chatPrefix}`)
  log('CONFIG', `Chat delay: ${CONFIG.chatDelay}ms`)
  log('CONFIG', `Minecraft: ${CONFIG.version}`)
  log('CONFIG', `Render distance: ${CONFIG.viewDistance}`)
  log('CONFIG', `Auto totem: ${CONFIG.autoTotem ? 'ON' : 'OFF'}`)
  log('CONFIG', `Auto armor: ${CONFIG.autoArmor ? 'ON' : 'OFF'}`)
  log('CONFIG', `Auth session: ${Math.round(CONFIG.authSessionMs / 60000)} min`)
  log('CONFIG', `Farm radius: ${CONFIG.farmScanRadius} blocks`)
  log('CONFIG', `Pathfinder: ${pathfinderPlugin ? 'loaded' : 'not installed'}`)
  log('CONFIG', `Inventory render: ${canvasLib && minecraftAssets ? 'ready' : 'missing canvas/minecraft-assets'}`)
  log('CONFIG', 'Security: !auth required (private message only, 30 min session)')

  startPacketSpamSummary()
  loadFarmMemory()

  const currentBot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version,
    auth: 'offline',
    viewDistance: CONFIG.viewDistance,
    physicsEnabled: false
  })

  bot = currentBot

  if (pathfinderPlugin) {
    try {
      currentBot.loadPlugin(pathfinderPlugin.pathfinder)
      log('PATHFINDER', 'Plugin loaded')
    } catch (error) {
      log('PATHFINDER', `Could not load plugin: ${error.message}`)
    }
  }

  setPhysics(currentBot, false)

  // ============================================================
  // RAW PACKETS
  // ============================================================

  currentBot._client.on('packet', (data, meta) => {
    if (bot !== currentBot) return
    const importantPackets = [
      'start_configuration', 'select_known_packs', 'registry_data',
      'finish_configuration', 'login', 'disconnect', 'transfer'
    ]
    if (importantPackets.includes(meta.name)) log('PACKET', meta.name)

    if (meta.name === 'start_configuration') {
      transferCount++
      inConfiguration = true
      beginPlayerListSync(currentBot, `server transfer #${transferCount}`)
      section(`SERVER TRANSFER #${transferCount}`)
      stopMovement(currentBot)
      setPhysics(currentBot, false)
      log('TRANSFER', 'Configuration started')
    }

    if (meta.name === 'finish_configuration') log('CONFIG', 'finish_configuration received')

    if (meta.name === 'login' && inConfiguration) {
      inConfiguration = false
      stopMovement(currentBot)
      setPhysics(currentBot, false)
      log('TRANSFER', 'New server login received')
    }

    if (meta.name === 'disconnect') {
      section('RAW DISCONNECT PACKET')
      console.log(formatKickReason(data))
    }
  })

  currentBot._client.on('start_configuration', () => {
    if (bot !== currentBot) return
    cancelPathfinding(currentBot, 'server transfer')
  })

  // ============================================================
  // LOGIN
  // ============================================================

  currentBot.on('login', () => {
    if (bot !== currentBot) return
    reconnectAttempt = 0
    section('CONNECTED')
    log('LOGIN', 'Connection established')
    stopMovement(currentBot)
    setPhysics(currentBot, false)
    beginPlayerListSync(currentBot, 'initial connection')
  })

  // ============================================================
  // SPAWN
  // ============================================================

  currentBot.on('spawn', () => {
    if (bot !== currentBot) return
    beginPlayerListSync(currentBot, 'spawn')
    section('SPAWN')
    log('POS', position(currentBot))
    stopMovement(currentBot)
    setPhysics(currentBot, false)
    log('SERVER', 'Waiting for authentication')

    // No-auth fallback: if the server never asks for /login (local/test servers),
    // mark the session as logged-in after 20s so commands still work.
    later(currentBot, () => {
      if (loggedIn || authCommandPending || shuttingDown) return
      loggedIn = true
      loginSuccessAt = Date.now()
      log('AUTH', 'No login request detected — assuming no-auth server')
      beginPlayerListSync(currentBot, 'no-auth fallback')
      startTotemLoop(currentBot)
      startArmorLoop(currentBot)
      startFoodLoop(currentBot)
    }, 20_000)
  })

  // ============================================================
  // SERVER AUTH (register/login)
  // ============================================================

  currentBot.on('messagestr', message => {
    if (bot !== currentBot) return
    if (!message || !message.trim()) return
    log('CHAT', message)
    uiChatPush({ time: Date.now(), text: stripColorCodes(message).slice(0, 300) })
    maybeAutoAcceptTpa(currentBot, message)
    feedSkillScanLine(message)

    const text = message.toLowerCase()

    const registerRequested =
      text.includes('please register') || text.includes('/register ') ||
      text.includes('/register password') || text.includes('you need to register')

    if (!loggedIn && !authCommandPending && registerRequested) {
      authCommandPending = true
      log('AUTH', 'Server requested /register')
      later(currentBot, () => {
        if (loggedIn) return
        log('AUTH', 'Sending /register')
        currentBot.chat(`/register ${CONFIG.password} ${CONFIG.password}`)
        later(currentBot, () => { authCommandPending = false }, 5000)
      }, 700)
    }

    const loginRequested =
      text.includes('please login') || text.includes('please log in') ||
      text.includes('/login ') || text.includes('/login')

    if (!loggedIn && !authCommandPending && loginRequested) {
      authCommandPending = true
      const isIcCraft = String(CONFIG.host || '').toLowerCase() === 'play.iccraft.ir'
      const loginDelay = isIcCraft ? 5000 : 700
      log('AUTH', `Server requested /login (delay ${loginDelay}ms)`)
      later(currentBot, () => {
        if (loggedIn) return
        log('AUTH', 'Sending /login')
        currentBot.chat(`/login ${CONFIG.password}`)
        later(currentBot, () => { authCommandPending = false }, 5000)
      }, loginDelay)
    }

    const loginSuccessful =
      text.includes('you are now logged in') || text.includes('successfully logged in') ||
      text.includes('already logged in') || text.includes('successfully registered') ||
      text.includes('registered successfully') || text.includes('you are now registered')

    if (!loggedIn && loginSuccessful) {
      loggedIn = true
      authCommandPending = false
      loginSuccessAt = Date.now()
      section('LOGIN SUCCESS')
      log('AUTH', 'Account login confirmed')
      beginPlayerListSync(currentBot, 'authentication completed')
      startTotemLoop(currentBot)
      startArmorLoop(currentBot)
      startFoodLoop(currentBot)
      later(currentBot, () => requestAuth(currentBot, true), 4000)
      if (runtimeSettings.bot.sixb6tMode) {
        startPortalFlow(currentBot)
      } else {
        log('MODE', '6b6t mode is OFF, portal flow skipped')
      }

      if (runtimeState.resumableTask?.type === 'farm' && !farmActive) {
        later(currentBot, () => {
          if (!farmActive && !farmStopRequested) {
            notifyOwner(currentBot, 'RESUME', 'Resuming farm task from saved runtime state')
            farmActive = true
            farmLoopPromise = farmSmoothStoneLoop(currentBot)
          }
        }, 2500)
      }

      if (runtimeState.resumableTask?.type === 'mine' && runtimeState.resumableTask?.ore && !mineLoopRunning) {
        later(currentBot, () => {
          if (!mineLoopRunning && runtimeState.resumableTask?.type === 'mine' && runtimeState.resumableTask?.ore) {
            notifyOwner(currentBot, 'RESUME', `Resuming mine task: ${runtimeState.resumableTask.ore}`)
            mineOreLoop(currentBot, runtimeState.resumableTask.ore, CONFIG.owner).catch(error => {
              log('MINE', `resume error: ${error.message}`)
            })
          }
        }, 2500)
      }

      if (runtimeState.skillTraining?.mode && !skillTrainingLoopRunning) {
        later(currentBot, () => {
          if (runtimeState.skillTraining?.mode && !skillTrainingLoopRunning) {
            startSkillTraining(currentBot, CONFIG.owner, runtimeState.skillTraining.mode)
          }
        }, 3000)
      }

      if (String(CONFIG.host || '').toLowerCase() === 'play.iccraft.ir') {
        later(currentBot, () => {
          enqueueChat(currentBot, '/survival', { priority: true, type: 'ICCRAFT' })
        }, 3500)
      }
    }
  })

  currentBot.on('messagestr', message => {
    if (bot !== currentBot) return
    if (!CONFIG.authPassword) return
    if (stripColorCodes(message).includes(CONFIG.authPassword)) {
      log('SECURITY', 'Auth password was seen in a chat message. Change it.')
    }
  })

  currentBot.on('whisper', (username, message) => {
    if (bot !== currentBot) return
    handlePrivateCommand(currentBot, username, message, 'whisper-event')
  })

  currentBot.on('messagestr', message => {
    if (bot !== currentBot) return
    const parsed = parsePrivateMessage(currentBot, message)
    if (!parsed) return
    handlePrivateCommand(currentBot, parsed.username, parsed.message, 'whisper-pattern')
  })

  currentBot.on('chat', (username, message) => {
    if (bot !== currentBot) return
    if (!loggedIn) return
    if (!username || !message) return
    handleCommand(currentBot, username, message, false)
  })

  // ============================================================
  // PLAYER JOIN / LEFT
  // ============================================================

  currentBot.on('playerJoined', player => {
    if (bot !== currentBot) return
    if (!player?.username) return
    const username = player.username
    if (!isValidMinecraftUsername(username)) return
    const normalized = normalizeUsername(username)

    if (!playerListReady) {
      knownPlayers.add(normalized)
      log('PLAYER-SYNC', `Existing player detected: ${username}`)
      updatePlayerSyncTimer(currentBot)
      if (isOwner(username)) later(currentBot, () => requestAuth(currentBot), 3000)
      return
    }
    if (knownPlayers.has(normalized)) {
      log('JOIN-SKIP', `Duplicate join ignored: ${username}`)
      return
    }
    knownPlayers.add(normalized)
    log('JOIN', `${username} joined the server`)
    if (isOwner(username)) later(currentBot, () => requestAuth(currentBot, false), 2500)
    queueWelcome(currentBot, username)
  })

  currentBot.on('playerLeft', player => {
    if (bot !== currentBot) return
    if (!player?.username) return
    const username = player.username
    knownPlayers.delete(normalizeUsername(username))
    log('LEFT', `${username} left the server`)
    // auth session is time-based (30 min) — NOT invalidated on owner leave
  })

  // ============================================================
  // AUTO TOTEM TRIGGERS
  // ============================================================

  currentBot.on('health', () => {
    if (bot !== currentBot) return
    ensureTotem(currentBot)
  })

  // ============================================================
  // MOB DEFENSE TRIGGER — a hostile mob damaged the bot
  // ============================================================

  currentBot.on('entityHurt', entity => {
    if (bot !== currentBot) return
    if (!entity || !currentBot.entity) return
    if (entity.id !== currentBot.entity.id) return
    const threat = nearestHostile(currentBot, 8)
    if (!threat) return
    fleeFromMob(currentBot, threat).catch(error => {
      log('FLEE', `flee error: ${error.message}`)
    })
  })

  currentBot.on('playerCollect', collector => {
    if (bot !== currentBot) return
    if (collector?.username !== currentBot.username) return
    ensureTotem(currentBot)
  })

  // ============================================================
  // PORTAL FLOW (UNTOUCHED)
  // ============================================================

  function startPortalFlow (currentBot) {
    if (portalFlowStarted) return
    portalFlowStarted = true
    log('WAIT', 'Waiting 10 seconds before Portal #1')
    later(currentBot, () => { portal1(currentBot) }, 10_000)
  }

  function portal1 (currentBot) {
    if (!currentBot.entity) {
      log('PORTAL', 'Entity is not ready; retrying Portal #1')
      later(currentBot, () => portal1(currentBot), 2_000); return
    }
    if (inConfiguration) {
      log('PORTAL', 'Configuration is active; retrying Portal #1')
      later(currentBot, () => portal1(currentBot), 2_000); return
    }
    if (!hasValidPosition(currentBot)) {
      log('PORTAL', 'Player position is invalid; retrying Portal #1')
      later(currentBot, () => portal1(currentBot), 2_000); return
    }

    section('PORTAL #1')
    log('POS', position(currentBot))
    setPhysics(currentBot, true)

    later(currentBot, () => {
      if (inConfiguration) {
        stopMovement(currentBot); setPhysics(currentBot, false); return
      }
      log('MOVE', 'Moving forward toward Portal #1')
      currentBot.setControlState('forward', true)
      later(currentBot, () => {
        stopMovement(currentBot)
        setPhysics(currentBot, false)
        log('MOVE', 'Portal #1 movement stopped')
        log('WAIT', 'Waiting 10 seconds before Portal #2')
        later(currentBot, () => portal2(currentBot), 10_000)
      }, 10_000)
    }, 1_500)
  }

  function portal2 (currentBot) {
    if (!currentBot.entity) {
      log('PORTAL', 'Entity is not ready; retrying Portal #2')
      later(currentBot, () => portal2(currentBot), 2_000); return
    }
    if (inConfiguration) {
      log('PORTAL', 'Configuration is active; retrying Portal #2')
      later(currentBot, () => portal2(currentBot), 2_000); return
    }
    if (!hasValidPosition(currentBot)) {
      log('PORTAL', 'Player position is invalid; retrying Portal #2')
      later(currentBot, () => portal2(currentBot), 2_000); return
    }

    section('PORTAL #2')
    log('POS', position(currentBot))
    setPhysics(currentBot, true)

    later(currentBot, () => {
      if (inConfiguration) {
        stopMovement(currentBot); setPhysics(currentBot, false); return
      }
      log('MOVE', 'Moving forward toward Portal #2')
      currentBot.setControlState('forward', true)
      later(currentBot, () => {
        stopMovement(currentBot); setPhysics(currentBot, false)
        log('MOVE', 'Portal #2 movement stopped')
      }, 10_000)
    }, 1_500)
  }

  // ============================================================
  // RESPAWN / DEATH / KICK / END / ERRORS
  // ============================================================

  currentBot.on('respawn', () => {
    if (bot !== currentBot) return
    beginPlayerListSync(currentBot, 'respawn')
    section('RESPAWN')
    cancelPathfinding(currentBot, 'respawn')
    stopMovement(currentBot)
    setPhysics(currentBot, false)
    later(currentBot, () => ensureTotem(currentBot), 2000)
  })

  currentBot.on('death', () => {
    if (bot !== currentBot) return
    log('DEATH', 'Bot died')
    cancelPathfinding(currentBot, 'death')
    farmStopRequested = true
  })

  currentBot.on('kicked', reason => {
    if (bot !== currentBot) return
    clearSessionTimers()
    clearPlayerSyncTimer()
    resetChatQueue()
    stopTotemLoop()
    stopArmorLoop()
    stopFoodLoop()
    loggedIn = false
    skillTrainingStopRequested = true
    skillTrainingLoopRunning = false
    setActivity('Offline', 'kicked')
    stopMovement(currentBot)
    setPhysics(currentBot, false)
    knownPlayers = new Set()
    playerListReady = false
    resetAuthState('kicked')
    section('KICKED')
    console.log(formatKickReason(reason))
  })

  currentBot.on('end', reason => {
    if (bot !== currentBot) return
    clearSessionTimers()
    clearPlayerSyncTimer()
    resetChatQueue()
    stopTotemLoop()
    stopArmorLoop()
    stopFoodLoop()
    loggedIn = false
    skillTrainingStopRequested = true
    skillTrainingLoopRunning = false
    setActivity('Offline', 'reconnecting...')
    stopMovement(currentBot)
    knownPlayers = new Set()
    playerListReady = false
    goActive = false
    invBusy = false
    farmActive = false
    farmStopRequested = false
    resetAuthState('connection ended')
    bot = null
    section('CONNECTION ENDED')
    log('END', reason || 'socketClosed')
    scheduleReconnect(reason || 'socketClosed')
  })

  currentBot.on('error', error => {
    if (bot !== currentBot) return
    section('BOT ERROR')
    console.error(error)
  })

  currentBot._client.on('error', error => {
    if (bot !== currentBot) return
    section('PROTOCOL ERROR')
    console.error(error)
  })
}

// ============================================================
// SHUTDOWN
// ============================================================

function shutdown (signal) {
  if (shuttingDown) return
  shuttingDown = true
  section('SHUTDOWN')
  log('SYSTEM', `Received ${signal}`)

  clearSessionTimers()
  clearPlayerSyncTimer()
  resetChatQueue()
  stopTotemLoop()
  stopArmorLoop()
  stopFoodLoop()

  if (packetSpamSummaryTimer) {
    clearInterval(packetSpamSummaryTimer)
    packetSpamSummaryTimer = null
  }

  knownPlayers = new Set()
  playerListReady = false

  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }

  stopMovement(bot)
  try { bot?.quit('Bot shutdown') } catch {}

  setTimeout(() => process.exit(0), 500)
}

// ============================================================
// WEB UI (port 2000)
// ============================================================

const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>pvp_HSbot · Panel</title>
<style>
:root{
  --bg:#0b0e14; --panel:#12161f; --panel2:#171d29; --line:#232b3a;
  --txt:#e6ecf5; --dim:#8b98ad; --acc:#5eead4; --acc2:#818cf8;
  --ok:#34d399; --warn:#fbbf24; --bad:#f87171;
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  background:radial-gradient(1200px 600px at 80% -10%, #16202e 0%, var(--bg) 55%);
  color:var(--txt); font-family:ui-sans-serif,system-ui,'Segoe UI',Roboto,Arial,sans-serif;
  min-height:100vh; padding:14px;
}
.wrap{max-width:1100px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
header{display:flex;align-items:center;gap:12px;padding:14px 16px;
  background:linear-gradient(135deg,var(--panel) 0%,var(--panel2) 100%);
  border:1px solid var(--line);border-radius:16px}
.ava{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,var(--acc),var(--acc2));
  display:flex;align-items:center;justify-content:center;font-weight:800;color:#08131a;font-size:18px}
h1{font-size:18px;font-weight:700;letter-spacing:.3px}
.sub{color:var(--dim);font-size:12px}
.pill{margin-left:auto;padding:5px 12px;border-radius:999px;font-size:12px;font-weight:700;
  background:#22c55e22;color:var(--ok);border:1px solid #22c55e44}
.pill.off{background:#f8717122;color:var(--bad);border-color:#f8717144}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px}
.stat .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.8px}
.stat .v{font-size:20px;font-weight:800;margin-top:4px}
.stat .v small{font-size:11px;color:var(--dim);font-weight:500}
.bar{height:6px;border-radius:99px;background:#ffffff12;margin-top:8px;overflow:hidden}
.bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--ok),var(--acc));transition:width .5s}
.grid{display:grid;grid-template-columns:1.2fr 1fr;gap:12px}
@media(max-width:820px){ .grid{grid-template-columns:1fr} .stats{grid-template-columns:repeat(2,1fr)} }
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin-bottom:14px}
.tree{display:flex;align-items:stretch;gap:0;flex-wrap:wrap;justify-content:center}
.node{position:relative;min-width:104px;max-width:150px;flex:1 1 104px;
  background:var(--panel2);border:1.5px solid var(--line);border-radius:14px;
  padding:12px 8px 10px;text-align:center;transition:all .35s ease;margin:8px 0}
.node .ic{font-size:22px;display:block;filter:grayscale(1) opacity(.4);transition:filter .3s}
.node .lb{font-size:12px;font-weight:700;margin-top:6px;color:var(--dim);transition:color .3s}
.node .dt{font-size:10px;color:var(--dim);margin-top:3px;min-height:12px}
.node .st{font-size:9px;text-transform:uppercase;letter-spacing:.6px;margin-top:6px;color:var(--dim)}
.node.active{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc),0 0 22px #5eead433;transform:scale(1.05)}
.node.active .ic{filter:none}
.node.active .lb{color:var(--txt)}
.node.active .st{color:var(--acc)}
.node.done{border-color:#34d39966}
.node.done .ic{filter:grayscale(0) opacity(.85)}
.node.done .st{color:var(--ok)}
.link{flex:0 0 26px;height:2px;background:var(--line);align-self:center;border-radius:2px;position:relative;overflow:hidden}
.link.on::after{content:'';position:absolute;inset:0;
  background:linear-gradient(90deg,transparent,var(--acc),transparent);
  animation:flow 1.2s linear infinite}
@keyframes flow{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
.chat{height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;
  font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:12px;
  background:#0a0d13;border:1px solid var(--line);border-radius:12px;padding:10px}
.chat div{line-height:1.45;word-break:break-word;color:#c9d4e3}
.chat .t{color:var(--dim);font-size:10px;margin-right:6px}
.chat::-webkit-scrollbar{width:6px}.chat::-webkit-scrollbar-thumb{background:var(--line);border-radius:3px}
.ctrls{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
button.act{padding:11px 12px;border-radius:12px;border:1px solid var(--line);cursor:pointer;
  background:var(--panel2);color:var(--txt);font-weight:700;font-size:13px;transition:all .2s}
button.act:hover{border-color:var(--acc);transform:translateY(-1px)}
button.act.danger:hover{border-color:var(--bad);color:var(--bad)}
.cmdrow{display:flex;gap:8px;margin-top:10px}
.cmdrow input{flex:1;background:#0a0d13;border:1px solid var(--line);border-radius:12px;
  color:var(--txt);padding:11px 12px;font-size:13px;outline:none}
.cmdrow input:focus{border-color:var(--acc2)}
.cmdrow button{background:linear-gradient(135deg,var(--acc),var(--acc2));color:#08131a;
  border:none;font-weight:800;padding:0 18px;border-radius:12px;cursor:pointer;font-size:13px}
.toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--panel2);
  border:1px solid var(--acc);color:var(--txt);padding:10px 18px;border-radius:12px;
  font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none}
.toast.show{opacity:1}
.pw{display:flex;gap:8px;margin-bottom:12px}
.pw input{flex:1;background:#0a0d13;border:1px solid var(--line);border-radius:12px;
  color:var(--txt);padding:10px 12px;font-size:13px;outline:none}
.pw button{background:var(--panel2);border:1px solid var(--line);color:var(--txt);
  border-radius:12px;padding:0 16px;cursor:pointer;font-weight:700}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="ava">HS</div>
    <div>
      <h1>pvp_HSbot Control Panel</h1>
      <div class="sub" id="srv">connecting…</div>
    </div>
    <div class="pill off" id="online">offline</div>
  </header>

  <div class="stats">
    <div class="stat"><div class="k">Health</div><div class="v" id="hp">–</div>
      <div class="bar"><i id="hpb" style="width:0%"></i></div></div>
    <div class="stat"><div class="k">Food</div><div class="v" id="food">–</div>
      <div class="bar"><i id="fb" style="width:0%"></i></div></div>
    <div class="stat"><div class="k">Position</div><div class="v" id="pos" style="font-size:13px">–</div>
      <div class="sub" id="dim"></div></div>
    <div class="stat"><div class="k">Players online</div><div class="v" id="pl">0</div>
      <div class="sub" id="act"></div></div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Live Activity Flow</h2>
      <div class="tree" id="tree"></div>
    </div>
    <div class="card">
      <h2>Player Chat</h2>
      <div class="chat" id="chat"></div>
    </div>
  </div>

  <div class="card">
    <h2>Controls</h2>
    <div class="pw">
      <input id="pw" type="password" placeholder="Bot auth password (needed for controls)">
      <button onclick="savePw()">Save</button>
    </div>
    <div class="ctrls">
      <button class="act" onclick="act('farm','start')">⛏ Start Farm</button>
      <button class="act danger" onclick="act('farm','stop')">⏹ Stop Farm</button>
      <button class="act danger" onclick="act('go','stop')">🛑 Stop Travel</button>
      <button class="act" onclick="act('msg','stop')">🔕 Stop Welcome Msgs</button>
      <button class="act" onclick="act('msg','start')">🔔 Start Welcome Msgs</button>
    </div>
    <div class="cmdrow">
      <input id="cmd" placeholder="Server command, e.g. /tpa pvp_HS  or  /home base">
      <button onclick="sendCmd()">Send</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const $ = id => document.getElementById(id)
let pw = localStorage.getItem('botpw') || ''
$('pw').value = pw
function savePw(){ pw = $('pw').value; localStorage.setItem('botpw', pw); toast('password saved') }
function toast(t){ const el=$('toast'); el.textContent=t; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),1800) }

const ICONS = {}
async function refresh(){
  try{
    const s = await (await fetch('/api/state')).json()
    $('srv').textContent = s.server + ' · MC ' + s.version
    const on = s.online
    $('online').textContent = on ? 'online' : 'offline'
    $('online').className = 'pill' + (on ? '' : ' off')
    $('hp').innerHTML = Math.round(s.health) + '<small>/20</small>'
    $('hpb').style.width = Math.min(100, s.health/20*100) + '%'
    $('food').innerHTML = Math.round(s.food) + '<small>/20</small>'
    $('fb').style.width = Math.min(100, s.food/20*100) + '%'
    if (s.position) $('pos').textContent = s.position.x+'  '+s.position.y+'  '+s.position.z
    $('dim').textContent = (s.dimension||'').replace('minecraft:','')
    $('pl').textContent = s.players.length
    const mins = Math.floor((Date.now()-s.activity.since)/1000)
    $('act').textContent = s.activity.label + (s.activity.detail ? ' · '+s.activity.detail : '')
      + ' · ' + (mins<60? mins+'s' : Math.floor(mins/60)+'m')
    renderTree(s.tasks)
    renderChat(s.chat)
  }catch(e){}
}
function renderTree(tasks){
  const el = $('tree'); el.innerHTML = ''
  tasks.forEach((t,i)=>{
    const n = document.createElement('div')
    n.className = 'node ' + t.status
    n.innerHTML = '<span class="ic">'+t.icon+'</span><div class="lb">'+t.label+'</div>'+
      '<div class="dt">'+(t.detail||'')+'</div>'+
      '<div class="st">'+(t.status==='active'?'in progress':t.status)+'</div>'
    el.appendChild(n)
    if(i < tasks.length-1){
      const l = document.createElement('div')
      l.className = 'link' + (t.status==='active' ? ' on' : '')
      el.appendChild(l)
    }
  })
}
function renderChat(lines){
  const el = $('chat')
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  el.innerHTML = lines.map(l=>{
    const d = new Date(l.time)
    const hh = String(d.getHours()).padStart(2,'0')
    const mm = String(d.getMinutes()).padStart(2,'0')
    const txt = l.text.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))
    return '<div><span class="t">'+hh+':'+mm+'</span>'+txt+'</div>'
  }).join('')
  if (atBottom) el.scrollTop = el.scrollHeight
}
async function act(kind, value){
  const r = await fetch('/api/action', {method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({kind, value, pw})})
  const j = await r.json().catch(()=>({}))
  toast(r.ok ? (j.msg || 'done') : (j.error || 'failed'))
}
async function sendCmd(){
  const v = $('cmd').value.trim()
  if(!v) return
  $('cmd').value = ''
  const r = await fetch('/api/action', {method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({kind:'cmd', value:v, pw})})
  const j = await r.json().catch(()=>({}))
  toast(r.ok ? (j.msg || 'sent') : (j.error || 'failed'))
}
$('cmd').addEventListener('keydown', e => { if(e.key==='Enter') sendCmd() })
refresh(); setInterval(refresh, 2000)
</script>
</body>
</html>`

function uiBuildState () {
  const p = bot?.entity?.position
  return {
    online: Boolean(bot && loggedIn),
    server: `${CONFIG.host}:${CONFIG.port}`,
    version: CONFIG.version,
    username: bot?.username || CONFIG.username,
    health: bot?.health ?? 0,
    food: bot?.food ?? 0,
    position: p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null,
    dimension: bot?.game?.dimension || '',
    players: Object.keys(bot?.players || {}).filter(n => n !== bot?.username),
    activity: activityState,
    tasks: taskTree,
    chat: uiChatLog.slice(-80)
  }
}

function uiSendJson (res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(body)
}

async function uiHandleAction (req, res) {
  let body = ''
  req.on('data', c => { body += c; if (body.length > 4096) req.destroy() })
  req.on('end', () => {
    let data = {}
    try { data = JSON.parse(body || '{}') } catch {}
    if (!runtimeSettings.bot.noPasswordMode && !safeEquals(String(data.pw || ''), CONFIG.authPassword)) {
      return uiSendJson(res, 403, { error: 'Wrong password' })
    }
    const b = bot
    if (!b || !loggedIn) return uiSendJson(res, 400, { error: 'Bot is offline' })
    const kind = String(data.kind || '')
    const value = String(data.value || '')
    if (kind === 'farm') {
      if (value === 'stop') {
        if (!farmActive) return uiSendJson(res, 400, { error: 'Farm is not active' })
        farmStopRequested = true
        try { b.pathfinder?.setGoal(null) } catch {}
        return uiSendJson(res, 200, { msg: 'Farm stop signal sent' })
      }
      if (farmActive) return uiSendJson(res, 400, { error: 'Farm already running' })
      if (!pathfinderAvailable()) return uiSendJson(res, 400, { error: 'Pathfinder not ready' })
      farmActive = true
      farmStopRequested = false
      farmLoopPromise = farmSmoothStoneLoop(b)
      return uiSendJson(res, 200, { msg: 'Farm started' })
    }
    if (kind === 'go' && value === 'stop') {
      cancelPathfinding(b, 'web ui')
      return uiSendJson(res, 200, { msg: 'Travel stopped' })
    }
    if (kind === 'msg') {
      welcomeOthersEnabled = value !== 'stop'
      return uiSendJson(res, 200, { msg: `Welcome messages ${welcomeOthersEnabled ? 'enabled' : 'disabled'}` })
    }
    if (kind === 'cmd') {
      let cmd = value.trim()
      if (!cmd) return uiSendJson(res, 400, { error: 'Empty command' })
      if (!cmd.startsWith('/')) cmd = `/${cmd}`
      if (cmd.length > 240) return uiSendJson(res, 400, { error: 'Command too long' })
      if (isBlockedOwnerCommand(cmd)) return uiSendJson(res, 403, { error: 'Blocked command' })
      enqueueChat(b, cmd, { priority: true, type: 'UI-COMMAND' })
      return uiSendJson(res, 200, { msg: `Sent: ${cmd}` })
    }
    uiSendJson(res, 400, { error: 'Unknown action' })
  })
}

function startUiServer () {
  if (!CONFIG.uiEnabled) {
    log('UI', 'Web UI disabled by configuration')
    return
  }
  if (uiServer) return
  uiServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(UI_HTML)
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return uiSendJson(res, 200, uiBuildState())
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      return uiHandleAction(req, res)
    }
    res.writeHead(404); res.end('not found')
  })
  uiServer.on('error', error => {
    log('UI', `Server error: ${error.message}`)
  })
  uiServer.listen(CONFIG.uiPort, () => {
    log('UI', `Web panel live on http://localhost:${CONFIG.uiPort}`)
  })
}

const I18N = {
  fa: {
    chooseLang: 'لطفا زبان را انتخاب کن:',
    welcome: 'پنل تلگرام فعال شد ✅',
    mainMenu: 'منوی اصلی',
    panel: 'پنل مدیریت',
    status: 'وضعیت',
    setServer: 'تغییر IP/Port',
    setOwner: 'تغییر Owner',
    setPrefix: 'تغییر Prefix',
    toggle6b6t: '6b6t مود',
    toggleNoPw: 'بدون رمز',
    setAi: 'تنظیم AI',
    setAuthPw: 'تغییر رمز پنل',
    setServerPw: 'تغییر رمز سرور',
    setTpaCmd: 'دستور Auto-TPA',
    toggleRequireAuth: 'اجبار احراز هویت',
    saveDone: 'ذخیره شد ✅',
    needAdmin: 'دسترسی ندارید.',
    promptServer: 'فرمت: host:port  مثال: play.iccraft.ir:25565',
    promptOwner: 'نام Owner جدید را بفرست',
    promptPrefix: 'پریفیکس جدید را بفرست (مثل !)',
    promptAiUrl: 'AI base_url را ارسال کن',
    promptAiModel: 'AI model را ارسال کن',
    promptAiKey: 'AI API key را ارسال کن',
    promptAuthPw: 'رمز جدید پنل (!auth) را ارسال کن',
    promptServerPw: 'رمز جدید /login سرور را ارسال کن',
    promptTpaCmd: 'دستور auto-accept را ارسال کن. مثال: /tpaccept {player}',
    back: 'بازگشت',
    afkOn: 'AFK روشن شد.',
    afkOff: 'AFK خاموش شد.'
  },
  en: {
    chooseLang: 'Please choose language:',
    welcome: 'Telegram panel enabled ✅',
    mainMenu: 'Main menu',
    panel: 'Admin panel',
    status: 'Status',
    setServer: 'Set IP/Port',
    setOwner: 'Set Owner',
    setPrefix: 'Set Prefix',
    toggle6b6t: '6b6t mode',
    toggleNoPw: 'No password',
    setAi: 'AI settings',
    setAuthPw: 'Set panel password',
    setServerPw: 'Set server password',
    setTpaCmd: 'Auto-TPA command',
    toggleRequireAuth: 'Require auth',
    saveDone: 'Saved ✅',
    needAdmin: 'Access denied.',
    promptServer: 'Format: host:port  example: play.iccraft.ir:25565',
    promptOwner: 'Send new owner username',
    promptPrefix: 'Send new command prefix (like !)',
    promptAiUrl: 'Send AI base_url',
    promptAiModel: 'Send AI model',
    promptAiKey: 'Send AI API key',
    promptAuthPw: 'Send new panel auth password (!auth)',
    promptServerPw: 'Send new /login server password',
    promptTpaCmd: 'Send auto-accept command. Example: /tpaccept {player}',
    back: 'Back',
    afkOn: 'AFK enabled.',
    afkOff: 'AFK disabled.'
  }
}

function tgLang (chatId) {
  return runtimeSettings.langByChat[String(chatId)] || 'fa'
}

function t (chatId, key) {
  const lang = tgLang(chatId)
  return I18N[lang]?.[key] || I18N.fa[key] || key
}

function tgIsAdmin (chatId) {
  const id = String(chatId)
  if (!runtimeSettings.telegram.adminIds.length) {
    runtimeSettings.telegram.adminIds.push(id)
    saveRuntimeSettings()
    return true
  }
  return runtimeSettings.telegram.adminIds.includes(id)
}

function tgMainKeyboard (chatId) {
  return {
    keyboard: [
      [{ text: `📊 ${t(chatId, 'status')}` }, { text: `🛠 ${t(chatId, 'panel')}` }],
      [{ text: `🥱 AFK ON` }, { text: `🏃 AFK OFF` }],
      [{ text: '📈 Skill Scan' }, { text: '⚔️ Train Fight' }, { text: '🏃 Train Agility' }],
      [{ text: '⛏ Train Mining' }, { text: '🌲 Train Foraging' }, { text: '🌾 Train Farming' }],
      [{ text: '🧱 Train Excavation' }, { text: '🛡 Train Defense' }],
      [{ text: '🧰 Sort Chest' }, { text: '🛑 Skill Stop' }]
    ],
    resize_keyboard: true
  }
}

function tgPanelInline (chatId) {
  return {
    inline_keyboard: [
      [{ text: `🌐 ${t(chatId, 'setServer')}`, callback_data: 'set_server' }],
      [{ text: `👑 ${t(chatId, 'setOwner')}`, callback_data: 'set_owner' }],
      [{ text: `⌨️ ${t(chatId, 'setPrefix')}`, callback_data: 'set_prefix' }],
      [{ text: `🔑 ${t(chatId, 'setAuthPw')}`, callback_data: 'set_auth_pw' }],
      [{ text: `🧷 ${t(chatId, 'setServerPw')}`, callback_data: 'set_server_pw' }],
      [{ text: `📨 ${t(chatId, 'setTpaCmd')}`, callback_data: 'set_tpa_cmd' }],
      [{ text: `🎛 ${t(chatId, 'toggle6b6t')}`, callback_data: 'toggle_6b6t' }],
      [{ text: `🔐 ${t(chatId, 'toggleNoPw')}`, callback_data: 'toggle_nopw' }],
      [{ text: `🛡 ${t(chatId, 'toggleRequireAuth')}`, callback_data: 'toggle_require_auth' }],
      [{ text: `🤖 ${t(chatId, 'setAi')}`, callback_data: 'ai_menu' }],
      [{ text: '📈 Scan Skills', callback_data: 'skills_scan' }],
      [{ text: '⚔️ Train Fighting', callback_data: 'skills_train_fighting' }],
      [{ text: '🏃 Train Agility', callback_data: 'skills_train_agility' }],
      [{ text: '⛏ Train Mining', callback_data: 'skills_train_mining' }],
      [{ text: '🌲 Train Foraging', callback_data: 'skills_train_foraging' }],
      [{ text: '🌾 Train Farming', callback_data: 'skills_train_farming' }],
      [{ text: '🧱 Train Excavation', callback_data: 'skills_train_excavation' }],
      [{ text: '🛡 Train Defense', callback_data: 'skills_train_defense' }],
      [{ text: '🛑 Stop Training', callback_data: 'skills_stop' }],
      [{ text: '🧰 Sort Chest', callback_data: 'sort_chest' }]
    ]
  }
}

function tgBotStatusText () {
  return [
    `Server: ${CONFIG.host}:${CONFIG.port}`,
    `User: ${CONFIG.username}`,
    `Owner: ${CONFIG.owner}`,
    `Online: ${loggedIn ? 'YES' : 'NO'}`,
    `6b6t: ${runtimeSettings.bot.sixb6tMode ? 'ON' : 'OFF'}`,
    `RequireAuth: ${runtimeSettings.bot.requireAuth ? 'ON' : 'OFF'}`,
    `NoPassword: ${runtimeSettings.bot.noPasswordMode ? 'ON' : 'OFF'}`,
    `AFK: ${runtimeState.afkMode ? 'ON' : 'OFF'}`,
    `Mode: ${currentModeId()}`,
    `SkillTrain: ${runtimeState.skillTraining?.mode || 'none'}`
  ].join('\n')
}

function setTelegramChatState (chatId, state) {
  telegramChatState.set(String(chatId), state)
}

function getTelegramChatState (chatId) {
  return telegramChatState.get(String(chatId)) || null
}

function clearTelegramChatState (chatId) {
  telegramChatState.delete(String(chatId))
}

function reconnectForSettingsChange (reason) {
  log('CONFIG', `Reconnect requested: ${reason}`)
  if (bot) {
    try { bot.quit(`reconnect: ${reason}`) } catch {}
  } else {
    scheduleReconnect(reason)
  }
}

function startTelegramPanel () {
  if (!runtimeSettings.telegram.enabled) return
  if (!runtimeSettings.telegram.token) {
    log('TG', 'TELEGRAM_BOT_TOKEN not configured, telegram panel skipped')
    return
  }
  if (!TelegramBotLib) {
    log('TG', 'node-telegram-bot-api is not installed. Run: npm i node-telegram-bot-api')
    return
  }
  if (telegramBot) return

  telegramBot = new TelegramBotLib(runtimeSettings.telegram.token, { polling: true })

  telegramBot.setMyCommands([
    { command: 'start', description: 'Open panel / پنل' },
    { command: 'status', description: 'Bot status' },
    { command: 'panel', description: 'Admin panel' },
    { command: 'commands', description: 'Minecraft command list' }
  ]).catch(() => {})

  telegramBot.onText(/^\/start$/, msg => {
    const chatId = msg.chat.id
    if (!tgIsAdmin(chatId)) {
      telegramBot.sendMessage(chatId, t(chatId, 'needAdmin')).catch(() => {})
      return
    }
    telegramBot.sendMessage(chatId, t(chatId, 'chooseLang'), {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'فارسی 🇮🇷', callback_data: 'lang_fa' }],
          [{ text: 'English 🇬🇧', callback_data: 'lang_en' }]
        ]
      }
    }).catch(() => {})
  })

  telegramBot.onText(/^\/status$/, msg => {
    const chatId = msg.chat.id
    if (!tgIsAdmin(chatId)) return
    telegramBot.sendMessage(chatId, tgBotStatusText(), { reply_markup: tgMainKeyboard(chatId) }).catch(() => {})
  })

  telegramBot.onText(/^\/panel$/, msg => {
    const chatId = msg.chat.id
    if (!tgIsAdmin(chatId)) return
    telegramBot.sendMessage(chatId, t(chatId, 'panel'), { reply_markup: tgPanelInline(chatId) }).catch(() => {})
  })

  telegramBot.onText(/^\/commands$/, msg => {
    const chatId = msg.chat.id
    if (!tgIsAdmin(chatId)) return
    const p = CONFIG.chatPrefix
    const lines = [
      `${p}auth <password>`,
      `${p}go <x> <y> <z> | ${p}go stop`,
      `${p}farm Smooth-Stone | ${p}farm stop`,
      `${p}mine <ore> | ${p}mine stop`,
      `${p}skills scan|train|stop|status`,
      `${p}sortchest | ${p}custom add|del|list`,
      `${p}ai <task> | ${p}afk on|off`
    ]
    telegramBot.sendMessage(chatId, lines.join('\n')).catch(() => {})
  })

  telegramBot.on('callback_query', query => {
    const chatId = query.message?.chat?.id
    const data = query.data
    if (!chatId || !data) return
    if (!tgIsAdmin(chatId)) return

    if (data === 'lang_fa' || data === 'lang_en') {
      const lang = data.endsWith('_en') ? 'en' : 'fa'
      runtimeSettings.langByChat[String(chatId)] = lang
      saveRuntimeSettings()
      telegramBot.sendMessage(chatId, t(chatId, 'welcome'), { reply_markup: tgMainKeyboard(chatId) }).catch(() => {})
      telegramBot.answerCallbackQuery(query.id).catch(() => {})
      return
    }

    if (data === 'set_server') {
      setTelegramChatState(chatId, { mode: 'set_server' })
      telegramBot.sendMessage(chatId, t(chatId, 'promptServer')).catch(() => {})
    } else if (data === 'set_owner') {
      setTelegramChatState(chatId, { mode: 'set_owner' })
      telegramBot.sendMessage(chatId, t(chatId, 'promptOwner')).catch(() => {})
    } else if (data === 'set_prefix') {
      setTelegramChatState(chatId, { mode: 'set_prefix' })
      telegramBot.sendMessage(chatId, t(chatId, 'promptPrefix')).catch(() => {})
    } else if (data === 'set_auth_pw') {
      setTelegramChatState(chatId, { mode: 'set_auth_pw' })
      telegramBot.sendMessage(chatId, t(chatId, 'promptAuthPw')).catch(() => {})
    } else if (data === 'set_server_pw') {
      setTelegramChatState(chatId, { mode: 'set_server_pw' })
      telegramBot.sendMessage(chatId, t(chatId, 'promptServerPw')).catch(() => {})
    } else if (data === 'set_tpa_cmd') {
      setTelegramChatState(chatId, { mode: 'set_tpa_cmd' })
      telegramBot.sendMessage(chatId, t(chatId, 'promptTpaCmd')).catch(() => {})
    } else if (data === 'toggle_6b6t') {
      runtimeSettings.bot.sixb6tMode = !runtimeSettings.bot.sixb6tMode
      saveRuntimeSettings()
      telegramBot.sendMessage(chatId, `${t(chatId, 'toggle6b6t')}: ${runtimeSettings.bot.sixb6tMode ? 'ON' : 'OFF'}`).catch(() => {})
    } else if (data === 'toggle_nopw') {
      runtimeSettings.bot.noPasswordMode = !runtimeSettings.bot.noPasswordMode
      saveRuntimeSettings()
      telegramBot.sendMessage(chatId, `${t(chatId, 'toggleNoPw')}: ${runtimeSettings.bot.noPasswordMode ? 'ON' : 'OFF'}`).catch(() => {})
    } else if (data === 'toggle_require_auth') {
      runtimeSettings.bot.requireAuth = !runtimeSettings.bot.requireAuth
      saveRuntimeSettings()
      telegramBot.sendMessage(chatId, `${t(chatId, 'toggleRequireAuth')}: ${runtimeSettings.bot.requireAuth ? 'ON' : 'OFF'}`).catch(() => {})
    } else if (data === 'ai_menu') {
      setTelegramChatState(chatId, { mode: 'ai_url' })
      telegramBot.sendMessage(chatId, t(chatId, 'promptAiUrl')).catch(() => {})
    } else if (data === 'skills_scan') {
      if (!bot || !loggedIn) {
        telegramBot.sendMessage(chatId, 'Bot is offline').catch(() => {})
      } else {
        scanSkillsViaChat(bot)
          .then(snapshot => telegramBot.sendMessage(chatId, snapshot ? formatSkillSnapshot(snapshot) : 'No skill data detected').catch(() => {}))
          .catch(error => telegramBot.sendMessage(chatId, `Scan failed: ${error.message}`).catch(() => {}))
      }
    } else if (data.startsWith('skills_train_')) {
      if (!bot || !loggedIn) telegramBot.sendMessage(chatId, 'Bot is offline').catch(() => {})
      else startSkillTraining(bot, CONFIG.owner, data.replace('skills_train_', ''))
    } else if (data === 'skills_stop') {
      if (!bot || !loggedIn) telegramBot.sendMessage(chatId, 'Bot is offline').catch(() => {})
      else stopSkillTraining(bot, CONFIG.owner)
    } else if (data === 'sort_chest') {
      if (!bot || !loggedIn) telegramBot.sendMessage(chatId, 'Bot is offline').catch(() => {})
      else commandSortChest(bot, CONFIG.owner)
    }

    telegramBot.answerCallbackQuery(query.id).catch(() => {})
  })

  telegramBot.on('message', msg => {
    const chatId = msg.chat?.id
    const text = String(msg.text || '').trim()
    if (!chatId || !text || text.startsWith('/')) return
    if (!tgIsAdmin(chatId)) return

    if (text.startsWith('📊') || text === t(chatId, 'status')) {
      telegramBot.sendMessage(chatId, tgBotStatusText(), { reply_markup: tgMainKeyboard(chatId) }).catch(() => {})
      return
    }

    if (text.startsWith('🛠') || text === t(chatId, 'panel')) {
      telegramBot.sendMessage(chatId, t(chatId, 'panel'), { reply_markup: tgPanelInline(chatId) }).catch(() => {})
      return
    }

    if (text.includes('AFK ON')) {
      runtimeState.afkMode = true
      saveRuntimeState()
      telegramBot.sendMessage(chatId, t(chatId, 'afkOn')).catch(() => {})
      return
    }

    if (text.includes('AFK OFF')) {
      runtimeState.afkMode = false
      saveRuntimeState()
      telegramBot.sendMessage(chatId, t(chatId, 'afkOff')).catch(() => {})
      return
    }

    if (text.includes('Skill Scan')) {
      if (!bot || !loggedIn) telegramBot.sendMessage(chatId, 'Bot is offline').catch(() => {})
      else {
        scanSkillsViaChat(bot)
          .then(snapshot => telegramBot.sendMessage(chatId, snapshot ? formatSkillSnapshot(snapshot) : 'No skill data detected').catch(() => {}))
          .catch(error => telegramBot.sendMessage(chatId, `Scan failed: ${error.message}`).catch(() => {}))
      }
      return
    }

    if (text.includes('Train Fight')) {
      if (!bot || !loggedIn) telegramBot.sendMessage(chatId, 'Bot is offline').catch(() => {})
      else startSkillTraining(bot, CONFIG.owner, 'fighting')
      return
    }

    if (text.includes('Train Agility')) {
      if (!bot || !loggedIn) telegramBot.sendMessage(chatId, 'Bot is offline').catch(() => {})
      else startSkillTraining(bot, CONFIG.owner, 'agility')
      return
    }

    if (text.includes('Train Mining')) {
      if (!bot || !loggedIn) telegramBot.sendMessage(chatId, 'Bot is offline').catch(() => {})
      else startSkillTraining(bot, CONFIG.owner, 'mining')
      return
    }

    if (text.includes('Train Foraging')) {
      if (!bot || !loggedIn) telegramBot.sendMessage(chatId, 'Bot is offline').catch(() => {})
      else startSkillTraining(bot, CONFIG.owner, 'foraging')
      return
    }

    if (text.includes('Train Farming')) {
      if (!bot || !loggedIn) telegramBot.sendMessage(chatId, 'Bot is offline').catch(() => {})
      else startSkillTraining(bot, CONFIG.owner, 'farming')
      return
    }

    if (text.includes('Train Excavation')) {
      if (!bot || !loggedIn) telegramBot.sendMessage(chatId, 'Bot is offline').catch(() => {})
      else startSkillTraining(bot, CONFIG.owner, 'excavation')
      return
    }

    if (text.includes('Train Defense')) {
      if (!bot || !loggedIn) telegramBot.sendMessage(chatId, 'Bot is offline').catch(() => {})
      else startSkillTraining(bot, CONFIG.owner, 'defense')
      return
    }

    if (text.includes('Sort Chest')) {
      if (!bot || !loggedIn) telegramBot.sendMessage(chatId, 'Bot is offline').catch(() => {})
      else commandSortChest(bot, CONFIG.owner)
      return
    }

    if (text.includes('Skill Stop')) {
      if (!bot || !loggedIn) telegramBot.sendMessage(chatId, 'Bot is offline').catch(() => {})
      else stopSkillTraining(bot, CONFIG.owner)
      return
    }

    const state = getTelegramChatState(chatId)
    if (!state) return

    if (state.mode === 'set_server') {
      const [host, portRaw] = text.split(':')
      const port = Number(portRaw || 25565)
      if (!host || !Number.isFinite(port)) {
        telegramBot.sendMessage(chatId, t(chatId, 'promptServer')).catch(() => {})
        return
      }
      runtimeSettings.server.host = host.trim()
      runtimeSettings.server.port = port
      applyRuntimeSettingsToConfig()
      saveRuntimeSettings()
      clearTelegramChatState(chatId)
      telegramBot.sendMessage(chatId, t(chatId, 'saveDone')).catch(() => {})
      reconnectForSettingsChange('server changed from telegram')
      return
    }

    if (state.mode === 'set_owner') {
      runtimeSettings.bot.owner = text.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16) || runtimeSettings.bot.owner
      applyRuntimeSettingsToConfig()
      saveRuntimeSettings()
      clearTelegramChatState(chatId)
      telegramBot.sendMessage(chatId, t(chatId, 'saveDone')).catch(() => {})
      return
    }

    if (state.mode === 'set_prefix') {
      runtimeSettings.bot.chatPrefix = text.slice(0, 2)
      applyRuntimeSettingsToConfig()
      saveRuntimeSettings()
      clearTelegramChatState(chatId)
      telegramBot.sendMessage(chatId, t(chatId, 'saveDone')).catch(() => {})
      return
    }

    if (state.mode === 'set_auth_pw') {
      runtimeSettings.bot.authPassword = text.slice(0, 128)
      applyRuntimeSettingsToConfig()
      saveRuntimeSettings()
      clearTelegramChatState(chatId)
      resetAuthState('auth password changed from telegram')
      telegramBot.sendMessage(chatId, t(chatId, 'saveDone')).catch(() => {})
      return
    }

    if (state.mode === 'set_server_pw') {
      runtimeSettings.server.password = text.slice(0, 256)
      applyRuntimeSettingsToConfig()
      saveRuntimeSettings()
      clearTelegramChatState(chatId)
      telegramBot.sendMessage(chatId, t(chatId, 'saveDone')).catch(() => {})
      reconnectForSettingsChange('server password changed from telegram')
      return
    }

    if (state.mode === 'set_tpa_cmd') {
      runtimeSettings.bot.tpaAcceptCommand = text.startsWith('/') ? text : `/${text}`
      saveRuntimeSettings()
      clearTelegramChatState(chatId)
      telegramBot.sendMessage(chatId, t(chatId, 'saveDone')).catch(() => {})
      return
    }

    if (state.mode === 'ai_url') {
      runtimeSettings.ai.baseUrl = text
      saveRuntimeSettings()
      setTelegramChatState(chatId, { mode: 'ai_model' })
      telegramBot.sendMessage(chatId, t(chatId, 'promptAiModel')).catch(() => {})
      return
    }
    if (state.mode === 'ai_model') {
      runtimeSettings.ai.model = text
      saveRuntimeSettings()
      setTelegramChatState(chatId, { mode: 'ai_key' })
      telegramBot.sendMessage(chatId, t(chatId, 'promptAiKey')).catch(() => {})
      return
    }
    if (state.mode === 'ai_key') {
      runtimeSettings.ai.apiKey = text
      saveRuntimeSettings()
      clearTelegramChatState(chatId)
      telegramBot.sendMessage(chatId, t(chatId, 'saveDone')).catch(() => {})

      const base = String(runtimeSettings.ai.baseUrl || '').replace(/\/$/, '')
      if (base) {
        fetch(`${base}/models`, {
          headers: {
            ...(runtimeSettings.ai.apiKey ? { Authorization: `Bearer ${runtimeSettings.ai.apiKey}` } : {})
          }
        })
          .then(r => r.json())
          .then(j => {
            const names = (j?.data || []).map(m => m.id).filter(Boolean).slice(0, 20)
            if (names.length) {
              telegramBot.sendMessage(chatId, `Models:\n${names.join('\n')}`).catch(() => {})
            }
          })
          .catch(() => {})
      }
    }
  })

  telegramBot.on('polling_error', error => {
    log('TG', `Polling error: ${error.message}`)
  })

  log('TG', 'Telegram panel started')
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', error => {
  log('UNHANDLED', String(error?.message || error))
})

startStuckWatchdog()
startUiServer()
startTelegramPanel()
start()
