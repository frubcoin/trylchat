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
let currentWalletAddress = null;

function getWsUrl(roomId) {
    return `${WS_PROTOCOL}://${PARTYKIT_HOST}/party/${roomId}`;
}

let ws;
let reconnectTimer = null;
let isSwitchingRoom = false;
let typingTimeout = null;
let isTyping = false;

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
            ws.send(JSON.stringify(joinMsg));
        }
    });

    ws.addEventListener('message', (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }

        switch (data.type) {
            case 'chat-message':
                appendChatMessage(data, false);
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
                        if (msg.msgType === 'chat') appendChatMessage(msg, true);
                        else if (msg.msgType === 'system') appendSystemMessage(msg);
                    });
                    scrollToBottom();
                }
                break;
            case 'cursor':
                if (currentUsername) updateRemoteCursor(data);
                break;
            case 'cursor-gone':
                removeRemoteCursor(data.id);
                break;
            case 'typing-users':
                updateTypingIndicator(data.users || []);
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

            case 'reaction-update':
                updateMessageReactions(data.messageId, data.reactions);
                break;

        }
    });

    ws.addEventListener('close', () => {
        // Ignore close events from stale WebSockets (e.g. old room after switching)
        if (ws !== thisWs) return;
        if (!isSwitchingRoom) {
            appendSystemMessage({ text: 'connection lost — reconnecting...', timestamp: Date.now() });
        }
        sendTypingState(false);
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
    walletAddressDisplay: document.getElementById('wallet-address-display'),
    typingIndicator: document.getElementById('typing-indicator'),
    roomsSidebar: document.getElementById('rooms-sidebar'),
    sidebar: document.getElementById('sidebar'),
    sidebarBackdrop: document.getElementById('sidebar-backdrop'),
    languageSelect: document.getElementById('language-select'),
};

let userLanguage = 'en';
let currentUsername = '';
try {
    const savedName = localStorage.getItem('chat_username') || '';
    if (savedName && DOM.usernameInput) {
        DOM.usernameInput.value = savedName;
    }
    const savedLang = localStorage.getItem('chat_language') || 'en';
    if (savedLang && DOM.languageSelect) {
        DOM.languageSelect.value = savedLang;
        userLanguage = savedLang;
    }
} catch (e) { }



// let currentWalletAddress = null; // Moved up to state section

// Chat history tracking
const sentHistory = [];
let historyIndex = -1;
let currentDraft = '';

// Reply state
let replyContext = null; // { id, username, text }



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
                // Re-check token balance for visual update
                li.querySelector('.room-icon').textContent = '⏳';
                const balanceOk = await checkTokenBalance(currentWalletAddress);
                hasToken = balanceOk;
                renderRoomList();
                if (!balanceOk) {
                    // Optional: maybe don't even try to switch if token check fails here?
                    // But we let switchRoom handle the logic for consistency.
                }
            }

            await switchRoom(room.id);
        });

        DOM.roomList.appendChild(li);
    });
}

async function switchRoom(roomId) {
    if (roomId === currentRoom && ws && ws.readyState === WebSocket.OPEN) return;
    if (isSwitchingRoom) return; // Prevent re-entry
    isSwitchingRoom = true;

    // Ensure we have a signature for the current wallet before switching rooms
    if (currentWalletAddress && !currentSignature) {
        try {
            console.log('[ROOM-SWITCH] Signature missing for current wallet, requesting...');
            await signToAccess();
        } catch (err) {
            console.warn('[ROOM-SWITCH] Signature rejected, cancelling switch');
            isSwitchingRoom = false;
            renderRoomList();
            return;
        }
    }

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

    // Close mobile menus on switch
    document.body.classList.remove('mobile-menu-active', 'mobile-users-active');

    // Connect to new room immediately
    connectWebSocket(roomId);
    renderRoomList();
}


// ═══ WALLET FLOW (Phantom only) ═══

async function updateWalletUI() {
    if (!DOM.walletAddressDisplay) return;
    if (currentWalletAddress) {
        const short = currentWalletAddress.slice(0, 4) + '...' + currentWalletAddress.slice(-4);
        DOM.walletAddressDisplay.textContent = `Wallet: ${short}`;
        DOM.walletAddressDisplay.classList.remove('hidden');
        DOM.btnPhantom.textContent = 'Sign & Enter →';
        DOM.btnPhantom.style.background = '#F9FAFB';
        DOM.btnPhantom.style.color = '#000';
    } else {
        DOM.walletAddressDisplay.textContent = '';
        DOM.walletAddressDisplay.classList.add('hidden');
        DOM.btnPhantom.textContent = 'Connect Phantom';
        DOM.btnPhantom.style.background = '#F9FAFB';
        DOM.btnPhantom.style.color = '#000';
    }
}

function getPhantomProvider() {
    if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
    if (window.solana?.isPhantom) return window.solana;
    return null;
}

let isConnecting = false;

async function connectWallet(eager = false) {
    if (isConnecting) return;

    // Only lock if not eager (manual interaction) to prevent double-clicks
    // Eager conn is background, shouldn't block user if it stalls (though it typically resolves fast)
    if (!eager) isConnecting = true;

    const provider = getPhantomProvider();
    if (provider) {
        try {
            // Eager connect if trusted, otherwise standard connect
            const resp = await provider.connect(eager ? { onlyIfTrusted: true } : {});
            currentWalletAddress = resp.publicKey.toString();
            console.log('[WALLET] Connected:', currentWalletAddress);

            loadWalletColor(currentWalletAddress);
            updateWalletUI();

            // Check token balance
            hasToken = await checkTokenBalance(currentWalletAddress);
            renderRoomList();

            // Add listeners (only once)
            provider.off('accountChanged');
            provider.off('disconnect');
            provider.on('accountChanged', (publicKey) => {
                if (publicKey) {
                    const newAddress = publicKey.toBase58();
                    if (newAddress !== currentWalletAddress) {
                        console.log('[WALLET] Account changed:', newAddress);
                        currentWalletAddress = newAddress;
                        // Force re-sign on change
                        currentSignature = null;
                        currentSignMsg = null;
                        loadWalletColor(currentWalletAddress);
                        updateWalletUI();
                        checkTokenBalance(currentWalletAddress).then(res => {
                            hasToken = res;
                            renderRoomList();
                        });
                    }
                } else {
                    // This can happen if user disconnects from within Phantom
                    handleWalletDisconnect();
                }
            });
            provider.on('disconnect', handleWalletDisconnect);

            if (!eager) {
                // If this was a manual click, we proceed to signing
                await signToAccess();
                goToStep2();
            }
        } catch (err) {
            if (!eager) {
                console.error('[WALLET] Connect error:', err);
                // alert('Connection failed or rejected'); 
                // Alert annoyance - better to just log
            }
        } finally {
            if (!eager) isConnecting = false;
        }
    } else if (!eager) {
        isConnecting = false;
        alert('Phantom wallet not found! Please install it.');
        window.open('https://phantom.app/', '_blank');
    }
}

function handleWalletDisconnect() {
    console.log('[WALLET] Disconnected');
    currentWalletAddress = null;
    currentSignature = null;
    currentSignMsg = null;
    hasToken = false;
    updateWalletUI();
    renderRoomList();
    // Return to step 1
    DOM.loginForm.classList.add('hidden');
    DOM.stepWallet.classList.remove('hidden');
}

async function signToAccess() {
    try {
        const msg = 'Sign in to tryl.chat';
        const encodedMsg = new TextEncoder().encode(msg);
        const provider = getPhantomProvider();
        if (!provider) throw new Error('Phantom provider unavailable');
        const { signature } = await provider.signMessage(encodedMsg, 'utf8');
        currentSignature = btoa(String.fromCharCode(...new Uint8Array(signature)));
        currentSignMsg = msg;
        console.log('[WALLET] Message signed successfully');
    } catch (signErr) {
        console.error('[WALLET] Sign failed:', signErr);
        throw signErr; // Re-throw to caller
    }
}

DOM.btnPhantom.addEventListener('click', () => connectWallet(false));

// Check for eager connection on load
window.addEventListener('load', () => {
    connectWallet(true);
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
    userLanguage = DOM.languageSelect ? DOM.languageSelect.value : 'en';
    try {
        localStorage.setItem('chat_username', name);
        localStorage.setItem('chat_language', userLanguage);
    } catch (e) { }
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'join',
            username: name,
            wallet: currentWalletAddress,
            signature: currentSignature,
            signMessage: currentSignMsg,
            color: userColor
        }));
    }
    DOM.loginOverlay.classList.add('hidden');
    DOM.chatPage.classList.remove('hidden');
    DOM.chatInput.focus();
    renderRoomList();
});

// ═══ COLOR PICKER ═══
let colorPickerInstance = null;
let fallbackColorInput = null;
let userColor = '#ffffff';

// Make fallback function globally accessible
function createFallbackColorPicker() {
    console.log('Creating fallback color picker');
    const popover = document.getElementById('color-picker-popover');
    if (!popover) return;

    popover.innerHTML = '';

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = userColor;
    colorInput.style.width = '100%';
    colorInput.style.height = '40px';
    colorInput.style.border = 'none';
    colorInput.style.borderRadius = '8px';
    colorInput.style.cursor = 'pointer';

    colorInput.addEventListener('change', (e) => {
        const newColor = e.target.value;
        userColor = newColor;
        const btnColor = document.getElementById('btn-color');
        if (btnColor) btnColor.style.backgroundColor = newColor;

        try {
            localStorage.setItem('chat_color', newColor);
            if (currentWalletAddress) {
                localStorage.setItem(`chat_color_${currentWalletAddress}`, newColor);
            }
        } catch (e) { /* ignore */ }

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'update-color',
                color: newColor
            }));
        }
    });

    popover.appendChild(colorInput);
    popover.classList.remove('hidden');
}

function loadWalletColor(wallet) {
    if (!wallet) return;
    try {
        const saved = localStorage.getItem(`chat_color_${wallet}`);
        if (saved && /^#[0-9A-F]{6}$/i.test(saved)) {
            userColor = saved;
        } else {
            // Fallback to generic if no wallet-specific color
            userColor = localStorage.getItem('chat_color') || '#ffffff';
        }

        if (DOM.btnColor) {
            DOM.btnColor.style.backgroundColor = userColor;
        }
        if (colorPickerInstance) {
            applyPickerColor(userColor);
        }
    } catch (e) {
        console.warn('LocalStorage access blocked', e);
    }
}

// Set initial color from generic if no wallet yet
try {
    userColor = localStorage.getItem('chat_color') || '#ffffff';
} catch (e) { }

if (DOM.btnColor) {
    DOM.btnColor.style.backgroundColor = userColor;
}

function setupColorPicker() {
    const btnColor = DOM.btnColor;
    const popover = DOM.colorPopover;

    console.log('Setting up color picker...', { btnColor: !!btnColor, popover: !!popover, iro: !!window.iro });

    if (!btnColor || !popover) {
        console.error('Color picker elements not found:', { btnColor, popover });
        return;
    }

    // Flag to prevent double handling
    let isHandlingClick = false;

    // Remove any existing listeners to prevent duplicates
    btnColor.replaceWith(btnColor.cloneNode(true));
    const newBtnColor = document.getElementById('btn-color');
    DOM.btnColor = newBtnColor;

    newBtnColor.addEventListener('click', (e) => {
        console.log('Color button clicked');

        if (isHandlingClick) {
            console.log('Already handling click, ignoring');
            return;
        }

        isHandlingClick = true;
        e.preventDefault();
        e.stopPropagation();

        if (popover.classList.contains('hidden')) {
            console.log('Showing color picker');
            showColorPicker();
        } else {
            console.log('Hiding color picker');
            hideColorPicker();
        }

        // Reset flag after a short delay
        setTimeout(() => {
            isHandlingClick = false;
        }, 100);
    });

    // Close on outside click - but not immediately
    let outsideClickTimeout;
    document.addEventListener('click', (e) => {
        if (!popover.classList.contains('hidden') &&
            !popover.contains(e.target) &&
            e.target !== newBtnColor) {

            // Clear any existing timeout
            if (outsideClickTimeout) {
                clearTimeout(outsideClickTimeout);
            }

            // Delay hiding to prevent immediate hide after show
            outsideClickTimeout = setTimeout(() => {
                if (!popover.classList.contains('hidden')) {
                    hideColorPicker();
                }
            }, 50);
        }
    });

    function applyColor(newColor) {
        userColor = newColor;
        newBtnColor.style.backgroundColor = newColor;

        try {
            // Save to both generic and wallet-specific
            localStorage.setItem('chat_color', newColor);
            if (currentWalletAddress) {
                localStorage.setItem(`chat_color_${currentWalletAddress}`, newColor);
            }
        } catch (e) { /* ignore */ }

        // Send update to server
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'update-color',
                color: newColor
            }));
        }
    }

    function mountFallbackPicker() {
        if (fallbackColorInput) {
            if (!fallbackColorInput.isConnected) {
                popover.appendChild(fallbackColorInput);
            }
            return;
        }
        fallbackColorInput = document.createElement('input');
        fallbackColorInput.type = 'color';
        fallbackColorInput.value = userColor;
        fallbackColorInput.setAttribute('aria-label', 'Pick chat name color');
        fallbackColorInput.addEventListener('input', (event) => {
            applyColor(event.target.value);
        });
        popover.appendChild(fallbackColorInput);
    }

    function applyPickerColor(colorValue) {
        if (!colorPickerInstance) return;
        if (typeof colorPickerInstance.setColor === 'function') {
            colorPickerInstance.setColor(colorValue);
            return;
        }
        if (colorPickerInstance.color) {
            colorPickerInstance.color.hexString = colorValue;
        }
    }

    function showColorPicker() {
        console.log('showColorPicker called, iro available:', !!window.iro);

        // Clear any existing outside click timeout
        if (outsideClickTimeout) {
            clearTimeout(outsideClickTimeout);
        }

        if (!window.iro) {
            mountFallbackPicker();
            fallbackColorInput.value = userColor;
            popover.classList.remove('hidden');
            return;
        }

        if (!colorPickerInstance) {
            try {
                console.log('Creating color picker instance...');

                // Clear popover first
                popover.innerHTML = '';
                fallbackColorInput = null;

                colorPickerInstance = new iro.ColorPicker(popover, {
                    width: 150,
                    color: userColor,
                    layout: [
                        { component: iro.ui.Wheel, options: {} },
                    ]
                });
                console.log('Color picker created successfully');

                colorPickerInstance.on('color:change', function (color) {
                    applyColor(color.hexString);
                });
            } catch (err) {
                console.error('Failed to create color picker:', err);
                // Fallback to simple HTML5 color input
                mountFallbackPicker();
                fallbackColorInput.value = userColor;
            }
        } else {
            applyPickerColor(userColor);
        }

        console.log('Removing hidden class from popover');
        popover.classList.remove('hidden');

        // Debug: Check if the picker is actually visible
        setTimeout(() => {
            const rect = popover.getBoundingClientRect();
            console.log('Color picker popover dimensions:', {
                width: rect.width,
                height: rect.height,
                visible: rect.width > 0 && rect.height > 0,
                display: window.getComputedStyle(popover).display,
                visibility: window.getComputedStyle(popover).visibility
            });

            // Also check if iro created any elements inside
            const iroElements = popover.querySelectorAll('[class*="iro"]');
            console.log('IRO elements found:', iroElements.length);
        }, 200);
    }

    function hideColorPicker() {
        console.log('Hiding color picker popover');
        popover.classList.add('hidden');
    }
}

// Initialize color picker with delay to ensure iro.js is loaded
setTimeout(() => {
    setupColorPicker();
}, 200);

// ═══ EMOJI PICKER ═══
let pickerInstance = null;

function setupEmojiPicker() {
    const btnEmoji = document.getElementById('btn-emoji');
    const container = document.getElementById('emoji-picker-container');

    if (!btnEmoji || !container) {
        console.error('Emoji picker elements not found:', { btnEmoji: !!btnEmoji, container: !!container });
        return;
    }

    console.log('Setting up emoji picker...');

    // Flag to prevent double handling
    let isHandlingClick = false;

    // Remove any existing listeners to prevent duplicates
    btnEmoji.replaceWith(btnEmoji.cloneNode(true));
    const newBtnEmoji = document.getElementById('btn-emoji');

    newBtnEmoji.addEventListener('click', (e) => {
        console.log('Emoji button clicked');

        if (isHandlingClick) {
            console.log('Already handling emoji click, ignoring');
            return;
        }

        isHandlingClick = true;
        e.preventDefault();
        e.stopPropagation();

        if (container.classList.contains('hidden')) {
            console.log('Showing emoji picker');
            showPicker();
        } else {
            console.log('Hiding emoji picker');
            hidePicker();
        }

        // Reset flag after a short delay
        setTimeout(() => {
            isHandlingClick = false;
        }, 100);
    });

    // Close on outside click - but not immediately
    let outsideClickTimeout;
    document.addEventListener('click', (e) => {
        if (!container.classList.contains('hidden') &&
            !container.contains(e.target) &&
            e.target !== newBtnEmoji) {

            // Clear any existing timeout
            if (outsideClickTimeout) {
                clearTimeout(outsideClickTimeout);
            }

            // Delay hiding to prevent immediate hide after show
            outsideClickTimeout = setTimeout(() => {
                if (!container.classList.contains('hidden')) {
                    hidePicker();
                }
            }, 50);
        }
    });

    function showPicker() {
        console.log('showPicker called, EmojiMart available:', typeof EmojiMart !== 'undefined');

        // Clear any existing outside click timeout
        if (outsideClickTimeout) {
            clearTimeout(outsideClickTimeout);
        }

        if (!pickerInstance) {
            // Use global EmojiMart object from browser script
            if (typeof EmojiMart === 'undefined') {
                console.error('EmojiMart not loaded');
                alert('Emoji library loading... please try again.');
                return;
            }

            console.log('Creating emoji picker instance...');

            const pickerOptions = {
                data: async () => {
                    const response = await fetch(
                        'https://cdn.jsdelivr.net/npm/@emoji-mart/data@latest/sets/14/native.json'
                    );
                    if (!response.ok) throw new Error(`emoji data fetch failed: ${response.status}`);
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

            try {
                pickerInstance = new EmojiMart.Picker(pickerOptions);
                container.appendChild(pickerInstance);
            } catch (err) {
                console.warn('Emoji picker failed, falling back to quick emojis:', err);
                const quick = document.createElement('div');
                quick.className = 'quick-emoji-picker';
                ['😀', '😂', '🥲', '😍', '🔥', '👍', '👀', '💯', '🙏', '🎉', '🚀', '❤️'].forEach((emoji) => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.textContent = emoji;
                    b.addEventListener('click', () => {
                        insertEmoji(emoji);
                        hidePicker();
                    });
                    quick.appendChild(b);
                });
                pickerInstance = quick;
                container.appendChild(quick);
            }
            console.log('Emoji picker created successfully');
        }
        container.classList.remove('hidden');

        // Debug: Check if the picker is actually visible
        setTimeout(() => {
            const rect = container.getBoundingClientRect();
            console.log('Emoji picker container dimensions:', {
                width: rect.width,
                height: rect.height,
                visible: rect.width > 0 && rect.height > 0,
                display: window.getComputedStyle(container).display,
                visibility: window.getComputedStyle(container).visibility
            });
        }, 200);
    }

    function hidePicker() {
        console.log('Hiding emoji picker');
        container.classList.add('hidden');
    }

    function insertEmoji(emoji) {
        if (reactionTargetId) {
            sendReaction(reactionTargetId, emoji);
            reactionTargetId = null; // Reset
            hidePicker();
            return;
        }

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

DOM.chatInput.addEventListener('input', () => {
    const hasText = DOM.chatInput.value.trim().length > 0;
    sendTypingState(hasText);

    if (typingTimeout) clearTimeout(typingTimeout);
    if (hasText) {
        typingTimeout = setTimeout(() => {
            sendTypingState(false);
            typingTimeout = null;
        }, 1500);
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
        const payload = { type: 'chat', text: msg };
        if (replyContext) {
            payload.replyTo = replyContext;
        }
        ws.send(JSON.stringify(payload));
    }

    // Clear reply state
    cancelReply();

    sendTypingState(false);
    if (typingTimeout) {
        clearTimeout(typingTimeout);
        typingTimeout = null;
    }
    DOM.chatInput.value = '';
    DOM.chatInput.focus();
});

// ═══ RENDER ═══
function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function linkifyText(text) {
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    return escapeHtml(text).replace(urlRegex, (url) => {
        const escapedUrl = escapeHtml(url);
        return `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer">${escapedUrl}</a>`;
    });
}

function getEmbedUrl(urlString) {
    try {
        const url = new URL(urlString);
        const host = url.hostname.replace(/^www\./, '');

        if ((host === 'youtube.com' || host === 'youtu.be')) {
            const videoId = host === 'youtu.be'
                ? url.pathname.slice(1)
                : url.searchParams.get('v');
            if (videoId) {
                return {
                    type: 'iframe',
                    src: `https://www.youtube.com/embed/${encodeURIComponent(videoId)}`
                };
            }
        }

        if (/\.(png|jpe?g|gif|webp)$/i.test(url.pathname)) {
            return { type: 'img', src: urlString };
        }

        if (/\.(mp4|webm)$/i.test(url.pathname)) {
            return { type: 'video', src: urlString };
        }
    } catch (_) {
        return null;
    }

    return null;
}

function updateTypingIndicator(users) {
    if (!DOM.typingIndicator) return;
    console.log('[TYPING] Received users:', users);

    const activeUsers = users.filter((u) => u && u !== currentUsername);
    console.log('[TYPING] Active (others):', activeUsers);
    const count = activeUsers.length;

    if (count === 0) {
        DOM.typingIndicator.classList.add('hidden');
        DOM.typingIndicator.textContent = '';
        return;
    }

    let label = '';
    const maxShow = 10;

    if (count === 1) {
        label = `${activeUsers[0]} is typing…`;
    } else if (count <= maxShow) {
        const last = activeUsers[count - 1];
        const others = activeUsers.slice(0, count - 1);
        label = `${others.join(', ')} and ${last} are typing…`;
    } else {
        const shown = activeUsers.slice(0, maxShow);
        const remainder = count - maxShow;
        label = `${shown.join(', ')} and ${remainder} others are typing…`;
    }

    DOM.typingIndicator.textContent = label;
    DOM.typingIndicator.classList.remove('hidden');
}

function sendTypingState(nextState) {
    if (isTyping === nextState) return;
    isTyping = nextState;

    if (ws && ws.readyState === WebSocket.OPEN && currentUsername) {
        ws.send(JSON.stringify({ type: 'typing', isTyping: nextState }));
    }
}

function formatTime(ts) {
    const d = new Date(ts);
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
}

function updateAIStatus(status, label) {
    const aiStatus = document.getElementById('ai-status');
    if (!aiStatus) return;

    // Reset classes
    aiStatus.className = '';

    if (status === 'unavailable') {
        aiStatus.classList.add('hidden');
        aiStatus.textContent = '';
    } else if (status === 'downloading') {
        aiStatus.classList.remove('hidden');
        aiStatus.classList.add('ai-status-downloading');
        aiStatus.textContent = `Downloading ${label || 'Model'}...`;
        aiStatus.title = 'Downloading AI Model';
    } else if (status === 'ready') {
        aiStatus.classList.remove('hidden');
        aiStatus.classList.add('ai-status-ready');
        aiStatus.textContent = 'AI Ready';

        // Auto-hide after 3s
        setTimeout(() => {
            aiStatus.classList.add('hidden');
        }, 3000);
    }
}

async function getGoogleAiLanguageDetector() {
    if (!window.ai?.languageDetector?.capabilities || !window.ai?.languageDetector?.create) {
        updateAIStatus('unavailable');
        return null;
    }

    const capabilities = await window.ai.languageDetector.capabilities();
    if (!capabilities || capabilities.available === 'no') {
        updateAIStatus('unavailable');
        return null;
    }

    let detector;
    try {
        if (capabilities.available === 'readily') {
            detector = await window.ai.languageDetector.create();
        } else {
            // Model needs to be downloaded
            updateAIStatus('downloading', 'Language Model');
            console.log('[AI] Downloading language detection model...');
            detector = await window.ai.languageDetector.create({
                monitor(m) {
                    m.addEventListener('downloadprogress', (e) => {
                        const percent = Math.round((e.loaded / e.total) * 100);
                        console.log(`[AI] Language Model Download: ${percent}%`);
                        updateAIStatus('downloading', `Language Model ${percent}%`);
                    });
                },
            });
            console.log('[AI] Language detection model ready.');
        }
        updateAIStatus('ready');
    } catch (e) {
        console.error('[AI] Failed to create language detector:', e);
        updateAIStatus('unavailable');
        return null;
    }

    return detector;
}

async function getGoogleAiTranslator(sourceLang, targetLang) {
    if (!sourceLang || !targetLang || sourceLang === targetLang) return null;
    if (!window.ai?.translator?.capabilities || !window.ai?.translator?.create) {
        // Optional: only show unavailable if we really want to push it
        // updateAIStatus('unavailable'); 
        return null;
    }

    const capabilities = await window.ai.translator.capabilities({
        sourceLanguage: sourceLang,
        targetLanguage: targetLang
    });

    if (!capabilities || capabilities.available === 'no') {
        return null;
    }

    let translator;
    if (capabilities.available === 'readily') {
        translator = await window.ai.translator.create({
            sourceLanguage: sourceLang,
            targetLanguage: targetLang
        });
    } else {
        // Model needs to be downloaded
        console.log(`[AI] Downloading translation model for ${sourceLang} -> ${targetLang}...`);
        updateAIStatus('downloading', `Translation Model`);

        // Notify user via system message if it's taking time
        appendSystemMessage({
            text: `Downloading AI translation model for ${sourceLang} → ${targetLang}... This may take a moment.`
        });

        translator = await window.ai.translator.create({
            sourceLanguage: sourceLang,
            targetLanguage: targetLang,
            monitor(m) {
                m.addEventListener('downloadprogress', (e) => {
                    const percent = Math.round((e.loaded / e.total) * 100);
                    console.log(`[AI] Translation Model Download: ${percent}%`);
                    updateAIStatus('downloading', `Translation Model ${percent}%`);
                });
            },
        });
        console.log('[AI] Translation model ready.');
        updateAIStatus('ready');
    }

    return translator;
}

async function translateText(text, targetLang) {
    if (!text || !targetLang) return null;

    // --- TIER 1: Google client-side AI APIs in Chrome (Gemini Nano) ---
    try {
        const detector = await getGoogleAiLanguageDetector();
        let detectedLang = null;

        if (detector) {
            const detections = await detector.detect(text);
            if (Array.isArray(detections) && detections.length > 0) {
                const top = detections[0];
                detectedLang = top.detectedLanguage;
                console.log(`[TRANSLATION] Google AI detected ${detectedLang} (${top.confidence})`);
            }
        }

        if (detectedLang && detectedLang === targetLang) {
            return null;
        }

        if (detectedLang) {
            const translator = await getGoogleAiTranslator(detectedLang, targetLang);
            if (translator) {
                const translated = await translator.translate(text);
                if (translated && translated.trim().toLowerCase() !== text.trim().toLowerCase()) {
                    return translated;
                }
            }
        }
    } catch (err) {
        console.warn('[TRANSLATION] Google client-side AI APIs failed, falling back:', err);
    }

    // --- TIER 2: Legacy browser translation API fallback ---
    if (window.translation && typeof window.translation.canTranslate === 'function') {
        try {
            const status = await window.translation.canTranslate({ targetLanguage: targetLang });
            if (status !== 'no') {
                const translator = await window.translation.createTranslator({ targetLanguage: targetLang });
                const result = await translator.translate(text);
                if (result && result.trim().toLowerCase() !== text.trim().toLowerCase()) {
                    return result;
                }
            }
        } catch (err) {
            console.warn('[TRANSLATION] window.translation API failed:', err);
        }
    }

    return null;
}

async function appendChatMessage(data, isHistory = false) {
    if (data.id && document.getElementById(`msg-${data.id}`)) {
        console.log('[CHAT] Skipping duplicate message:', data.id);
        return;
    }
    if (data.isOwner || data.isMod || data.isAdmin) {
        console.log('[CHAT-RENDER] Badge Data:', {
            user: data.username,
            isOwner: data.isOwner,
            isMod: data.isMod,
            isAdmin: data.isAdmin
        });
    }
    const div = document.createElement('div');
    div.className = 'chat-msg';

    // Compact Logic (Group by senderId/wallet instead of username)
    let isCompact = false;
    const lastMsg = DOM.chatMessages.lastElementChild;
    if (lastMsg) {
        const lastSenderId = lastMsg.getAttribute('data-sender-id');
        const lastUser = lastMsg.getAttribute('data-username'); // Fallback
        const lastTime = parseInt(lastMsg.getAttribute('data-timestamp') || '0');
        const now = data.timestamp;

        // Use senderId if available (robust), else username (legacy)
        const isSameUser = data.senderId
            ? (lastSenderId === data.senderId)
            : (lastUser === data.username);

        // 5 minutes = 300,000 ms
        if (isSameUser && (now - lastTime) < 300000 && !data.isSystem && !data.replyTo) {
            isCompact = true;
            div.classList.add('compact');
        }
    }

    div.setAttribute('data-username', data.username);
    if (data.senderId) div.setAttribute('data-sender-id', data.senderId);
    div.setAttribute('data-timestamp', data.timestamp);

    if (!isCompact) {
        div.innerHTML = `
        <div class="msg-header">
          <span class="msg-username"></span>
          <span class="msg-time">${formatTime(data.timestamp)}</span>
        </div>
        <div class="msg-text"></div>`;

        // Secure text insertion for header
        const nameEl = div.querySelector('.msg-username');
        nameEl.textContent = data.username;
        nameEl.style.color = data.color;

        if (data.isOwner) {
            const badge = document.createElement('span');
            badge.className = 'owner-badge';
            badge.textContent = 'OWNER';
            nameEl.after(badge);
        } else if (data.isAdmin) {
            const badge = document.createElement('span');
            badge.className = 'admin-badge';
            badge.textContent = 'ADMIN';
            nameEl.after(badge);
        } else if (data.isMod) {
            const badge = document.createElement('span');
            badge.className = 'mod-badge';
            badge.textContent = 'MOD';
            nameEl.after(badge);
        }
    } else {
        div.innerHTML = `<div class="msg-text"></div>`;
    }

    // reactionsContainer will be created and appended at the end


    // Reply Context
    // Reply Context
    if (data.replyTo) {
        const replyDiv = document.createElement('div');
        replyDiv.className = 'msg-reply-context';
        const nameColor = data.replyTo.color || 'var(--text-muted)';
        replyDiv.innerHTML = `<span class="reply-to-user" style="color: ${nameColor}">@${data.replyTo.username}</span> ${data.replyTo.text}`;

        replyDiv.addEventListener('click', () => {
            // Optional: Scroll to message if we had IDs
            console.log('Clicked reply context');
        });

        // Insert before text, but after header (if exists)
        const textEl = div.querySelector('.msg-text');
        if (textEl) {
            div.insertBefore(replyDiv, textEl);
        } else {
            div.appendChild(replyDiv);
        }
    }

    // Reaction & Reply Actions
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'msg-actions';

    // Reaction Button
    const reactBtn = document.createElement('button');
    reactBtn.className = 'msg-action-btn msg-action-react';
    reactBtn.title = "Add Reaction";
    reactBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11 20H10V22H9V23H5V22H4V16H5V15H6V18H8V17H10V16H12V15H14V17H13V18H11V20Z" fill="white"/><path d="M22 9V7H21V5H20V4H19V3H17V2H15V1H9V2H7V3H5V4H4V5H3V7H2V9H1V15H2V16H3V15H4V14H7V16H9V15H11V14H10V13H8V12H11V13H13V14H15V18H14V19H12V21H11V23H15V22H17V21H19V20H20V19H21V17H22V15H23V9H22ZM15 7H18V8H19V10H18V9H17V8H15V7ZM14 9H16V11H14V9ZM10 10H8V8H10V10ZM11 8V7H10V6H8V7H6V6H7V5H11V6H12V7H13V8H11Z" fill="white"/></svg>`;
    reactBtn.onclick = (e) => {
        e.stopPropagation();
        initiateReaction(data.id, reactBtn);
    };
    actionsDiv.appendChild(reactBtn);

    // Reply Button
    const replyBtn = document.createElement('button');
    replyBtn.className = 'msg-action-btn msg-action-reply';
    replyBtn.title = "Reply";
    replyBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 5H12V10H16V12H12V17H10V12H6V10H10V5Z" fill="white"/></svg>`; // Plus icon for reply? Or maybe arrow
    // Actually let's use a proper reply arrow
    replyBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 16V17H4V18H1V14H2V12H1V7H2V5H4V4H6V3H11V4H13V5H15V7H16V12H15V14H13V15H11V16H5Z" fill="white"/><path d="M23 11V16H22V18H23V22H20V21H19V20H13V19H11V18H9V17H12V16H14V15H16V13H17V7H18V8H20V9H22V11H23Z" fill="white"/></svg>`;

    replyBtn.onclick = (e) => {
        e.stopPropagation();
        initiateReply(data.id, data.text, data.username, data.color);
    };
    actionsDiv.appendChild(replyBtn);


    // Insert actions inline into the text element
    const unescapedText = data.text.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const msgTextEl = div.querySelector('.msg-text');
    msgTextEl.innerHTML = linkifyText(unescapedText);
    msgTextEl.append(actionsDiv);

    // Reactions Container (ensure it's always created so we can target it easily)
    const reactionsContainer = document.createElement('div');
    reactionsContainer.className = 'msg-reactions';
    div.appendChild(reactionsContainer);

    // Initial Reaction Render (must happen AFTER id is set)
    if (data.id) div.id = `msg-${data.id}`;
    if (data.reactions && Object.keys(data.reactions).length > 0) {
        renderReactionsInto(reactionsContainer, data.id, data.reactions);
    }


    if (data.id) div.id = `msg-${data.id}`;

    const urls = unescapedText.match(/(https?:\/\/[^\s]+)/gi) || [];
    const canEmbedUrls = !!(data.isOwner || data.isAdmin || data.isMod || data.canEmbedUrls);
    if (canEmbedUrls && urls.length > 0) {
        const embed = getEmbedUrl(urls[0]);
        if (embed) {
            const wrap = document.createElement('div');
            wrap.className = 'msg-embed';
            if (embed.type === 'iframe') {
                wrap.innerHTML = `<iframe src="${embed.src}" loading="lazy" allowfullscreen referrerpolicy="no-referrer"></iframe>`;
            } else if (embed.type === 'img') {
                wrap.innerHTML = `<img src="${embed.src}" alt="embedded content" loading="lazy">`;
            } else if (embed.type === 'video') {
                wrap.innerHTML = `<video src="${embed.src}" controls preload="metadata"></video>`;
            }
            div.appendChild(wrap);
        }
    }

    // Double click to reply
    div.addEventListener('dblclick', () => {
        initiateReply({ id: data.id, username: data.username, text: data.text });
    });

    DOM.chatMessages.appendChild(div);

    // Auto-Translation: Skip if system message or if it's from history
    // User requested "force translation on any non native language".
    if (!isHistory && unescapedText && userLanguage) {
        const result = await translateText(unescapedText, userLanguage);
        if (result && result.trim().toLowerCase() !== unescapedText.trim().toLowerCase()) {
            const translationDiv = document.createElement('div');
            translationDiv.className = 'msg-translation';
            translationDiv.textContent = `🌐 ${result}`;
            div.appendChild(translationDiv);
            scrollToBottom();
        }
    }
}

let activeReactionPicker = null;

function initiateReaction(msgId, anchorBtn) {
    if (activeReactionPicker) {
        activeReactionPicker.remove();
        activeReactionPicker = null;
    }

    const popover = document.createElement('div');
    popover.className = 'reaction-picker-popover';

    // Position it relative to the button
    // Position it relative to the button
    const rect = anchorBtn.getBoundingClientRect();
    const pickerHeight = 435; // Approximate height of EmojiMart
    const spaceBelow = window.innerHeight - rect.bottom;

    popover.style.position = 'fixed';

    // Check if we should render above or below
    if (spaceBelow < pickerHeight && rect.top > pickerHeight) {
        // Render above
        popover.style.bottom = (window.innerHeight - rect.top + 5) + 'px';
        popover.style.top = 'auto';
    } else {
        // Render below
        popover.style.top = (rect.bottom + 5) + 'px';
        popover.style.bottom = 'auto';
    }

    // Align right edge with button right edge, but ensure it doesn't go off screen left
    // EmojiMart width is ~352px
    const pickerWidth = 352;
    // blockedRight is distance from right edge
    const rightPos = window.innerWidth - rect.right;

    // If placing it right-aligned pushes it off-screen left (screen too narrow?), clamp it
    // But usually right alignment is safe on mobile unless button is way left.
    // Let's stick to right alignment for now but add a max-width if needed.
    popover.style.right = rightPos + 'px';

    // Safety check for mobile: if rightPos causes left overflow
    if (window.innerWidth - rightPos < pickerWidth) {
        popover.style.right = '10px'; // Force it to fit on screen
    }

    popover.style.zIndex = '10000';

    const pickerOptions = {
        data: async () => {
            try {
                const response = await fetch('https://cdn.jsdelivr.net/npm/@emoji-mart/data');
                return await response.json();
            } catch (err) {
                console.error('[PICKER] Failed to load emoji data:', err);
            }
        },
        onEmojiSelect: (emoji) => {
            console.log('[PICKER] Selected emoji:', emoji.native);
            sendReaction(msgId, emoji.native);
            popover.remove();
            activeReactionPicker = null;
        },
        theme: 'dark',
        previewPosition: 'none',
        skinTonePosition: 'none',
        navPosition: 'bottom',
        perLine: 7,
        maxFrequentRows: 0,
    };

    const picker = new EmojiMart.Picker(pickerOptions);
    popover.appendChild(picker);
    document.body.appendChild(popover);
    activeReactionPicker = popover;

    // Close on click outside
    const closeListener = (e) => {
        if (!popover.contains(e.target) && e.target !== anchorBtn) {
            popover.remove();
            activeReactionPicker = null;
            document.removeEventListener('mousedown', closeListener);
        }
    };
    setTimeout(() => document.addEventListener('mousedown', closeListener), 0);
}

async function appendSystemMessage(data) {
    if (data.id && document.getElementById(`msg-${data.id}`)) {
        return;
    }

    const div = document.createElement('div');
    div.className = 'system-msg';
    if (data.id) div.id = `msg-${data.id}`;
    if (data.msgType === 'system') div.classList.add('center-msg');
    div.textContent = data.text;
    DOM.chatMessages.appendChild(div);
}

function updateMessageReactions(msgId, reactions) {
    const msgDiv = document.getElementById(`msg-${msgId}`);
    if (!msgDiv) return;

    const container = msgDiv.querySelector('.msg-reactions');
    if (container) {
        renderReactionsInto(container, msgId, reactions);
    }
}

function renderReactionsInto(container, msgId, reactions) {
    container.innerHTML = '';
    if (!reactions || Object.keys(reactions).length === 0) return;

    // Handle legacy (string) or new (object) format
    // New: { wallet: string|null, username: string }
    // Old: string
    Object.entries(reactions).forEach(([emoji, users]) => {
        if (!Array.isArray(users) || users.length === 0) return;

        const reactionObjects = users.map(u => {
            if (typeof u === 'string') return { wallet: null, username: u };
            return u;
        });

        const pill = document.createElement('div');
        pill.className = 'reaction-pill';

        // Determine if active for current user
        let isActive = false;
        if (currentWalletAddress) {
            isActive = reactionObjects.some(r => r.wallet === currentWalletAddress);
        } else if (currentUsername) {
            // Guest fallback or legacy match
            isActive = reactionObjects.some(r => r.username === currentUsername && !r.wallet);
        }

        if (isActive) {
            pill.classList.add('active');
        }

        const names = reactionObjects.map(r => r.username).join(', ');
        pill.title = names;
        pill.innerHTML = `<span class="reaction-emoji">${emoji}</span> <span class="reaction-count">${users.length}</span>`;

        pill.onclick = (e) => {
            e.stopPropagation();
            sendReaction(msgId, emoji);
        };
        container.appendChild(pill);
    });
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

        if (u.isOwner) {
            const badge = document.createElement('span');
            badge.className = 'owner-badge mini';
            badge.textContent = 'OWNER';
            li.appendChild(badge);
        } else if (u.isAdmin) {
            const badge = document.createElement('span');
            badge.className = 'admin-badge mini';
            badge.textContent = 'ADMIN';
            li.appendChild(badge);
        } else if (u.isMod) {
            const badge = document.createElement('span');
            badge.className = 'mod-badge mini';
            badge.textContent = 'MOD';
            li.appendChild(badge);
        }

        DOM.userList.appendChild(li);
    });
}

function updateVisitorCount(count) {
    if (DOM.visitorNum) DOM.visitorNum.textContent = count.toLocaleString();
    if (DOM.counterValue) DOM.counterValue.textContent = count.toLocaleString();
}

function sendReaction(msgId, emoji) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'reaction',
            messageId: msgId,
            emoji: emoji
        }));
    }
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
    const hammerGame = new Hammer(DOM.gameOverlay);
    hammerGame.on('tap', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'game-click' }));
        }
    });

    DOM.gameOverlay.addEventListener('mousedown', () => {
        // Fallback for desktop clicks
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

// ═══ MOBILE TOGGLES ═══
// Close menus when clicking elsewhere
document.addEventListener('click', () => {
    document.body.classList.remove('mobile-menu-active', 'mobile-users-active');
});

// Stop propagation on sidebar clicks so they don't auto-close when clicking inside
if (DOM.roomsSidebar) {
    DOM.roomsSidebar.addEventListener('click', (e) => e.stopPropagation());
}
if (DOM.sidebar) {
    DOM.sidebar.addEventListener('click', (e) => e.stopPropagation());
}

// ═══ GESTURES (Hammer.js) ═══
function setupGestures() {
    if (typeof Hammer === 'undefined') {
        console.warn('Hammer.js not loaded yet, retrying...');
        setTimeout(setupGestures, 500);
        return;
    }

    const mc = new Hammer.Manager(document.body, {
        recognizers: [
            [Hammer.Tap],
            [Hammer.Swipe, { direction: Hammer.DIRECTION_HORIZONTAL }]
        ]
    });

    // 1. Universal Taps (Bypass mobile click delay)
    mc.on('tap', (e) => {
        const target = e.target;

        // Sidebar Backdrop (Close menus)
        if (target.id === 'sidebar-backdrop') {
            document.body.classList.remove('mobile-menu-active', 'mobile-users-active');
            return;
        }

        // Catch buttons, room items, or any clickable UI element
        // EXCEPTION: Don't trigger if it's the emoji or color button, let native click handle it
        if (target.closest('#btn-emoji, #btn-color, #emoji-picker-container, #color-picker-popover')) {
            return;
        }

        const clickable = target.closest('button, .room-item');
        if (clickable) {
            clickable.click();
            return;
        }
    });

    // 2. Swipe Gestures for Sidebars
    mc.on('swiperight', () => {
        // Open Rooms List
        document.body.classList.add('mobile-menu-active');
        document.body.classList.remove('mobile-users-active');
    });

    mc.on('swipeleft', () => {
        // Open Users List
        document.body.classList.add('mobile-users-active');
        document.body.classList.remove('mobile-menu-active');
    });
}

setupGestures();

// Start connection after DOM and listeners are ready
// ═══ REPLY LOGIC ═══
const replyBar = document.getElementById('reply-bar');
const replyToUser = document.getElementById('reply-to-user');
const replyPreview = document.getElementById('reply-text-preview');
const btnCancelReply = document.getElementById('btn-cancel-reply');

function initiateReply(msgId, text, username, color) {
    console.log('Replying to:', msgId);
    replyContext = { id: msgId, text: text, username: username, color: color };

    const replyBar = document.getElementById('reply-bar');
    const replyUser = document.getElementById('reply-to-user');
    const replyPreview = document.getElementById('reply-text-preview');

    if (replyBar && replyUser && replyPreview) {
        replyUser.textContent = username;
        if (color) replyUser.style.color = color;
        replyPreview.textContent = text;
        replyBar.classList.remove('hidden');
        DOM.chatInput.focus();
    }
}

if (btnCancelReply) {
    btnCancelReply.addEventListener('click', cancelReply);
}

function cancelReply() {
    replyContext = null;
    if (replyBar) replyBar.classList.add('hidden');
    if (replyToUser) replyToUser.textContent = '';
    if (replyPreview) replyPreview.textContent = '';
}

// ═══ SCROLL CONTROLS ═══
const btnScrollTop = document.getElementById('btn-scroll-top');
const btnScrollBottom = document.getElementById('btn-scroll-bottom');

function updateScrollButtons() {
    if (!DOM.chatMessages) return;
    const { scrollTop, scrollHeight, clientHeight } = DOM.chatMessages;

    // Show Top button if scrolled down more than 200px
    if (scrollTop > 200) {
        btnScrollTop?.classList.remove('hidden');
    } else {
        btnScrollTop?.classList.add('hidden');
    }

    // Show Bottom button if not near bottom (allow 50px buffer)
    if (scrollHeight - scrollTop - clientHeight > 50) {
        btnScrollBottom?.classList.remove('hidden');
    } else {
        btnScrollBottom?.classList.add('hidden');
    }
}

if (DOM.chatMessages) {
    DOM.chatMessages.addEventListener('scroll', () => {
        updateScrollButtons();
    });
}

if (btnScrollTop) {
    btnScrollTop.addEventListener('click', () => {
        if (DOM.chatMessages) {
            DOM.chatMessages.scrollTo({ top: 0, behavior: 'smooth' });
        }
    });
}

if (btnScrollBottom) {
    btnScrollBottom.addEventListener('click', () => {
        if (DOM.chatMessages) {
            DOM.chatMessages.scrollTo({ top: DOM.chatMessages.scrollHeight, behavior: 'smooth' });
        }
    });
}

// Start connection after DOM and listeners are ready
connectWebSocket('main-lobby');
