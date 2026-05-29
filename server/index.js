import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true,
    methods: ["GET", "POST"],
  },
});

const players = new Map();
const chatHistory = [];
const avatarStorage = new Map();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadPath = path.join(__dirname, "..", "uploads");
const dataPath = path.join(__dirname, "..", "data");
const worldsPath = path.join(dataPath, "worlds.json");

await mkdir(dataPath, { recursive: true });
// uploadPath は Vercel 環境では作成不可なため、メモリストレージを使用

const defaultWorldScript = `verse.api.platform({
  id: "central-plaza",
  position: [0, 0.02, -2.6],
  scale: [6, 0.08, 2.2],
  color: "#87b7d4"
});

verse.api.sign({
  id: "plaza-label",
  text: "GEN VERSE PLAZA",
  position: [0, 0.09, -2.6],
  color: "#1d3557",
  size: 0.42
});

for (let i = 0; i < 8; i++) {
  const angle = (Math.PI * 2 * i) / 8;
  verse.api.tree({
    id: "ring-tree-" + i,
    position: [Math.cos(angle) * 9, 0, Math.sin(angle) * 9],
    scale: 1
  });
}`;

const defaultWorld = {
  id: "gen-plaza",
  name: "Gen Plaza",
  script: defaultWorldScript,
  updatedAt: Date.now(),
};

let worlds = await loadWorlds();

async function loadWorlds() {
  try {
    const data = JSON.parse(await readFile(worldsPath, "utf8"));
    if (Array.isArray(data.worlds) && data.worlds.length > 0) {
      return data.worlds.map(sanitizeWorld);
    }
  } catch {
    await saveWorlds([defaultWorld]);
  }

  return [defaultWorld];
}

async function saveWorlds(nextWorlds = worlds) {
  await writeFile(worldsPath, JSON.stringify({ worlds: nextWorlds }, null, 2));
}

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.post("/api/avatar", express.raw({ type: "application/octet-stream", limit: "40mb" }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: "No avatar file received." });
    return;
  }

  const id = crypto.randomUUID();
  avatarStorage.set(id, req.body);
  const origin = `${req.protocol}://${req.get("host")}`;
  res.json({ url: `${origin}/avatars/${id}.vrm` });
});

app.use(express.json({ limit: "1mb" }));

app.get("/avatars/:id.vrm", (req, res) => {
  const buffer = avatarStorage.get(req.params.id);
  if (!buffer) {
    res.status(404).json({ error: "Avatar not found." });
    return;
  }
  res.setHeader("Content-Type", "application/octet-stream");
  res.send(buffer);
});

app.get("/api/worlds", (_req, res) => {
  res.json({ worlds });
});

app.post("/api/worlds", async (req, res) => {
  const world = sanitizeWorld({
    id: slugify(req.body?.name || `world-${worlds.length + 1}`),
    name: req.body?.name || `World ${worlds.length + 1}`,
    script: defaultWorldScript,
    updatedAt: Date.now(),
  });

  const ids = new Set(worlds.map((item) => item.id));
  let suffix = 2;
  const baseId = world.id;
  while (ids.has(world.id)) {
    world.id = `${baseId}-${suffix}`;
    suffix += 1;
  }

  worlds = [...worlds, world];
  await saveWorlds();
  io.emit("worlds:updated", worlds);
  res.status(201).json({ world });
});

app.put("/api/worlds/:id", async (req, res) => {
  const index = worlds.findIndex((world) => world.id === req.params.id);
  if (index === -1) {
    res.status(404).json({ error: "World not found." });
    return;
  }

  const world = sanitizeWorld({
    ...worlds[index],
    name: req.body?.name ?? worlds[index].name,
    script: req.body?.script ?? worlds[index].script,
    updatedAt: Date.now(),
  });

  worlds = worlds.map((item, itemIndex) => (itemIndex === index ? world : item));
  await saveWorlds();
  io.emit("worlds:updated", worlds);
  io.to(world.id).emit("world:updated", world);
  res.json({ world });
});

const sanitizePlayer = (player) => ({
  id: player.id,
  name: String(player.name || "Guest").slice(0, 28),
  color: String(player.color || "#7dd3fc").slice(0, 32),
  avatarUrl: typeof player.avatarUrl === "string" ? player.avatarUrl.slice(0, 512) : "",
  worldId: typeof player.worldId === "string" && player.worldId ? player.worldId : worlds[0].id,
  position: player.position || { x: 0, y: 0, z: 0 },
  rotationY: Number(player.rotationY || 0),
  animation: player.animation === "walk" ? "walk" : "idle",
});

const sanitizeMessage = (message) => ({
  id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  playerId: message.playerId,
  worldId: message.worldId || worlds[0].id,
  name: String(message.name || "Guest").slice(0, 28),
  text: String(message.text || "").replace(/\s+/g, " ").trim().slice(0, 180),
  createdAt: Date.now(),
});

io.on("connection", (socket) => {
  socket.emit("world:init", {
    selfId: socket.id,
    worlds,
    activeWorldId: worlds[0].id,
    players: playersInWorld(worlds[0].id),
    chat: chatInWorld(worlds[0].id),
  });

  socket.on("player:join", (payload) => {
    const current = players.get(socket.id);
    if (current?.worldId && current.worldId !== payload?.worldId) {
      socket.leave(current.worldId);
      socket.to(current.worldId).emit("player:left", socket.id);
    }

    const worldId = worlds.some((world) => world.id === payload?.worldId) ? payload.worldId : worlds[0].id;
    socket.join(worldId);

    const player = sanitizePlayer({
      id: socket.id,
      ...payload,
      worldId,
      position: payload?.position || spawnPoint(players.size),
    });

    players.set(socket.id, player);
    socket.emit("world:state", {
      worldId,
      players: playersInWorld(worldId),
      chat: chatInWorld(worldId),
    });
    socket.to(worldId).emit("player:joined", player);
    socket.emit("player:accepted", player);
  });

  socket.on("player:update", (payload) => {
    const current = players.get(socket.id);
    if (!current) return;

    const next = sanitizePlayer({
      ...current,
      ...payload,
      id: socket.id,
    });

    players.set(socket.id, next);
    if (current.animation !== next.animation) {
      socket.to(next.worldId).emit("player:updated", next);
    } else {
      socket.to(next.worldId).volatile.emit("player:updated", next);
    }
  });

  socket.on("chat:send", (payload) => {
    const player = players.get(socket.id);
    const message = sanitizeMessage({
      ...payload,
      playerId: socket.id,
      worldId: player?.worldId || worlds[0].id,
      name: player?.name || payload?.name,
    });

    if (!message.text) return;

    chatHistory.push(message);
    while (chatHistory.length > 80) chatHistory.shift();
    io.to(player?.worldId || worlds[0].id).emit("chat:message", message);
  });

  socket.on("disconnect", () => {
    const player = players.get(socket.id);
    if (!player) return;
    players.delete(socket.id);
    socket.to(player.worldId).emit("player:left", socket.id);
  });
});

function sanitizeWorld(world) {
  return {
    id: String(world.id || crypto.randomUUID()).slice(0, 64),
    name: String(world.name || "Untitled World").slice(0, 48),
    script: String(world.script || "").slice(0, 20000),
    updatedAt: Number(world.updatedAt || Date.now()),
  };
}

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || crypto.randomUUID().slice(0, 8);
}

function playersInWorld(worldId) {
  return Array.from(players.values())
    .filter((player) => player.worldId === worldId)
    .map(sanitizePlayer);
}

function chatInWorld(worldId) {
  return chatHistory.filter((message) => message.worldId === worldId);
}

const spawnPoint = (index) => {
  const angle = index * 1.88;
  const radius = 2.5 + (index % 4) * 0.6;
  return {
    x: Math.cos(angle) * radius,
    y: 0,
    z: Math.sin(angle) * radius,
  };
};

const distPath = path.join(__dirname, "..", "dist");
app.use(express.static(distPath));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

const port = Number(process.env.PORT || 3001);
httpServer.listen(port, () => {
  console.log(`Gen Verse realtime server listening on http://localhost:${port}`);
});
