/* ═══════════════════════════════════
   tryl.chat — Client Script
   ═══════════════════════════════════ */

// ═══ CONNECTION ═══
const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
const PARTYKIT_HOST = isLocal ? "localhost:1999" : "nekochat.frubcoin.partykit.dev";
const WS_PROTOCOL = isLocal ? "ws" : "wss";

// ═══ SOLANA / TOKEN GATING ═══
const HELIUS_RPC_URL = "https://mainnet.helius-rpc.com/?api-key=cc4ba0bb-9e76-44be-8681-511665f1c262";
const TOKEN_MINT = "UwU8RVXB69Y6Dcju6cN2Qef6fykkq6UUNpB15rZku6Z";

const ROOMS = [
    { id: 'main-lobby', name: 'lobby', icon: '✦', gated: false },
    { id: 'holders-lounge', name: '$UwU', icon: '◆', gated: true },
];

let currentRoom = 'main-lobby';
let hasToken = false;
let currentSignature = null;
let currentSignMsg = null;

function getWsUrl(roomId) {
    return `${WS_PROTOCOL}://${PARTYKIT_HOST}/party/${roomId}`;
}

let ws;
let reconnectTimer = null;
let isSwitchingRoom = false;

function connectWebSocket(roomId) {
    if (!roomId) roomId = currentRoom;
    const url = getWsUrl(roomId);
    ws = new WebSocket(url);
    const thisWs = ws; // Capture reference to detect stale handlers

    ws.addEventListener('open', () => {
        console.log(`connected to ${roomId}`);
        isSwitchingRoom = false;
        if (currentUsername) {
            const joinMsg = {
                type: 'join',
                username: currentUsername,
                wallet: currentWalletAddress,
                signature: currentSignature,
                signMessage: currentSignMsg,
                hasToken: hasToken,
                color: userColor
            };
            // console.log('[JOIN] Sending:', JSON.stringify(joinMsg).substring(0, 300));
            ws.send(JSON.stringify(joinMsg));
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
                console.error('[JOIN-ERROR]', data.reason);
                isSwitchingRoom = false; // Reset so we can switch back
                if (DOM.loginOverlay.classList.contains('hidden')) {
                    const errorMsg = data.reason || 'Cannot access this room.';
                    if (currentRoom !== 'main-lobby') {
                        switchRoom('main-lobby');
                        setTimeout(() => {
                            appendSystemMessage({ text: `🔒 ${errorMsg}` });
                            scrollToBottom();
                        }, 500);
                    } else {
                        appendSystemMessage({ text: `🔒 ${errorMsg}` });
                        scrollToBottom();
                    }
                } else {
                    alert(data.reason || 'Join failed');
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
        // Ignore close events from stale WebSockets (e.g. old room after switching)
        if (ws !== thisWs) return;
        if (!isSwitchingRoom) {
            appendSystemMessage({ text: 'connection lost — reconnecting...', timestamp: Date.now() });
        }
        if (!reconnectTimer && !isSwitchingRoom) {
            reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWebSocket(currentRoom); }, 2000);
        }
    });

    ws.addEventListener('error', () => { });
}

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
    counterValue: document.getElementById('counter-value'),
    loginBox: document.getElementById('login-box'),
    stepWallet: document.getElementById('step-wallet'),
    btnPhantom: document.getElementById('btn-phantom'),
    btnBack: document.getElementById('btn-back-wallet'),
    btnColor: document.getElementById('btn-color'),
    colorPopover: document.getElementById('color-picker-popover'),
    btnAdminGame: document.getElementById('btn-admin-game'),
    adminPanel: document.getElementById('admin-panel'),
    roundSelect: document.getElementById('round-select'),
    gameOverlay: document.getElementById('game-overlay'),
    gameMessage: document.getElementById('game-message'),
    pinnedBanner: document.getElementById('pinned-banner'),
    pinText: document.getElementById('pin-text'),
    roomList: document.getElementById('room-list'),
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

// ═══ TOKEN CHECK ═══
async function checkTokenBalance(walletAddress) {
    try {
        // console.log('[TOKEN] Checking balance for', walletAddress, 'mint:', TOKEN_MINT);
        const response = await fetch(HELIUS_RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getTokenAccountsByOwner',
                params: [
                    walletAddress,
                    { mint: TOKEN_MINT },
                    { encoding: 'jsonParsed' }
                ]
            })
        });
        const data = await response.json();
        // console.log('[TOKEN] RPC response:', JSON.stringify(data).substring(0, 500));
        if (data.error) {
            console.error('[TOKEN] RPC error:', data.error);
            return false;
        }
        if (data.result && data.result.value && data.result.value.length > 0) {
            for (const account of data.result.value) {
                const amount = account.account.data.parsed.info.tokenAmount.uiAmount;
                // console.log('[TOKEN] Found account with amount:', amount);
                if (amount > 0) return true;
            }
        }
        // console.log('[TOKEN] No token accounts found or all balances are 0');
        return false;
    } catch (err) {
        console.error('[TOKEN] Check failed:', err);
        return false;
    }
}

// ═══ ROOMS ═══
function renderRoomList() {
    if (!DOM.roomList) return;
    DOM.roomList.innerHTML = '';

    ROOMS.forEach(room => {
        const li = document.createElement('li');
        li.className = 'room-item' + (room.id === currentRoom ? ' active' : '');

        const isLocked = room.gated && !hasToken;
        li.innerHTML = `
            <span class="room-icon">${isLocked ? '🔒' : room.icon}</span>
            <span class="room-name">${room.name}</span>
        `;

        if (isLocked) {
            li.classList.add('locked');
            li.title = 'Hold the required token to access';
        }

        li.addEventListener('click', async () => {
            if (room.id === currentRoom) return;
            if (isSwitchingRoom) return; // Prevent clicks during room switch

            if (room.gated && !hasToken) {
                // Re-check token balance for visual update, but always attempt the switch
                // (server handles admin bypass and final token check)
                li.querySelector('.room-icon').textContent = '⏳';
                hasToken = await checkTokenBalance(currentWalletAddress);
                renderRoomList();
            }

            switchRoom(room.id);
        });

        DOM.roomList.appendChild(li);
    });
}

function switchRoom(roomId) {
    if (roomId === currentRoom && ws && ws.readyState === WebSocket.OPEN) return;
    if (isSwitchingRoom) return; // Prevent re-entry
    isSwitchingRoom = true;
    currentRoom = roomId;
    DOM.chatMessages.innerHTML = '';
    // Clear pinned banner — new room will send its own
    DOM.pinnedBanner.classList.add('hidden');

    // Clear remote cursors
    Object.keys(remoteCursors).forEach(id => removeRemoteCursor(id));

    // Clear reconnect timer
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    // Close existing connection — null it so its close handler can't trigger reconnect
    if (ws) {
        const oldWs = ws;
        ws = null;
        oldWs.close();
    }

    // Connect to new room immediately
    connectWebSocket(roomId);
    renderRoomList();
}

// ═══ WALLET FLOW (Phantom only) ═══
DOM.btnPhantom.addEventListener('click', async () => {
    if (window.solana && window.solana.isPhantom) {
        try {
            const resp = await window.solana.connect();
            currentWalletAddress = resp.publicKey.toString();
            console.log('[WALLET] Connected:', currentWalletAddress);

            // Check token balance FIRST (before signing)
            hasToken = await checkTokenBalance(currentWalletAddress);
            console.log('[WALLET] hasToken:', hasToken);
            renderRoomList();

            // Then sign a message to prove wallet ownership
            try {
                const msg = 'Sign in to tryl.chat';
                const encodedMsg = new TextEncoder().encode(msg);
                const { signature } = await window.solana.signMessage(encodedMsg, 'utf8');
                currentSignature = btoa(String.fromCharCode(...new Uint8Array(signature)));
                currentSignMsg = msg;
                console.log('[WALLET] Message signed successfully');
            } catch (signErr) {
                console.error('[WALLET] Sign failed:', signErr);
                alert('Message signing is required to enter chat. Please try again and approve the signature.');
                return;
            }

            goToStep2();
        } catch (err) {
            console.error('[WALLET] Connect error:', err);
            alert('Connection failed or rejected');
        }
    } else {
        alert('Phantom wallet not found! Please install it.');
        window.open('https://phantom.app/', '_blank');
    }
});

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
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'join',
            username: name,
            wallet: currentWalletAddress,
            signature: currentSignature,
            signMessage: currentSignMsg
        }));
    }
    DOM.loginOverlay.classList.add('hidden');
    DOM.chatPage.classList.remove('hidden');
    DOM.chatInput.focus();
    renderRoomList();
});

// ═══ COLOR PICKER ═══
// ═══ COLOR PICKER ═══
let colorPickerInstance = null;
let userColor = '#ffffff';

try {
    userColor = localStorage.getItem('chat_color') || '#ffffff';
} catch (e) {
    console.warn('LocalStorage access blocked', e);
}

// Set initial button color
if (DOM.btnColor) {
    DOM.btnColor.style.backgroundColor = userColor;
}

function setupColorPicker() {
    const btnColor = DOM.btnColor;
    const popover = DOM.colorPopover;

    if (!btnColor || !popover) return;

    btnColor.addEventListener('click', (e) => {
        e.stopPropagation();
        if (popover.classList.contains('hidden')) {
            showColorPicker();
        } else {
            hideColorPicker();
        }
    });

    document.addEventListener('click', (e) => {
        if (!popover.classList.contains('hidden') &&
            !popover.contains(e.target) &&
            e.target !== btnColor) {
            hideColorPicker();
        }
    });

    function showColorPicker() {
        if (!colorPickerInstance && window.iro) {
            colorPickerInstance = new iro.ColorPicker(popover, {
                width: 150,
                color: userColor,
                layout: [
                    { component: iro.ui.Wheel, options: {} },
                ]
            });

            colorPickerInstance.on('color:change', function (color) {
                const newColor = color.hexString;
                btnColor.style.backgroundColor = newColor;
                try {
                    localStorage.setItem('chat_color', newColor);
                } catch (e) { /* ignore */ }

                // Send update to server
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'update-color',
                        color: newColor
                    }));
                }
            });
        }
        popover.classList.remove('hidden');
    }

    function hideColorPicker() {
        popover.classList.add('hidden');
    }
}

setupColorPicker();

// ═══ EMOJI PICKER ═══
let pickerInstance = null;

function setupEmojiPicker() {
    const btnEmoji = document.getElementById('btn-emoji');
    const container = document.getElementById('emoji-picker-container');

    if (!btnEmoji || !container) return;

    btnEmoji.addEventListener('click', (e) => {
        e.stopPropagation();
        if (container.classList.contains('hidden')) {
            showPicker();
        } else {
            hidePicker();
        }
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!container.classList.contains('hidden') &&
            !container.contains(e.target) &&
            e.target !== btnEmoji) {
            hidePicker();
        }
    });

    function showPicker() {
        if (!pickerInstance) {
            // Use global EmojiMart object from browser script
            if (typeof EmojiMart === 'undefined') {
                console.error('EmojiMart not loaded');
                alert('Emoji library loading... please try again.');
                return;
            }

            const pickerOptions = {
                data: async () => {
                    const response = await fetch(
                        'https://cdn.jsdelivr.net/npm/@emoji-mart/data@latest/sets/14/native.json'
                    );
                    return response.json();
                },
                onEmojiSelect: (emoji) => {
                    insertEmoji(emoji.native);
                },
                theme: 'dark',
                previewPosition: 'none',
                skinTonePosition: 'none',
                navPosition: 'bottom',
                perLine: 8,
                maxFrequentRows: 1,
                onClickOutside: (e) => {
                    // We handle outside clicks manually for the toggle button logic, 
                    // but we can close it here if strictly outside.
                    // However, our existing document click listener handles this well.
                }
            };

            pickerInstance = new EmojiMart.Picker(pickerOptions);
            container.appendChild(pickerInstance);
        }
        container.classList.remove('hidden');
    }

    function hidePicker() {
        container.classList.add('hidden');
    }

    function insertEmoji(emoji) {
        const input = DOM.chatInput;
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const text = input.value;
        input.value = text.substring(0, start) + emoji + text.substring(end);
        input.selectionStart = input.selectionEnd = start + emoji.length;
        input.focus();
    }
}

// Initialize picker setup
setupEmojiPicker();

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
    } else if (data.isMod) {
        const badge = document.createElement('span');
        badge.className = 'mod-badge'; // We need to style this
        badge.textContent = 'MOD';
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
        if (ws && ws.readyState === WebSocket.OPEN) {
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
        if (ws && ws.readyState === WebSocket.OPEN) {
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
        if (ws && ws.readyState === WebSocket.OPEN) {
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
connectWebSocket('main-lobby');
