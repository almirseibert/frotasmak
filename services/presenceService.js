// services/presenceService.js
// Presença em memória para o mensageiro interno (chat estilo MSN).
// Instância única (single-process). Se um dia rodar em múltiplas instâncias,
// trocar por um adapter compartilhado (Redis) — a API pública abaixo se mantém.
//
// Estrutura: userId -> { sockets: Set<socketId>, status, statusMsg }
// `status` é o status MSN escolhido pelo usuário; 'invisivel' = conectado mas
// aparece offline para os demais.

const online = new Map();

const VISIBLE_OFFLINE = 'offline';
const INVISIBLE = 'invisivel';

// Registra um socket para o usuário. Retorna { wasOffline } — true se este é o
// primeiro socket do usuário (transição offline -> online).
function addSocket(userId, socketId, status) {
    const key = String(userId);
    let entry = online.get(key);
    const wasOffline = !entry || entry.sockets.size === 0;
    if (!entry) {
        entry = { sockets: new Set(), status: status || 'disponivel', statusMsg: null };
        online.set(key, entry);
    }
    if (status) entry.status = status;
    entry.sockets.add(socketId);
    return { wasOffline, entry };
}

// Remove um socket. Retorna { nowOffline } — true se era o último socket.
function removeSocket(userId, socketId) {
    const key = String(userId);
    const entry = online.get(key);
    if (!entry) return { nowOffline: true, entry: null };
    entry.sockets.delete(socketId);
    const nowOffline = entry.sockets.size === 0;
    if (nowOffline) online.delete(key);
    return { nowOffline, entry };
}

function setStatus(userId, status, statusMsg) {
    const key = String(userId);
    const entry = online.get(key);
    if (!entry) return null;
    if (status) entry.status = status;
    if (statusMsg !== undefined) entry.statusMsg = statusMsg;
    return entry;
}

// Está com pelo menos um socket ativo? (independe de invisível)
function isConnected(userId) {
    const entry = online.get(String(userId));
    return !!entry && entry.sockets.size > 0;
}

// Status "público" — o que os outros devem enxergar. Invisível vira 'offline'.
function publicStatus(userId) {
    const entry = online.get(String(userId));
    if (!entry || entry.sockets.size === 0) return VISIBLE_OFFLINE;
    return entry.status === INVISIBLE ? VISIBLE_OFFLINE : entry.status;
}

function publicStatusMsg(userId) {
    const entry = online.get(String(userId));
    if (!entry || entry.sockets.size === 0) return null;
    return entry.status === INVISIBLE ? null : (entry.statusMsg || null);
}

// Snapshot de todos os conectados visíveis: [{ userId, status, statusMsg }]
function snapshot() {
    const out = [];
    for (const [userId, entry] of online.entries()) {
        if (entry.sockets.size === 0) continue;
        const status = entry.status === INVISIBLE ? VISIBLE_OFFLINE : entry.status;
        if (status === VISIBLE_OFFLINE) continue; // invisíveis não aparecem
        out.push({ userId, status, statusMsg: entry.statusMsg || null });
    }
    return out;
}

module.exports = {
    addSocket,
    removeSocket,
    setStatus,
    isConnected,
    publicStatus,
    publicStatusMsg,
    snapshot,
};
