/* ═══════════════════════════════════════
   ★ NekoChat 2000 — Client Script ★
   ═══════════════════════════════════════ */

// ═══ PARTYKIT CONNECTION ═══
// In dev, PartyKit runs on localhost:1999
// In production, update this to your deployed PartyKit host
const PARTYKIT_HOST =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
        ? "localhost:1999"
        : "nekochat.frubcoin.partykit.dev"; // ← UPDATE THIS after deployment

const ws = new PartySocket({
    host: PARTYKIT_HOST,
    room: "main-lobby",
});

// ═══ DOM ELEMENTS ═══
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

let currentUsername = '';

// ═══ LOGIN ═══
loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = usernameInput.value.trim();
    if (!name) return;

    currentUsername = name;
    ws.send(JSON.stringify({ type: 'join', username: name }));

    loginOverlay.classList.add('hidden');
    chatPage.classList.remove('hidden');
    chatInput.focus();
});

// ═══ SEND MESSAGE ═══
chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = chatInput.value.trim();
    if (!msg) return;

    ws.send(JSON.stringify({ type: 'chat', text: msg }));
    chatInput.value = '';
    chatInput.focus();
});

// ═══ RECEIVE MESSAGES ═══
ws.addEventListener('message', (event) => {
    let data;
    try {
        data = JSON.parse(event.data);
    } catch {
        return;
    }

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
            updateUserList(data.users);
            break;
        case 'visitor-count':
            updateVisitorCount(data.count);
            break;
        case 'history':
            // Replay chat history on join
            if (data.messages && Array.isArray(data.messages)) {
                data.messages.forEach(msg => {
                    if (msg.msgType === 'chat') {
                        appendChatMessage(msg);
                    } else if (msg.msgType === 'system') {
                        appendSystemMessage(msg);
                    }
                });
                scrollToBottom();
            }
            break;
    }
});

// ═══ RENDER FUNCTIONS ═══
function formatTime(timestamp) {
    const d = new Date(timestamp);
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
}

function appendChatMessage(data) {
    const div = document.createElement('div');
    div.className = 'chat-msg msg-flash';
    div.style.borderLeftColor = data.color;

    div.innerHTML = `
    <div class="msg-header">
      <span class="msg-username" style="color: ${data.color}">&lt;${data.username}&gt;</span>
      <span class="msg-time">${formatTime(data.timestamp)}</span>
    </div>
    <div class="msg-text">${data.text}</div>
  `;

    chatMessages.appendChild(div);
}

function appendSystemMessage(data) {
    const div = document.createElement('div');
    div.className = 'system-msg';
    div.textContent = data.text;
    chatMessages.appendChild(div);
}

function updateUserList(users) {
    userListEl.innerHTML = '';
    if (!users || users.length === 0) {
        userListEl.innerHTML = '<li class="no-users">No one here yet...</li>';
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
    const padded = String(count).padStart(6, '0');
    if (visitorNum) visitorNum.textContent = count;
    if (counterValue) counterValue.textContent = padded;
}

function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ═══ CURSOR TRAIL EFFECT ═══
const trailSymbols = ['✦', '✧', '★', '☆', '·', '✶', '✴', '✸'];
let trailThrottle = 0;

document.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - trailThrottle < 60) return;
    trailThrottle = now;

    const star = document.createElement('span');
    star.className = 'trail-star';
    star.textContent = trailSymbols[Math.floor(Math.random() * trailSymbols.length)];
    star.style.left = e.clientX + 'px';
    star.style.top = e.clientY + 'px';
    star.style.color = `hsl(${Math.random() * 360}, 100%, 70%)`;

    document.body.appendChild(star);

    setTimeout(() => star.remove(), 800);
});

// ═══ KEYBOARD SHORTCUT ═══
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.activeElement !== chatInput && !loginOverlay.classList.contains('hidden') === false) {
        chatInput.focus();
    }
});

// ═══ ON CONNECT / DISCONNECT ═══
ws.addEventListener('open', () => {
    console.log('✦ Connected to NekoChat 2000 ✦');
});

ws.addEventListener('close', () => {
    appendSystemMessage({
        text: '⚠ Connection lost... Reconnecting... ⚠',
        timestamp: Date.now()
    });
});
