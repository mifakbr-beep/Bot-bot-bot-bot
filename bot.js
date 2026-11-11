const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const EVENT = { QR: 'qr', READY: 'ready', LOG: 'log', STATS: 'stats' };

let bans = []; // { id, phone, groupId, reason, expiresAt, active }

function createBot(io) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'ban-bot' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  const PAIRING_NUMBER = process.env.PAIRING_NUMBER; // ex: 22670123456

  const log = (msg, type = 'info') => {
    console.log(`[${type}] ${msg}`);
    if (io) io.emit(EVENT.LOG, { msg, type, ts: Date.now() });
  };
  const stats = () => {
    if (io) io.emit(EVENT.STATS, {
      total: bans.length,
      actifs: bans.filter(b => b.active).length
    });
  };

  // ============ QR OU CODE ============
  client.on('qr', async (qr) => {
    if (PAIRING_NUMBER) return; // On utilise le code, pas le QR
    log('📱 Scannez le QR avec WhatsApp > Appareils liés', 'warn');
    qrcodeTerminal.generate(qr, { small: true });
    const dataUrl = await qrcode.toDataURL(qr);
    if (io) io.emit(EVENT.QR, dataUrl);
  });

  client.on('ready', () => {
    log('✅ Bot connecté à WhatsApp', 'success');
    if (io) io.emit(EVENT.READY);
    stats();
  });

  client.on('auth_failure', () => log('❌ Échec authentification', 'error'));
  client.on('disconnected', (r) => log('🔌 Déconnecté : ' + r, 'error'));

  // ============ FONCTIONS DE BAN ============
  async function banUser({ phone, groupId, reason, duration }) {
    if (!client.info) throw new Error('Bot non connecté');
    const cleanPhone = phone.replace(/[^\d]/g, '');
    const waId = `${cleanPhone}@c.us`;
    const isRegistered = await client.isRegisteredUser(waId);
    if (!isRegistered) throw new Error('Numéro non enregistré sur WhatsApp');
    validateGroupId(groupId);
    const group = await client.getChatById(groupId);
    if (!group.isGroup) throw new Error('Le chat ciblé n\'est pas un groupe');
    const existing = bans.find(b => b.phone === cleanPhone && b.groupId === groupId && b.active);
    if (existing) throw new Error('Déjà banni de ce groupe');
    const botId = client.info.wid._serialized;
    const botParticipant = group.participants.find(p => p.id._serialized === botId);
    if (!botParticipant?.isAdmin && !botParticipant?.isSuperAdmin) {
      throw new Error('Le bot n\'est pas administrateur du groupe');
    }
    await group.removeParticipants([waId]);
    log(`🚫 ${cleanPhone} retiré de "${group.name}"`, 'success');
    const ban = {
      id: 'BAN-' + Math.random().toString(36).substring(2, 10).toUpperCase(),
      phone: cleanPhone,
      groupId,
      groupName: group.name,
      reason,
      expiresAt: duration === 0 ? null : Date.now() + duration * 3600 * 1000,
      active: true
    };
    bans.push(ban);
    stats();
    try {
      await group.sendMessage(`🚫 *Bannissement*\n📞 +${cleanPhone}\n📋 Motif : ${reason}\n⏳ Durée : ${duration === 0 ? 'permanent' : duration + 'h'}`);
    } catch {}
    return ban;
  }

  async function unbanUser(banId) {
    const ban = bans.find(b => b.id === banId);
    if (!ban) throw new Error('Ban introuvable');
    validateGroupId(ban.groupId);
    const group = await client.getChatById(ban.groupId);
    try {
      await group.addParticipants([`${ban.phone}@c.us`]);
      log(`✅ +${ban.phone} réintégré à "${ban.groupName}"`, 'success');
    } catch {
      log(`⚠️ Impossible de réintégrer +${ban.phone} (restriction du groupe)`, 'warn');
    }
    ban.active = false;
    stats();
    return ban;
  }

  function validateGroupId(id) {
    if (!id || !/@g\.us$/.test(id)) throw new Error('ID de groupe invalide');
  }

  async function listGroups() {
    if (!client.info) return [];
    const chats = await client.getChats();
    return chats.filter(c => c.isGroup).map(c => ({ id: c.id._serialized, name: c.name, size: c.participants.length }));
  }

  // ============ COMMANDES WHATSAPP ============
  client.on('message', async (msg) => {
    try {
      if (!msg.body || !msg.body.startsWith('!')) return;
      const parts = msg.body.trim().split(' ');
      const cmd = parts[0].toLowerCase();

      if (cmd === '!help') {
        await msg.reply(`🤖 *COMMANDES BOT*\n\n!ban <numéro> <motif> - Bannir\n!ban <numéro> <motif> <heures> - Bannir temporaire\n!unban <ID_BAN> - Débannir\n!groupes - Liste des groupes\n!bans - Liste des bans actifs\n!help - Voir ce message`);
        return;
      }

      if (cmd === '!ban') {
        const phone = parts[1];
        if (!phone) return msg.reply('❌ Usage: !ban <numéro> <motif> [heures]');
        let duration = 0;
        let reasonParts = parts.slice(2);
        const last = reasonParts[reasonParts.length - 1];
        if (reasonParts.length > 1 && !isNaN(last)) {
          duration = parseInt(last);
          reasonParts = reasonParts.slice(0, -1);
        }
        const reason = reasonParts.join(' ') || 'Pas de motif';
        const groupId = msg.from;
        const ban = await banUser({ phone, groupId, reason, duration });
        await msg.reply(`✅ Banni: +${ban.phone}\nID: ${ban.id}\nMotif: ${reason}`);
        return;
      }

      if (cmd === '!unban') {
        const banId = parts[1];
        if (!banId) return msg.reply('❌ Usage: !unban <ID_BAN>');
        const ban = await unbanUser(banId);
        await msg.reply(`✅ Débanni: +${ban.phone}`);
        return;
      }

      if (cmd === '!groupes') {
        const groupes = await listGroups();
        if (groupes.length === 0) return msg.reply('Aucun groupe trouvé');
        await msg.reply('📋 *GROUPES:*\n\n' + groupes.map(g => `• ${g.name}\n  ID: ${g.id}\n  Membres: ${g.size}`).join('\n\n'));
        return;
      }

      if (cmd === '!bans') {
        const actifs = bans.filter(b => b.active);
        if (actifs.length === 0) return msg.reply('Aucun ban actif');
        await msg.reply('🚫 *BANS ACTIFS:*\n\n' + actifs.map(b => `• +${b.phone} - ${b.groupName}\n  ID: ${b.id}\n  Motif: ${b.reason}`).join('\n\n'));
        return;
      }
    } catch (e) {
      await msg.reply('❌ ' + e.message);
    }
  });

  // Nettoyage automatique des bans expirés
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    bans.forEach(b => {
      if (b.active && b.expiresAt && b.expiresAt <= now) {
        b.active = false;
        changed = true;
        log(`⏰ Expiration du ban de +${b.phone}`, 'warn');
      }
    });
    if (changed) stats();
  }, 5000);

  // ============ LANCEMENT + CODE DE LIAISON ============
  client.initialize().then(async () => {
    if (PAIRING_NUMBER) {
      log('🔑 Demande du code de liaison pour +' + PAIRING_NUMBER, 'warn');
      // Attendre que WhatsApp soit prêt
      await new Promise(r => setTimeout(r, 5000));
      try {
        const code = await client.requestPairingCode(PAIRING_NUMBER);
        log(`🔑 TON CODE DE LIAISON : ${code}`, 'warn');
        console.log(`\n\n======== CODE : ${code} ========\n\n`);
        if (io) io.emit(EVENT.LOG, { msg: `CODE : ${code}`, type: 'warn', ts: Date.now() });
      } catch (e) {
        log('❌ Erreur code : ' + e.message, 'error');
      }
    }
  });

  return { client, banUser, unbanUser, listGroups, getBans: () => bans };
}

module.exports = { createBot };
