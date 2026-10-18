
require("dotenv").config();

const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
const PORT = process.env.PORT || 3000;

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
const MAX_EGGS = 500;

function parseEggs(text) {
  if (!text) return [];

  const cleaned = text
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    const data = JSON.parse(cleaned);
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data.eggs)
        ? data.eggs
        : [data];

    return list.filter(
      egg =>
        egg &&
        typeof egg.name === "string" &&
        typeof egg.rarity === "string"
    );
  } catch {
    return [];
  }
}

function saveEggs(list) {
  for (const egg of list) {
    eggs.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: egg.name,
      rarity: egg.rarity,
      sizeName: egg.sizeName || "Unknown",
      kg: Number(egg.kg) || 0,
      value: egg.value || "$0/s",
      valueNum: Number(egg.valueNum) || 0,
      image: egg.image || "",
      serverId: egg.serverId || "",
      scale: Number(egg.scale) || 1,
      updatedAt: new Date().toISOString()
    });
  }

  eggs.sort((a, b) => b.valueNum - a.valueNum);

  if (eggs.length > MAX_EGGS) {
    eggs = eggs.slice(0, MAX_EGGS);
  }
}

// NEW MESSAGES ONLY — walang Discord history loading.
client.on("messageCreate", message => {
  try {
    if (message.channelId !== CHANNEL_ID) return;

    // I-process ang webhook messages at ordinaryong channel messages.
    const texts = [
      message.content,
      ...message.embeds.flatMap(embed => [
        embed.title || "",
        embed.description || "",
        ...embed.fields.map(field => `${field.name}\n${field.value}`)
      ])
    ];

    for (const text of texts) {
      saveEggs(parseEggs(text));
    }

    if (eggs.length) {
      console.log(`Live eggs: ${eggs.length}`);
    }
  } catch (error) {
    console.error("Message processing error:", error.message);
  }
});

// Reset ayon sa tunay na oras sa Asia/Manila:
// :00, :05, :10, :15, :20, :25, :30, :35, :40, :45, :50, :55.
function millisecondsUntilNextFiveMinuteMark() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Manila",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(now);

  const minute = Number(parts.find(p => p.type === "minute").value);
  const second = Number(parts.find(p => p.type === "second").value);

  const secondsToNext =
    ((5 - (minute % 5)) % 5) * 60 - second;

  return secondsToNext <= 0
    ? 5 * 60 * 1000
    : secondsToNext * 1000;
}

function scheduleNextReset() {
  setTimeout(() => {
    eggs = [];

    const time = new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(new Date());

    console.log(`Live egg list reset at ${time} Philippine time.`);
    scheduleNextReset();
  }, millisecondsUntilNextFiveMinuteMark());
}

scheduleNextReset();

client.once("clientReady", () => {
  console.log(`CAT HUB BOT online: ${client.user.tag}`);
  console.log("History loading disabled; new messages only.");
});

app.get("/", (_req, res) => {
  res.json({ name: "CAT HUB BOT API", status: "online" });
});

app.get("/health", (_req, res) => {
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

  res.json({
    ok: true,
    count: eggs.length,
    eggs
  });
});

app.listen(PORT, () => {
  console.log(`CAT HUB API listening on port ${PORT}`);
});

if (!DISCORD_TOKEN || !CHANNEL_ID || !API_KEY) {
  console.error("Missing DISCORD_TOKEN, CHANNEL_ID, or API_KEY.");
} else {
  client.login(DISCORD_TOKEN).catch(error => {
    console.error("Discord login failed:", error.message);
  });
}

