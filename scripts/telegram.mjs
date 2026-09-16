// Telegram transport for the watchdog: alerts with inline buttons, plus the
// long-poll loop that turns a button press back into an action.
// Uses its own bot: Telegram delivers updates to a single consumer, so a bot
// already used by another integration cannot be shared.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env.local");

export function loadEnv() {
  try {
    for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {}
  return {
    token: process.env.TELEGRAM_BOT_TOKEN?.trim() || null,
    chatId: process.env.TELEGRAM_CHAT_ID?.trim() || null,
  };
}

function saveEnvValue(key, value) {
  let text = "";
  try { text = fs.readFileSync(ENV_FILE, "utf8"); } catch {}
  const line = `${key}=${value}`;
  text = new RegExp(`^${key}=.*$`, "m").test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : `${text.replace(/\n*$/, "")}\n${line}\n`;
  fs.writeFileSync(ENV_FILE, text);
  process.env[key] = value;
}

async function api(method, body, { timeoutMs = 15000 } = {}) {
  const { token } = loadEnv();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set in .env.local");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(`Telegram ${method}: ${data.description}`);
    err.parameters = data.parameters;
    throw err;
  }
  return data.result;
}

// Point alerts at a different chat (e.g. you DM the bot "/here").
export function setChatId(chatId) {
  saveEnvValue("TELEGRAM_CHAT_ID", String(chatId));
}

export function isConfigured() {
  const { token, chatId } = loadEnv();
  return Boolean(token && chatId);
}

export async function sendAlert(text, buttons) {
  const { chatId } = loadEnv();
  const body = (chat_id) => ({
    chat_id, text, parse_mode: "HTML", disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: [buttons] } } : {}),
  });
  try {
    return (await api("sendMessage", body(chatId))).message_id;
  } catch (e) {
    // A group promoted to a supergroup gets a new id; follow it once.
    const moved = e.parameters?.migrate_to_chat_id;
    if (!moved) throw e;
    saveEnvValue("TELEGRAM_CHAT_ID", String(moved));
    return (await api("sendMessage", body(String(moved)))).message_id;
  }
}

export async function editAlert(messageId, text) {
  const { chatId } = loadEnv();
  try {
    await api("editMessageText", {
      chat_id: chatId, message_id: messageId, text,
      parse_mode: "HTML", disable_web_page_preview: true,
    });
  } catch { /* message too old or unchanged — not worth failing the action */ }
}

export async function answerCallback(callbackId, text) {
  try { await api("answerCallbackQuery", { callback_query_id: callbackId, text }); } catch {}
}

// Long-poll. Returns [updates, nextOffset]; resolves empty on timeout.
export async function pollUpdates(offset) {
  try {
    const updates = await api("getUpdates", {
      offset, timeout: 25, allowed_updates: ["callback_query", "message"],
    }, { timeoutMs: 30000 });
    const next = updates.length ? updates[updates.length - 1].update_id + 1 : offset;
    return [updates, next];
  } catch (e) {
    if (/aborted|timeout/i.test(e.message)) return [[], offset];
    throw e;
  }
}

// Pairing: whoever writes to the bot first becomes the alert recipient.
export async function pair() {
  const { token } = loadEnv();
  if (!token) {
    console.error("Put TELEGRAM_BOT_TOKEN in .env.local first (the token from BotFather).");
    process.exit(1);
  }
  const me = await api("getMe");
  console.log(`Bot: @${me.username}. Open it in Telegram and send any message (e.g. /start)…`);
  let offset = 0;
  for (let i = 0; i < 24; i++) {
    const [updates, next] = await pollUpdates(offset);
    offset = next;
    for (const u of updates) {
      const chat = u.message?.chat ?? u.callback_query?.message?.chat;
      if (chat?.id) {
        saveEnvValue("TELEGRAM_CHAT_ID", String(chat.id));
        console.log(`✔ Paired: alerts will go to chat ${chat.id} (${chat.username ?? chat.title ?? "direct message"})`);
        await sendAlert("👋 Session watchdog connected. I will write here when a session dies or the usage window runs low.");
        return;
      }
    }
  }
  console.error("No message arrived. Run it again and write to the bot.");
  process.exit(1);
}
