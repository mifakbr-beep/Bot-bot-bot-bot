const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createBot } = require('./bot');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
const bot = createBot(io);
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Bot WhatsApp en ligne', bans: bot.getBans().length });
});
app.post('/api/ban', async (req, res) => {
  try { const ban = await bot.banUser(req.body); res.json({ ok: true, ban }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/unban', async (req, res) => {
  try { const ban = await bot.unbanUser(req.body.id); res.json({ ok: true, ban }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.get('/api/groups', async (req, res) => {
  try { res.json({ ok: true, groups: await bot.listGroups() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/bans', (req, res) => res.json({ bans: bot.getBans() }));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌐 http://localhost:${PORT}`));
