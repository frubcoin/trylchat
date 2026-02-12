
// ═══ AUTOCOMPLETE ═══
const COMMANDS = [
    { cmd: '/clear', desc: 'Clear local chat history', admin: false }, // Wait, /clear in server.ts is global? Let's check. Use /help logic.
    { cmd: '/help', desc: 'Show available commands', admin: false },
    { cmd: '/nick', desc: 'Change your display name', admin: false },
    { cmd: '/me', desc: 'Send an action message', admin: false },
    // Admin commands
    { cmd: '/admin add', desc: 'Add a new admin (Admin only)', admin: true },
    { cmd: '/mute', desc: 'Mute a user (Admin only)', admin: true },
    { cmd: '/whitelist', desc: 'Whitelist a wallet (Admin only)', admin: true },
    { cmd: '/aa', desc: 'Quick allow access (Admin only)', admin: true },
    { cmd: '/pin', desc: 'Pin a message (Admin only)', admin: true },
    { cmd: '/unpin', desc: 'Unpin the current message (Admin only)', admin: true },
];

function setupAutocomplete() {
    const input = document.getElementById('chat-input');
    const container = document.createElement('div');
    container.id = 'autocomplete-list';
    container.className = 'autocomplete-items hidden';
    
    // Position it relative to input, or inside usage wrapper
    // We'll append it to #chat-form or #chat-input-area
    const inputArea = document.getElementById('chat-input-area');
    inputArea.style.position = "relative"; // Ensure context
    inputArea.appendChild(container);

    let currentFocus = -1;

    input.addEventListener('input', function(e) {
        const val = this.value;
        closeAllLists();
        if (!val || !val.startsWith('/')) return;

        currentFocus = -1;
        const matches = COMMANDS.filter(c => {
            if (c.admin && !isAdmin) return false;
            return c.cmd.toLowerCase().startsWith(val.toLowerCase());
        });

        if (matches.length === 0) return;

        container.classList.remove('hidden');
        
        matches.forEach(match => {
            const item = document.createElement('div');
            item.className = 'autocomplete-item';
            item.innerHTML = `<strong>${match.cmd.substr(0, val.length)}</strong>${match.cmd.substr(val.length)} <span class="cmd-desc">${match.desc}</span>`;
            item.addEventListener('click', function() {
                input.value = match.cmd + " ";
                closeAllLists();
                input.focus();
            });
            container.appendChild(item);
        });
    });

    input.addEventListener('keydown', function(e) {
        const x = container.querySelectorAll('.autocomplete-item');
        if (container.classList.contains('hidden')) return;

        if (e.key === 'ArrowDown') {
            currentFocus++;
            addActive(x);
        } else if (e.key === 'ArrowUp') {
            currentFocus--;
            addActive(x);
        } else if (e.key === 'Enter') {
            if (currentFocus > -1) {
                e.preventDefault();
                if (x) x[currentFocus].click();
            } else if (x.length === 1) {
                // Auto-select if only one match? Optional. 
                // Better to just let user hit enter to send if they typed it.
            }
        } else if (e.key === 'Escape') { // Escape
             closeAllLists();
        }
    });

    function addActive(x) {
        if (!x) return false;
        removeActive(x);
        if (currentFocus >= x.length) currentFocus = 0;
        if (currentFocus < 0) currentFocus = (x.length - 1);
        x[currentFocus].classList.add('autocomplete-active');
        x[currentFocus].scrollIntoView({ block: 'nearest' });
    }

    function removeActive(x) {
        for (let i = 0; i < x.length; i++) {
            x[i].classList.remove('autocomplete-active');
        }
    }

    function closeAllLists(elmnt) {
        container.innerHTML = '';
        container.classList.add('hidden');
    }

    document.addEventListener('click', function (e) {
        if (e.target !== input) {
            closeAllLists();
        }
    });
}

// Call setup at the end of init or DOMContent
