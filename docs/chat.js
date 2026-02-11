/* ═══════════════════════════════════
   tryl.chat — Client Script
   ═══════════════════════════════════ */

// ═══ CONNECTION ═══
const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
const PARTYKIT_HOST = isLocal ? "localhost:1999" : "nekochat.frubcoin.partykit.dev";
const WS_PROTOCOL = isLocal ? "ws" : "wss";
const WS_URL = `${WS_PROTOCOL}://${PARTYKIT_HOST}/party/main-lobby`;

let ws;
let reconnectTimer = null;

function connectWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.addEventListener('open', () => {
        console.log('connected to tryl.chat');
        if (currentUsername) {
            ws.send(JSON.stringify({ type: 'join', username: currentUsername }));
        }
    });

    ws.addEventListener('message', (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }

        switch (data.type) {
            case 'chat-message':
                appendChatMessage(data);
                scrollToBottom();
                break;
            case 'system-message':
                appendSystemMessage(data);
                scrollToBottom();
                break;
            case 'user-list':
                updateUserList(data.users, data.total);
                break;
            case 'visitor-count':
                updateVisitorCount(data.count);
                break;
            case 'history':
                if (data.messages && Array.isArray(data.messages)) {
                    data.messages.forEach(msg => {
                        if (msg.msgType === 'chat') appendChatMessage(msg);
                        else if (msg.msgType === 'system') appendSystemMessage(msg);
                    });
                    scrollToBottom();
                }
                break;
            case 'cursor':
                updateRemoteCursor(data);
                break;
            case 'cursor-gone':
                removeRemoteCursor(data.id);
                break;
        }
    });

    ws.addEventListener('close', () => {
        appendSystemMessage({ text: 'connection lost — reconnecting...', timestamp: Date.now() });
        if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWebSocket(); }, 2000);
        }
    });

    ws.addEventListener('error', () => { });
}

connectWebSocket();

// ═══ DOM ═══
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const usernameInput = document.getElementById('username-input');
const chatPage = document.getElementById('chat-page');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const userListEl = document.getElementById('user-list');
const visitorNum = document.getElementById('visitor-num');
const counterValue = document.getElementById('counter-value');
const onlineCount = document.getElementById('online-count');

let currentUsername = '';

// ═══ LOGIN ═══
const loginBox = document.getElementById('login-box');
const stepWallet = document.getElementById('step-wallet');
const btnPhantom = document.getElementById('btn-phantom');
const manualInput = document.getElementById('manual-wallet-input');
const btnManualSubmit = document.getElementById('btn-manual-submit');
const btnSkip = document.getElementById('btn-skip-wallet');
const btnBack = document.getElementById('btn-back-wallet');

let currentWalletAddress = null;

// ═══ WALLET FLOW ═══
btnPhantom.addEventListener('click', async () => {
    if (window.solana && window.solana.isPhantom) {
        try {
            const resp = await window.solana.connect();
            currentWalletAddress = resp.publicKey.toString();
            goToStep2();
        } catch (err) {
            console.error(err);
            alert('Connection failed or rejected');
        }
    } else {
        alert('Phantom wallet not found! Please install it.');
        window.open('https://phantom.app/', '_blank');
    }
});

function submitManualWallet() {
    const val = manualInput.value.trim();
    if (val) {
        currentWalletAddress = val;
        goToStep2();
    }
}

manualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitManualWallet();
});

btnManualSubmit.addEventListener('click', submitManualWallet);

btnSkip.addEventListener('click', () => {
    currentWalletAddress = null;
    goToStep2();
});

btnBack.addEventListener('click', () => {
    loginForm.classList.add('hidden');
    stepWallet.classList.remove('hidden');
});

function goToStep2() {
    stepWallet.classList.add('hidden');
    loginForm.classList.remove('hidden');
    usernameInput.focus();
}

// ═══ LOGIN ═══
loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = usernameInput.value.trim();
    if (!name) return;
    currentUsername = name;
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'join',
            username: name,
            wallet: currentWalletAddress
        }));
    }
    loginOverlay.classList.add('hidden');
    chatPage.classList.remove('hidden');
    chatInput.focus();
});

// ═══ SEND ═══
chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = chatInput.value.trim();
    if (!msg) return;
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'chat', text: msg }));
    }
    chatInput.value = '';
    chatInput.focus();
});

// ═══ RENDER ═══
function formatTime(ts) {
    const d = new Date(ts);
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
}

function appendChatMessage(data) {
    const div = document.createElement('div');
    div.className = 'chat-msg';

    div.innerHTML = `
    <div class="msg-header">
      <span class="msg-username" style="color: ${data.color}">${data.username}</span>
      <span class="msg-time">${formatTime(data.timestamp)}</span>
    </div>
    <div class="msg-text">${data.text}</div>`;

    chatMessages.appendChild(div);
}

function appendSystemMessage(data) {
    const div = document.createElement('div');
    div.className = 'system-msg';
    div.textContent = data.text;
    chatMessages.appendChild(div);
}

function updateUserList(users, total) {
    userListEl.innerHTML = '';

    const uCount = users ? users.length : 0;
    const tCount = total || uCount;
    const gCount = Math.max(0, tCount - uCount);

    if (onlineCount) {
        onlineCount.textContent = `${uCount} ${uCount === 1 ? 'user' : 'users'}, ${gCount} ${gCount === 1 ? 'guest' : 'guests'}`;
    }

    if (!users || users.length === 0) {
        userListEl.innerHTML = '<li class="no-users">no one here yet</li>';
        return;
    }
    users.forEach(u => {
        const li = document.createElement('li');
        li.style.color = u.color;
        li.textContent = u.username;
        userListEl.appendChild(li);
    });
}

function updateVisitorCount(count) {
    if (visitorNum) visitorNum.textContent = count.toLocaleString();
    if (counterValue) counterValue.textContent = count.toLocaleString();
}

function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ═══ CURSOR TRAIL ═══
let trailThrottle = 0;
let cursorSendThrottle = 0;

document.addEventListener('mousemove', (e) => {
    const now = Date.now();

    // Subtle dot trail (every 80ms)
    if (now - trailThrottle >= 80) {
        trailThrottle = now;
        const dot = document.createElement('span');
        dot.className = 'trail-star';
        dot.textContent = '·';
        dot.style.left = e.clientX + 'px';
        dot.style.top = e.clientY + 'px';
        dot.style.color = '#444';
        document.body.appendChild(dot);
        setTimeout(() => dot.remove(), 600);
    }

    // Send cursor to others (every 50ms)
    if (currentUsername && now - cursorSendThrottle >= 50) {
        cursorSendThrottle = now;
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'cursor',
                x: (e.clientX / window.innerWidth) * 100,
                y: (e.clientY / window.innerHeight) * 100,
            }));
        }
    }
});

// ═══ REMOTE CURSORS ═══
const remoteCursors = {};

function updateRemoteCursor(data) {
    let cursor = remoteCursors[data.id];

    if (!cursor) {
        const el = document.createElement('div');
        el.className = 'remote-cursor';
        el.innerHTML = `
            <span class="remote-cursor-dot" style="background: ${data.color};"></span>
            <span class="remote-cursor-label" style="color: ${data.color};">${data.username}</span>
        `;
        document.body.appendChild(el);
        cursor = { el, timeout: null };
        remoteCursors[data.id] = cursor;
    }

    const x = (data.x / 100) * window.innerWidth;
    const y = (data.y / 100) * window.innerHeight;
    cursor.el.style.left = x + 'px';
    cursor.el.style.top = y + 'px';

    if (cursor.timeout) clearTimeout(cursor.timeout);
    cursor.timeout = setTimeout(() => removeRemoteCursor(data.id), 30000);
}

function removeRemoteCursor(id) {
    const cursor = remoteCursors[id];
    if (cursor) {
        cursor.el.remove();
        if (cursor.timeout) clearTimeout(cursor.timeout);
        delete remoteCursors[id];
    }
}
