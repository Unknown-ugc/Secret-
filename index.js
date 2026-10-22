require("dotenv").config();

const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const CHANNEL_ID = process.env.CHANNEL_ID;
const API_KEY = process.env.API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let eggs = [];
const MAX_EGGS = 1000;

// Parse JSON directly, inside a code block, or embedded in surrounding text.
function parseEggs(text) {
  if (!text || typeof text !== "string") return [];

  const cleaned = text
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  const candidates = [cleaned];

  const firstObject = cleaned.indexOf("{");
  const lastObject = cleaned.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.push(cleaned.slice(firstObject, lastObject + 1));
  }

  const firstArray = cleaned.indexOf("[");
  const lastArray = cleaned.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) {
    candidates.push(cleaned.slice(firstArray, lastArray + 1));
  }

  for (const candidate of [...new Set(candidates)]) {
    let data;
    try {
      data = JSON.parse(candidate);
    } catch {
      continue;
    }

    let list;
    if (Array.isArray(data)) {
      list = data;
    } else if (Array.isArray(data.eggs)) {
      list = data.eggs;
    } else if (Array.isArray(data.data?.eggs)) {
      list = data.data.eggs;
    } else if (data.egg && typeof data.egg === "object") {
      list = [data.egg];
    } else {
      list = [data];
    }

    const normalized = [];

    for (const item of list) {
      if (!item || typeof item !== "object") continue;

      const name = item.name ?? item.Name ?? item.eggName ?? item.egg_name;
      const rarity = item.rarity ?? item.Rarity ?? item.tier ?? item.Tier;

      if (typeof name !== "string" || !name.trim()) continue;

      normalized.push({
        name: name.trim(),
        rarity:
          typeof rarity === "string" && rarity.trim()
            ? rarity.trim()
            : "Unknown",
        sizeName:
          item.sizeName ?? item.size_name ?? item.sizeNameText ?? "Unknown",
        kg: Number(item.kg ?? item.scale ?? item.weight) || 0,
        value:
          item.value ??
          item.moneyPerSecond ??
          item.money_per_second ??
          "$0/s",
        valueNum:
          Number(
            item.valueNum ?? item.value_num ?? item.moneyPerSecondNum
          ) || 0,
        image:
          item.image ??
          item.icon ??
          item.imageUrl ??
          item.image_url ??
          "",
        serverId:
          item.serverId ??
          item.server_id ??
          item.jobId ??
          item.job_id ??
          "",
        scale: Number(item.scale ?? item.kg ?? item.weight) || 1
      });
    }

    if (normalized.length) return normalized;
  }

  return [];
}

// Batch eggs arriving close together.
const pendingEggs = [];
let flushScheduled = false;
const BATCH_WINDOW_MS = 50;

function queueEggs(list, messageId) {
  if (!Array.isArray(list) || !list.length) return;

  for (const egg of list) {
    pendingEggs.push({ egg, messageId });
  }

  if (flushScheduled) return;

  flushScheduled = true;
  setTimeout(flushEggBatch, BATCH_WINDOW_MS);
}

function flushEggBatch() {
  flushScheduled = false;
  if (!pendingEggs.length) return;

  const batch = pendingEggs.splice(0, pendingEggs.length);
  const timestamp = new Date().toISOString();

  for (const { egg, messageId } of batch) {
    eggs.push({
      id: `${messageId}-${Math.random().toString(36).slice(2, 10)}`,
      name: egg.name,
      rarity: egg.rarity,
      sizeName: egg.sizeName || "Unknown",
      kg: Number(egg.kg) || 0,
      value: egg.value || "$0/s",
      valueNum: Number(egg.valueNum) || 0,
      image: egg.image || "",
      serverId: egg.serverId || "",
      scale: Number(egg.scale) || 1,
      updatedAt: timestamp
    });
  }

  eggs.sort((a, b) => b.valueNum - a.valueNum);

  if (eggs.length > MAX_EGGS) {
    eggs = eggs.slice(0, MAX_EGGS);
  }

  const sources = new Set(batch.map(item => item.messageId));

  console.log(
    `[EGG BATCH] messages=${sources.size} eggs=${batch.length} total=${eggs.length}`
  );
}

function getMessageTexts(message) {
  const texts = [];

  if (message.content) texts.push(message.content);

  for (const embed of message.embeds || []) {
    if (embed.title) texts.push(embed.title);
    if (embed.description) texts.push(embed.description);

    for (const field of embed.fields || []) {
      if (field.name) texts.push(field.name);
      if (field.value) texts.push(field.value);
    }

    if (embed.footer?.text) texts.push(embed.footer.text);
  }

  return texts;
}

// NEW MESSAGES ONLY — no history fetch.
client.on("messageCreate", message => {
  if (message.channelId !== CHANNEL_ID) return;

  try {
    const texts = getMessageTexts(message);
    let parsedCount = 0;
    const parsedEggs = [];

    for (const text of texts) {
      const parsed = parseEggs(text);

      if (parsed.length) {
        parsedCount += parsed.length;
        parsedEggs.push(...parsed);
      }
    }

    if (parsedEggs.length > 0) {
      queueEggs(parsedEggs, message.id);

      console.log(
        `[EGG RECEIVED] message=${message.id} source=${
          message.webhookId ? "webhook" : "user"
        } parsed=${parsedCount} queued=${parsedEggs.length}`
      );
    } else {
      const preview = (
        message.content ||
        message.embeds?.[0]?.description ||
        ""
      ).slice(0, 140);

      console.log(
        `[NO EGG PARSED] message=${message.id} source=${
          message.webhookId ? "webhook" : "user"
        } content=${JSON.stringify(preview)}`
      );
    }
  } catch (error) {
    console.error(`[MESSAGE ERROR] message=${message.id}:`, error);
  }
});

// Remove an egg that has disappeared from a server.
app.post("/egg-gone", (req, res) => {
  const { serverId, name, scale } = req.body || {};

  if (!serverId || !name) return res.sendStatus(400);

  const before = eggs.length;

  eggs = eggs.filter(
    e =>
      !(
        e.serverId === serverId &&
        e.name.toLowerCase() === String(name).toLowerCase() &&
        Math.abs((e.scale || e.kg || 0) - Number(scale || 0)) < 0.02
      )
  );

  res.json({
    ok: true,
    removed: before - eggs.length,
    count: eggs.length
  });
});

// Reset at real Asia/Manila five-minute marks.
function millisecondsUntilNextFiveMinuteMark() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Manila",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(now);

  const minute = Number(parts.find(p => p.type === "minute").value);
  const second = Number(parts.find(p => p.type === "second").value);

  const secondsToNext = ((5 - (minute % 5)) % 5) * 60 - second;

  return (secondsToNext <= 0 ? 300 : secondsToNext) * 1000;
}

function scheduleNextReset() {
  setTimeout(() => {
    const removed = eggs.length;
    eggs = [];

    const time = new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(new Date());

    console.log(
      `Live egg list reset at ${time} Philippine time. Cleared ${removed} eggs.`
    );

    scheduleNextReset();
  }, millisecondsUntilNextFiveMinuteMark());
}

scheduleNextReset();

client.once("clientReady", () => {
  console.log(`CAT HUB BOT online: ${client.user.tag}`);
  console.log("History loading disabled; new messages only.");
});

app.get("/", (_req, res) => {
  res.json({
    name: "CAT HUB BOT API",
    status: "online"
  });
});

app.get("/health", (_req, res) => {
  res.set("Cache-Control", "no-store");

  res.json({
    ok: true,
    botReady: client.isReady(),
    liveEggs: eggs.length,
    resetTimeZone: "Asia/Manila",
    nextReset: "Next 5-minute wall-clock mark"
  });
});

app.get("/eggs", (req, res) => {
  if (!API_KEY || req.get("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.set("Cache-Control", "no-store");
  res.json({ ok: true, count: eggs.length, eggs });
});

app.get("/public-eggs", (req, res) => {
  const requested = Number.parseInt(req.query.limit, 10);
  const limit = Math.min(Math.max(requested || 100, 1), MAX_EGGS);

  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");

  res.json({
    ok: true,
    count: eggs.length,
    eggs: eggs.slice(0, limit).map(e => ({
      name: e.name,
      rarity: e.rarity,
      sizeName: e.sizeName === "Unknown" ? undefined : e.sizeName,
      scale: e.kg || e.scale,
      kg: e.kg,
      value: e.value,
      valueNum: e.valueNum,
      image: e.image,
      serverId: e.serverId,
      updatedAt: e.updatedAt
    }))
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CAT HUB API listening on port ${PORT}`);
});

if (!DISCORD_TOKEN || !CHANNEL_ID || !API_KEY) {
  console.error("Missing DISCORD_TOKEN, CHANNEL_ID, or API_KEY.");
} else {
  client.login(DISCORD_TOKEN).catch(error => {
    console.error("Discord login failed:", error.message);
  });
}
