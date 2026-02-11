/* ═══════════════════════════════════
   tryl.chat — Client Script
   ═══════════════════════════════════ */

// ═══ CONNECTION ═══
const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
const PARTYKIT_HOST = isLocal ? "localhost:1999" : "nekochat.frubcoin.partykit.dev";
const WS_PROTOCOL = isLocal ? "ws" : "wss";
const WS_URL = `${WS_PROTOCOL}://${PARTYKIT_HOST}/party/main-lobby`;

let currentRoomId = 'main-lobby';
let ws;
let reconnectTimer = null;

function connectWebSocket(roomId = currentRoomId) {
    if (ws) ws.close();
    currentRoomId = roomId;
    const url = `${WS_PROTOCOL}://${PARTYKIT_HOST}/party/${roomId}`;
    ws = new WebSocket(url);

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
            case 'admin-mode':
                const adminPanel = document.getElementById('admin-panel');
                if (adminPanel) adminPanel.classList.remove('hidden');
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
            case 'join-error':
                alert(data.reason || 'Join failed');
                // If it was a room switch error, switch back to lobby
                if (currentRoomId !== 'main-lobby') {
                    switchRoom('main-lobby');
                } else {
                    // Critical error in lobby, show login
                    DOM.loginForm.classList.add('hidden');
                    DOM.stepWallet.classList.remove('hidden');
                    DOM.loginOverlay.classList.remove('hidden');
                    DOM.chatPage.classList.add('hidden');
                }
                break;
            case 'clear-chat':
                DOM.chatMessages.innerHTML = '';
                appendSystemMessage({ text: '✦ Chat cleared by admin ✦' });
                break;
            case 'pinned-update':
                if (data.text) {
                    DOM.pinText.textContent = data.text;
                    DOM.pinnedBanner.classList.remove('hidden');
                    // Simple animation trigger
                    DOM.pinnedBanner.style.animation = 'none';
                    DOM.pinnedBanner.offsetHeight; // force reflow
                    DOM.pinnedBanner.style.animation = 'glow 1.5s ease-out';
                } else {
                    DOM.pinnedBanner.classList.add('hidden');
                }
                break;
            // ═══ GAME EVENTS ═══
            case 'game-ready':
                if (currentUsername) showGameOverlay('ready', data);
                break;
            case 'game-go':
                if (currentUsername) showGameOverlay('go', data);
                break;
            case 'game-dq':
                if (currentUsername) showGameOverlay('dq', data);
                break;
            case 'game-win':
                if (currentUsername) showGameOverlay('win', data);
                break;
            case 'game-cancel':
                if (currentUsername) showGameOverlay('cancel', data);
                break;
            case 'game-series-end':
                if (currentUsername) showGameOverlay('series-end', data);
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

// connectWebSocket(); initialized at bottom of file

// ═══ DOM ═══
const DOM = {
    loginOverlay: document.getElementById('login-overlay'),
    loginForm: document.getElementById('login-form'),
    usernameInput: document.getElementById('username-input'),
    chatPage: document.getElementById('chat-page'),
    chatForm: document.getElementById('chat-form'),
    chatInput: document.getElementById('chat-input'),
    chatMessages: document.getElementById('chat-messages'),
    userList: document.getElementById('user-list'),
    onlineCount: document.getElementById('online-count'),
    guestCount: document.getElementById('guest-count'),
    roomList: document.getElementById('room-list'),
    counterValue: document.getElementById('counter-value'),
    loginBox: document.getElementById('login-box'),
    stepWallet: document.getElementById('step-wallet'),
    btnPhantom: document.getElementById('btn-phantom'),
    manualInput: document.getElementById('manual-wallet-input'),
    btnManualSubmit: document.getElementById('btn-manual-submit'),
    btnBack: document.getElementById('btn-back-wallet'),
    btnAdminGame: document.getElementById('btn-admin-game'),
    adminPanel: document.getElementById('admin-panel'),
    roundSelect: document.getElementById('round-select'),
    gameOverlay: document.getElementById('game-overlay'),
    gameMessage: document.getElementById('game-message'),
    pinnedBanner: document.getElementById('pinned-banner'),
    pinText: document.getElementById('pin-text'),
};

let currentUsername = '';
let currentWalletAddress = null;

// Chat history tracking
const sentHistory = [];
let historyIndex = -1;
let currentDraft = '';

const COMMANDS = [
    '/whitelist',
    '/whitelist add',
    '/whitelist bulk',
    '/whitelist remove',
    '/mute',
    '/clear',
    '/pin',
    '/unpin'
];

// ═══ WALLET FLOW ═══
DOM.btnPhantom.addEventListener('click', async () => {
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
    const val = DOM.manualInput.value.trim();
    if (val) {
        currentWalletAddress = val;
        goToStep2();
    }
}

DOM.manualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitManualWallet();
});

DOM.btnManualSubmit.addEventListener('click', submitManualWallet);

if (DOM.btnSkip) {
    DOM.btnSkip.addEventListener('click', () => {
        currentWalletAddress = null;
        goToStep2();
    });
}

if (DOM.btnBack) {
    DOM.btnBack.addEventListener('click', () => {
        DOM.loginForm.classList.add('hidden');
        DOM.stepWallet.classList.remove('hidden');
    });
}

function goToStep2() {
    DOM.stepWallet.classList.add('hidden');
    DOM.loginForm.classList.remove('hidden');
    DOM.usernameInput.focus();
}

// ═══ LOGIN ═══
DOM.loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = DOM.usernameInput.value.trim();
    if (!name) return;
    currentUsername = name;
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'join',
            username: name,
            wallet: currentWalletAddress
        }));
    }
    DOM.loginOverlay.classList.add('hidden');
    DOM.chatPage.classList.remove('hidden');
    DOM.chatInput.focus();
});

// ═══ SEND ═══
// Message History & Auto-complete
DOM.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (historyIndex === -1) currentDraft = DOM.chatInput.value;
        if (historyIndex < sentHistory.length - 1) {
            historyIndex++;
            DOM.chatInput.value = sentHistory[sentHistory.length - 1 - historyIndex];
        }
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndex > 0) {
            historyIndex--;
            DOM.chatInput.value = sentHistory[sentHistory.length - 1 - historyIndex];
        } else if (historyIndex === 0) {
            historyIndex = -1;
            DOM.chatInput.value = currentDraft;
        }
    } else if (e.key === 'Tab') {
        e.preventDefault();
        const val = DOM.chatInput.value.toLowerCase();
        if (val.startsWith('/')) {
            const match = COMMANDS.find(c => c.startsWith(val));
            if (match) {
                DOM.chatInput.value = match + ' ';
            }
        }
    }
});

DOM.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = DOM.chatInput.value.trim();
    if (!msg) return;

    // Save to history
    if (sentHistory[sentHistory.length - 1] !== msg) {
        sentHistory.push(msg);
    }
    historyIndex = -1;
    currentDraft = '';

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'chat', text: msg }));
    }
    DOM.chatInput.value = '';
    DOM.chatInput.focus();
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
// ═══ ROOM SWITCHING ═══
function switchRoom(roomId) {
    if (roomId === currentRoomId) return;

    // Update UI
    document.querySelectorAll('.room-item').forEach(item => {
        item.classList.toggle('active', item.dataset.room === roomId);
    });

    // Clear messages for new room
    DOM.chatMessages.innerHTML = '';
    appendSystemMessage({ text: `✦ Switching to ${roomId}... ✦` });

    // Reconnect
    connectWebSocket(roomId);
}

// Room list delegation
DOM.roomList.addEventListener('click', (e) => {
    const item = e.target.closest('.room-item');
    if (item && item.dataset.room) {
        switchRoom(item.dataset.room);
    }
});

// ═══ CHAT ═══
function appendChatMessage(data) {
    const div = document.createElement('div');
    div.className = 'chat-msg';

    div.innerHTML = `
    <div class="msg-header">
      <span class="msg-username"></span>
      <span class="msg-time">${formatTime(data.timestamp)}</span>
    </div>
    <div class="msg-text"></div>`;

    // Secure text insertion
    const nameEl = div.querySelector('.msg-username');
    nameEl.textContent = data.username;
    nameEl.style.color = data.color;

    if (data.isAdmin) {
        const badge = document.createElement('span');
        badge.className = 'admin-badge';
        badge.textContent = 'ADMIN';
        nameEl.after(badge);
    }

    div.querySelector('.msg-text').innerText = data.text.replace(/&lt;/g, '<').replace(/&gt;/g, '>');

    DOM.chatMessages.appendChild(div);
}

function appendSystemMessage(data) {
    const div = document.createElement('div');
    div.className = 'system-msg';
    div.textContent = data.text;
    DOM.chatMessages.appendChild(div);
}

function updateUserList(users, total) {
    DOM.userList.innerHTML = '';

    const uCount = users ? users.length : 0;
    const tCount = total || uCount;
    const gCount = Math.max(0, tCount - uCount);

    if (DOM.onlineCount) DOM.onlineCount.textContent = uCount;
    if (DOM.guestCount) DOM.guestCount.textContent = gCount;

    if (!users || users.length === 0) {
        DOM.userList.innerHTML = '<li class="no-users">no one here yet</li>';
        return;
    }
    users.forEach(u => {
        const li = document.createElement('li');
        li.style.color = u.color;
        li.textContent = u.username;

        if (u.isAdmin) {
            const badge = document.createElement('span');
            badge.className = 'admin-badge mini';
            badge.textContent = 'ADMIN';
            li.appendChild(badge);
        }

        DOM.userList.appendChild(li);
    });
}

function updateVisitorCount(count) {
    if (DOM.visitorNum) DOM.visitorNum.textContent = count.toLocaleString();
    if (DOM.counterValue) DOM.counterValue.textContent = count.toLocaleString();
}

function scrollToBottom() {
    DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
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
            <span class="remote-cursor-dot"></span>
            <span class="remote-cursor-label"></span>
        `;
        document.body.appendChild(el);
        cursor = { el, timeout: null };
        remoteCursors[data.id] = cursor;
    }

    // Update color (in case user changed it via color picker)
    const dot = cursor.el.querySelector('.remote-cursor-dot');
    const label = cursor.el.querySelector('.remote-cursor-label');
    dot.style.background = data.color;
    label.style.color = data.color;
    label.textContent = data.username;

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

// ═══ GAME & ADMIN UI ═══

// Admin Trigger (only works if element exists/visible)
if (DOM.btnAdminGame) {
    DOM.btnAdminGame.addEventListener('click', () => {
        if (ws.readyState === WebSocket.OPEN) {
            const rounds = DOM.roundSelect ? DOM.roundSelect.value : "1";
            ws.send(JSON.stringify({ type: 'admin-start-game', rounds }));
        } else {
            console.error('WebSocket not open');
        }
    });
}

// Game Click
if (DOM.gameOverlay) {
    DOM.gameOverlay.addEventListener('mousedown', () => {
        // Simple state check (server handles DQ too)
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'game-click' }));
        }
    });
}

function showGameOverlay(state, data) {
    DOM.gameOverlay.classList.remove('hidden', 'state-ready', 'state-go', 'state-dq');
    DOM.gameMessage.style.color = '';

    if (state === 'ready') {
        DOM.gameOverlay.classList.add('state-ready');
        const roundText = data?.totalRounds > 1 ? `<div style="font-size: 24px; opacity: 0.8; margin-bottom: 10px;">ROUND ${data.round} / ${data.totalRounds}</div>` : '';
        DOM.gameMessage.innerHTML = `${roundText}WAIT FOR IT...`;
    } else if (state === 'go') {
        DOM.gameOverlay.classList.add('state-go');
        DOM.gameMessage.textContent = "CLICK!";
    } else if (state === 'dq') {
        DOM.gameOverlay.classList.add('state-dq');
        DOM.gameMessage.textContent = "FALSE START ❌";
        setTimeout(() => {
            if (DOM.gameOverlay.classList.contains('state-dq')) {
                DOM.gameOverlay.classList.remove('state-dq');
                DOM.gameOverlay.classList.add('hidden');
            }
        }, 2000);
    } else if (state === 'win') {
        DOM.gameOverlay.classList.remove('state-go');
        DOM.gameOverlay.style.background = '#000';

        let scoreHtml = '';
        if (data.totalRounds > 1 && data.scores) {
            scoreHtml = `<div style="font-size: 18px; color: #888; margin-top: 20px;">Series Score: ${Object.entries(data.scores).map(([u, w]) => `${u}: ${w}`).join(' | ')}</div>`;
        }

        DOM.gameMessage.innerHTML = `
            <div style="font-size: 24px; opacity: 0.6; margin-bottom: 10px;">ROUND ${data.round} WINNER</div>
            <div style="color: ${data.color || '#fff'}">${data.username}</div>
            <div style="font-size: 30px; color: #888;">${data.time}ms</div>
            ${scoreHtml}
        `;
        setTimeout(() => {
            if (!DOM.gameOverlay.classList.contains('state-ready') && !DOM.gameOverlay.classList.contains('state-go')) {
                DOM.gameOverlay.classList.add('hidden');
                DOM.gameOverlay.style.background = '';
            }
        }, 3500);
    } else if (state === 'cancel') {
        DOM.gameOverlay.classList.remove('state-ready', 'state-go', 'state-dq');
        DOM.gameOverlay.style.background = '#222';
        DOM.gameMessage.textContent = "ROUND SKIPPED 💀";
        setTimeout(() => {
            DOM.gameOverlay.classList.add('hidden');
            DOM.gameOverlay.style.background = '';
        }, 2000);
    } else if (state === 'series-end') {
        DOM.gameOverlay.classList.remove('state-ready', 'state-go', 'state-dq');
        DOM.gameOverlay.style.background = '#000';
        DOM.gameOverlay.classList.remove('hidden');

        DOM.gameMessage.innerHTML = `
            <div style="font-size: 30px; color: #FFD700; margin-bottom: 20px;">🏆 SERIES CHAMPION 🏆</div>
            <div style="color: #fff; font-size: 60px;">${data.winner}</div>
            <div style="font-size: 20px; color: #888; margin-top: 20px;">Final Score: ${Object.entries(data.scores).map(([u, w]) => `${u}: ${w}`).join(' | ')}</div>
        `;

        setTimeout(() => {
            DOM.gameOverlay.classList.add('hidden');
            DOM.gameOverlay.style.background = '';
        }, 6000);
    }
}

// Start connection after DOM and listeners are ready
connectWebSocket();
