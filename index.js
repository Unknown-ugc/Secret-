require("dotenv").config();

const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "200kb" }));

// Optional keys (set them in Render > Environment)
const API_KEY = process.env.API_KEY;         // protects /eggs (full data)
const REPORT_KEY = process.env.REPORT_KEY;   // protects /report-egg (optional)

let eggs = [];
const MAX_EGGS = Infinity; // no limit (the list is wiped every 5 minutes anyway)
let eggsVersion = 0;       // changes whenever the list changes (used by the response cache)

const same = (a, b) =>
  a.serverId === b.serverId &&
  a.name.toLowerCase() === b.name.toLowerCase() &&
  Math.abs((a.scale || 0) - (b.scale || 0)) < 0.02;

// ---------- Reset at every real 5-minute mark (:00, :05, :10 ...) ----------
// The game changes the eggs in every server each 5 minutes, so old eggs are really gone.
// Detectors re-scan right after each mark and re-send the new eggs.
function millisecondsUntilNextFiveMinuteMark() {
  const FIVE = 5 * 60 * 1000;
  return FIVE - (Date.now() % FIVE);
}

function scheduleNextReset() {
  setTimeout(() => {
    const removed = eggs.length;
    eggs = [];
    eggsVersion++;

    const time = new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(new Date());

    console.log(`[RESET] ${time} Philippine time. Cleared ${removed} eggs.`);
    scheduleNextReset();
  }, millisecondsUntilNextFiveMinuteMark());
}

scheduleNextReset();

// ---------- Loader / detector reports eggs straight here ----------
const reportHits = new Map();

app.post("/report-egg", (req, res) => {
  if (REPORT_KEY && req.get("x-report-key") !== REPORT_KEY) {
    return res.sendStatus(401);
  }

  // max 30 requests per minute per IP
  const ip = String(req.headers["x-forwarded-for"] || req.ip).split(",")[0].trim();
  const now = Date.now();
  const hits = (reportHits.get(ip) || []).filter(t => now - t < 60000);
  if (hits.length >= 30) return res.sendStatus(429);
  hits.push(now);
  reportHits.set(ip, hits);
  if (reportHits.size > 5000) reportHits.clear();

  const body = Array.isArray(req.body) ? req.body : req.body && req.body.eggs;
  if (!Array.isArray(body)) return res.sendStatus(400);

  const stamp = new Date(now).toISOString();
  let added = 0;
  let refreshed = 0;

  for (const e of body.slice(0, 50)) {
    if (!e || typeof e.name !== "string" || typeof e.rarity !== "string") continue;
    if (typeof e.serverId !== "string" || e.serverId.length < 10 || e.serverId.length > 80) continue;

    const valueNum = Number(e.valueNum);
    if (!(valueNum >= 0 && valueNum < 1e15)) continue;

    const egg = {
      name: e.name.slice(0, 60),
      rarity: e.rarity.slice(0, 30),
      sizeName: typeof e.sizeName === "string" ? e.sizeName.slice(0, 20) : "Unknown",
      kg: Number(e.scale) || 1,
      scale: Number(e.scale) || 1,
      value: typeof e.value === "string" ? e.value.slice(0, 20) : "$0/s",
      valueNum,
      image: typeof e.image === "string" ? e.image.slice(0, 200) : "",
      serverId: e.serverId,
      players: Number(e.players) || 0,
      maxPlayers: Number(e.maxPlayers) || 0
    };

    const existing = eggs.find(x => same(x, egg));
    if (existing) {
      // already listed: just update the time and player count
      existing.updatedAt = stamp;
      existing.players = egg.players;
      existing.maxPlayers = egg.maxPlayers;
      refreshed++;
    } else {
      eggs.push({
        id: `${now}-${Math.random().toString(36).slice(2, 10)}`,
        ...egg,
        updatedAt: stamp
      });
      added++;
    }
  }

  if (added) {
    eggs.sort((a, b) => b.valueNum - a.valueNum);
  }

  if (added || refreshed) eggsVersion++;
  console.log(`[REPORT] added=${added} refreshed=${refreshed} total=${eggs.length}`);
  res.json({ ok: true, received: body.length, added, refreshed });
});

// ---------- A player joined the server and the egg is no longer there ----------
app.post("/egg-gone", (req, res) => {
  const { serverId, name, scale } = req.body || {};
  if (!serverId || !name) return res.sendStatus(400);

  const target = { serverId: String(serverId), name: String(name), scale: Number(scale) || 0 };
  const before = eggs.length;
  eggs = eggs.filter(e => !same(e, target));
  if (before !== eggs.length) eggsVersion++;

  console.log(`[GONE] ${target.name} removed=${before - eggs.length} total=${eggs.length}`);
  res.json({ ok: true, removed: before - eggs.length, count: eggs.length });
});

// ---------- Read endpoints ----------
app.get("/", (_req, res) => {
  res.json({ name: "CAT HUB API", status: "online" });
});

app.get("/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, liveEggs: eggs.length, resetEvery: "5 minutes (wall clock)" });
});

app.get("/eggs", (req, res) => {
  if (!API_KEY || req.get("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, count: eggs.length, eggs });
});

// Cached for 2 seconds so many players polling every few seconds cost almost nothing.
let publicCache = { version: -1, limit: 0, at: 0, body: "" };

app.get("/public-eggs", (req, res) => {
  const requested = Number.parseInt(req.query.limit, 10);
  const limit = Math.max(requested || eggs.length, 1); // no limit unless the player asks for one

  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.type("application/json");

  const now = Date.now();
  if (publicCache.version === eggsVersion && publicCache.limit === limit && now - publicCache.at < 2000) {
    return res.send(publicCache.body);
  }

  const body = JSON.stringify({
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
      players: e.players || undefined,
      maxPlayers: e.maxPlayers || undefined,
      updatedAt: e.updatedAt
    }))
  });

  publicCache = { version: eggsVersion, limit, at: now, body };
  res.send(body);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CAT HUB API listening on port ${PORT}`);
});
                                                                  
