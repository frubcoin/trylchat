import type * as Party from "partykit/server";

// ═══ Base58 Decoder (for Solana wallet addresses) ═══
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str: string): Uint8Array {
  const bytes: number[] = [0];
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error('Invalid base58 character');
    let carry = idx;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of str) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

// ═══ Ed25519 Signature Verification (Web Crypto API) ═══
async function verifyEd25519(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      publicKey,
      { name: 'Ed25519' } as any,
      false,
      ['verify']
    );
    return await crypto.subtle.verify('Ed25519' as any, key, signature, message);
  } catch {
    // Fallback for older CF Workers runtimes
    const key = await crypto.subtle.importKey(
      'raw',
      publicKey,
      { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' } as any,
      false,
      ['verify']
    );
    return await crypto.subtle.verify(
      { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' } as any,
      key, signature, message
    );
  }
}

// Retro color palette for usernames
const RETRO_COLORS = [
  "#ff00ff", "#00ffff", "#ffff00", "#ff6600",
  "#00ff00", "#ff0099", "#9900ff", "#ff3333",
  "#33ff33", "#3399ff", "#ff66cc", "#66ffcc",
  "#ffcc00", "#cc66ff", "#66ccff", "#ff9966",
];

function getRandomColor() {
  return RETRO_COLORS[Math.floor(Math.random() * RETRO_COLORS.length)];
}

const MAX_HISTORY = 200;
const HISTORY_ON_JOIN = 100;

// Token gating
const TOKEN_MINT = "UwU8RVXB69Y6Dcju6cN2Qef6fykkq6UUNpB15rZku6Z";
const GATED_ROOMS = ["holders-lounge"];

// Rate limit: 5 messages per 10 seconds
const RATE_LIMIT_WINDOW = 10000;
const MAX_MESSAGES_PER_WINDOW = 5;

type GameState = "IDLE" | "READY" | "GO";

export default class NekoChat implements Party.Server {
  private getAdminWallets(): string[] {
    const adminWallets = (this.room.env.ADMIN_WALLETS as string) || "";
    return adminWallets.split(",").map(w => w.trim()).filter(Boolean);
  }

  private getMemberWallets(): string[] {
    const memberWallets = (this.room.env.MEMBER_WALLETS as string) || "";
    return memberWallets.split(",").map(w => w.trim()).filter(Boolean);
  }

  private async getStoredMemberWallets(): Promise<string[]> {
    return (await this.room.storage.get<string[]>("storedMemberWallets")) || [];
  }

  private async getStoredAdminWallets(): Promise<string[]> {
    return (await this.room.storage.get<string[]>("storedAdminWallets")) || [];
  }

  private async getStoredModWallets(): Promise<string[]> {
    return (await this.room.storage.get<string[]>("storedModWallets")) || [];
  }

  private async getAllAdminWallets(): Promise<string[]> {
    const envAdmins = this.getAdminWallets();
    const storedAdmins = await this.getStoredAdminWallets();
    return Array.from(new Set([...envAdmins, ...storedAdmins]));
  }

  private getOwnerWallet(): string {
    return (this.room.env.OWNER_WALLET as string) || "";
  }

  private async isWhitelisted(wallet: string): Promise<boolean> {
    const admins = await this.getAllAdminWallets();
    const envMembers = this.getMemberWallets();
    const storedMembers = await this.getStoredMemberWallets();
    return (
      admins.includes(wallet) ||
      envMembers.includes(wallet) ||
      storedMembers.includes(wallet)
    );
  }



  // Token check cache
  tokenCache: Map<string, { ok: boolean; timestamp: number }>;
  readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(readonly room: Room) {
    this.tokenCache = new Map();
  }

  private async verifyTokenHolder(wallet: string): Promise<{ ok: boolean; detail: string }> {
    // 1. Check Cache
    const cached = this.tokenCache.get(wallet);
    if (cached && (Date.now() - cached.timestamp < this.CACHE_TTL_MS)) {
      // console.log(`[CACHE] Hit for ${wallet}: ${cached.ok}`);
      return { ok: cached.ok, detail: "Cached result" };
    }

    // Try multiple RPC endpoints — Helius returns 401 from CF Workers
    // const HELIUS_API_KEY = (this.room.env.HELIUS_API_KEY as string) || "cc4ba0bb-9e76-44be-8681-511665f1c262";
    const endpoints = [
      `https://mainnet.helius-rpc.com/?api-key=cc4ba0bb-9e76-44be-8681-511665f1c262`,
      "https://api.mainnet-beta.solana.com"
    ];

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [
        wallet,
        { mint: TOKEN_MINT },
        { encoding: "jsonParsed" }
      ]
    });

    for (const rpc of endpoints) {
      try {
        // console.log(`[TOKEN CHECK] Trying ${rpc.substring(0, 50)}... Wallet: ${wallet}`);
        const response = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body
        });
        if (!response.ok) {
          // console.warn(`[TOKEN CHECK] ${rpc.substring(0, 50)} returned HTTP ${response.status}`);
          continue; // Try next endpoint
        }
        const data: any = await response.json();
        if (data.error) {
          // console.warn(`[TOKEN CHECK] RPC error from ${rpc.substring(0, 50)}:`, data.error);
          continue;
        }
        // console.log(`[TOKEN CHECK] Response:`, JSON.stringify(data).substring(0, 300));
        if (data.result?.value?.length > 0) {
          for (const account of data.result.value) {
            const amount = account.account.data.parsed.info.tokenAmount.uiAmount;
            if (amount > 0) {
              this.tokenCache.set(wallet, { ok: true, timestamp: Date.now() });
              return { ok: true, detail: `Balance: ${amount}` };
            }
          }
          this.tokenCache.set(wallet, { ok: false, timestamp: Date.now() });
          return { ok: false, detail: `Found ${data.result.value.length} account(s) but all balances are 0` };
        }
        this.tokenCache.set(wallet, { ok: false, timestamp: Date.now() });
        return { ok: false, detail: `No token accounts found for mint ${TOKEN_MINT}` };
      } catch (err: any) {
        console.warn(`[TOKEN CHECK] Exception from ${rpc.substring(0, 50)}:`, err?.message);
        continue;
      }
    }
    return { ok: false, detail: "All RPC endpoints failed" };
  }
  // Track message timestamps for rate limiting
  rateLimits = new Map<string, number[]>();

  // Game State
  gameState: GameState = "IDLE";
  gameStartTime: number = 0;
  dqUsers = new Set<string>();
  gameTimer: unknown | null = null;
  totalRounds: number = 1;
  currentRound: number = 0;
  roundWins = new Map<string, number>(); // username -> wins
  mutedUsers = new Set<string>(); // usernames
  pinnedMessage: string | null = null;



  async onStart() {
    // Initialize pinned message
    const pinned = await this.room.storage.get<string>("pinnedMessage");
    if (pinned) this.pinnedMessage = pinned;

    // Initialize visitor count if not set
    const count = await this.room.storage.get("realVisitorCount");
    if (count === undefined) {
      await this.room.storage.put(
        "realVisitorCount",
        0
      );
    }
  }

  async onConnect(conn: Party.Connection) {
    // Increment visitor count
    let visitorCount =
      ((await this.room.storage.get("realVisitorCount")) as number) || 0;
    visitorCount++;
    await this.room.storage.put("realVisitorCount", visitorCount);

    // Send visitor count & pinned message to the new connection
    conn.send(JSON.stringify({ type: "visitor-count", count: visitorCount }));
    if (this.pinnedMessage) {
      conn.send(JSON.stringify({ type: "pinned-update", text: this.pinnedMessage }));
    }

    // Broadcast updated user list for guest count tracking
    await this.broadcastUserList();
  }

  async onMessage(message: string, sender: Party.Connection) {
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    if (parsed.type === "join") {
      const username = (parsed.username || "")
        .replace(/[<>&"']/g, "")
        .trim()
        .substring(0, 20);
      const wallet = parsed.wallet || null;

      if (!username) return;

      // ═══ SIGNATURE VERIFICATION (warn-only, for audit) ═══
      if (parsed.signature && parsed.signMessage) {
        try {
          const sigBytes = Uint8Array.from(atob(parsed.signature), (c: string) => c.charCodeAt(0));
          const msgBytes = new TextEncoder().encode(parsed.signMessage);
          const pubKeyBytes = base58Decode(wallet);
          const isValid = await verifyEd25519(msgBytes, sigBytes, pubKeyBytes);
          if (!isValid) {
            console.warn(`[SIG] Invalid signature from ${wallet} (${username})`);
          } else {
            // console.log(`[SIG] Verified wallet ${wallet} for ${username}`);
          }
        } catch (err) {
          console.warn("[SIG] Verification error:", err);
        }
      } else {
        // console.warn(`[SIG] No signature provided by ${wallet} (${username})`);
      }

      // Access control: gated rooms use token ownership, others use whitelist
      const isGatedRoom = GATED_ROOMS.includes(this.room.id);

      if (isGatedRoom) {
        // Admin wallets AND whitelisted wallets bypass token gate
        const isWhitelisted = await this.isWhitelisted(wallet || "");

        if (!isWhitelisted) {
          // Token-gated rooms: require holding the token
          if (!wallet) {
            sender.send(JSON.stringify({
              type: "join-error",
              reason: "You must connect a wallet to access this room."
            }));
            return;
          }
          const tokenResult = await this.verifyTokenHolder(wallet);
          if (!tokenResult.ok) {
            // Fallback: trust client-side token check if server RPC is unavailable
            if (parsed.hasToken === true) {
              // console.log(`[GATE] Server RPC failed (${tokenResult.detail}), trusting client hasToken for ${wallet}`);
            } else {
              sender.send(JSON.stringify({
                type: "join-error",
                reason: `Token check failed: ${tokenResult.detail}`
              }));
              return;
            }
          }
        }
      } else {
        // Non-gated rooms: whitelist check
        const whitelisted = await this.isWhitelisted(wallet || "");
        if (!wallet || !whitelisted) {
          sender.send(JSON.stringify({
            type: "join-error",
            reason: "Unauthorized. Your wallet is not on the whitelist."
          }));
          return;
        }
      }

      console.log(`[JOIN] User: ${username}`);

      const color = (parsed.color && /^#[0-9A-F]{6}$/i.test(parsed.color))
        ? parsed.color
        : getRandomColor();
      const allAdmins = await this.getAllAdminWallets();
      const allMods = await this.getStoredModWallets();
      const ownerWallet = this.getOwnerWallet();

      console.log(`[JOIN] Wallet: ${wallet}, Owner: ${ownerWallet}`);

      const isAdmin = allAdmins.includes(wallet);
      const isMod = allMods.includes(wallet);
      const isOwner = wallet === ownerWallet;

      console.log(`[JOIN] Flags -> Admin: ${isAdmin}, Mod: ${isMod}, Owner: ${isOwner}`);

      sender.setState({ username, color, wallet, isAdmin, isMod, isOwner });

      if (isAdmin) {
        sender.send(JSON.stringify({ type: "admin-mode" }));
      }

      // Send chat history to joining user
      const history =
        ((await this.room.storage.get("chatHistory")) as any[]) || [];
      const recent = history.slice(-HISTORY_ON_JOIN);
      sender.send(JSON.stringify({ type: "history", messages: recent }));

      // Broadcast join system message
      const joinMsg = {
        msgType: "system",
        text: `✦ ${username} has entered the chat ✦`,
        timestamp: Date.now(),
      };

      this.room.broadcast(JSON.stringify({ type: "system-message", ...joinMsg }));

      // Persist to history
      history.push(joinMsg);
      await this.room.storage.put(
        "chatHistory",
        history.slice(-MAX_HISTORY)
      );

      // Log wallet if present
      if (wallet) {
        const walletLog = (await this.room.storage.get("walletLog") as Record<string, string>) || {};
        // Store wallet with username
        walletLog[username] = wallet;
        await this.room.storage.put("walletLog", walletLog);
      }

      // Broadcast updated user list
      await this.broadcastUserList();

      // Broadcast visitor count
      const visitorCount = await this.room.storage.get("realVisitorCount");
      this.room.broadcast(
        JSON.stringify({ type: "visitor-count", count: visitorCount })
      );
    }

    // ═══ GAME: START (Admin Only) ═══
    if (parsed.type === "admin-start-game") {
      const state = sender.state as any;
      if (!state?.isAdmin) return;

      // Parse rounds (1, 3, 5, 7)
      const rounds = Math.min(Math.max(parseInt(parsed.rounds) || 1, 1), 7);
      this.totalRounds = rounds;
      this.currentRound = 1;
      this.roundWins.clear();

      // Broadcast series start
      this.room.broadcast(JSON.stringify({
        type: "system-message",
        text: rounds > 1
          ? `⚡ Reaction Game — Best of ${rounds} rounds!`
          : `⚡ Reaction Game — 1 round!`,
        timestamp: Date.now()
      }));

      this.startRound();
    }

    // ═══ GAME: CLICK ═══
    if (parsed.type === "game-click") {
      const state = sender.state as any;
      if (!state?.username) return;

      // False Start
      if (this.gameState === "READY") {
        this.dqUsers.add(sender.id);
        sender.send(JSON.stringify({ type: "game-dq" }));

        // Check if everyone is disqualified
        const activePlayers = [...this.room.getConnections()].filter(c => (c.state as any)?.username);
        if (this.dqUsers.size >= activePlayers.length) {
          // Cancel the round
          if (this.gameTimer) clearTimeout(this.gameTimer as unknown as number);
          this.gameState = "IDLE";
          this.room.broadcast(JSON.stringify({
            type: "system-message",
            text: `💀 Everyone disqualified! Round ${this.currentRound} skipped.`,
            timestamp: Date.now()
          }));
          this.room.broadcast(JSON.stringify({ type: "game-cancel" }));

          // Auto-advance if more rounds remain
          if (this.currentRound < this.totalRounds) {
            this.currentRound++;
            setTimeout(() => this.startRound(), 3000);
          } else {
            this.endSeries();
          }
        }
        return;
      }

      // Valid Click
      if (this.gameState === "GO") {
        if (this.dqUsers.has(sender.id)) return; // Disqualified users ignored

        // WINNER of this round
        const reactionTime = Date.now() - this.gameStartTime;
        this.gameState = "IDLE";

        // Track wins
        const prevWins = this.roundWins.get(state.username) || 0;
        this.roundWins.set(state.username, prevWins + 1);

        const winMsg = {
          type: "game-win",
          username: state.username,
          color: state.color,
          time: reactionTime,
          round: this.currentRound,
          totalRounds: this.totalRounds,
          scores: Object.fromEntries(this.roundWins)
        };
        this.room.broadcast(JSON.stringify(winMsg));

        // Announce in chat
        const sysMsg = {
          msgType: "system",
          text: this.totalRounds > 1
            ? `🏆 Round ${this.currentRound}: ${state.username} in ${reactionTime}ms!`
            : `🏆 ${state.username} won in ${reactionTime}ms!`,
          timestamp: Date.now()
        };
        this.room.broadcast(JSON.stringify({ type: "system-message", ...sysMsg }));

        // Save to history
        const history = ((await this.room.storage.get("chatHistory")) as any[]) || [];
        history.push(sysMsg);
        await this.room.storage.put("chatHistory", history.slice(-MAX_HISTORY));

        // Check if someone won the series (majority)
        const winsNeeded = Math.ceil(this.totalRounds / 2);
        if ((prevWins + 1) >= winsNeeded && this.totalRounds > 1) {
          // Series winner!
          setTimeout(() => this.endSeries(), 3000);
        } else if (this.currentRound < this.totalRounds) {
          // More rounds to go
          this.currentRound++;
          setTimeout(() => this.startRound(), 4000);
        } else {
          // Last round done
          setTimeout(() => this.endSeries(), 3000);
        }
      }
    }

    if (parsed.type === "update-color") {
      const state = sender.state as any;
      if (!state?.username) return;

      const newColor = (parsed.color || "").trim();
      // Basic hex validation
      if (!/^#[0-9A-F]{6}$/i.test(newColor)) return;

      sender.setState({ ...state, color: newColor });

      // Broadcast updated user list so everyone sees the new color
      await this.broadcastUserList();
      return;
    }

    if (parsed.type === "chat") {
      const { username, color, isAdmin, isMod, isOwner } = sender.state as {
        username: string;
        color: string;
        isAdmin: boolean;
        isMod: boolean;
        isOwner: boolean;
      };

      if (!username) return;

      // Handle Admin/Mod/Owner Commands
      if ((isAdmin || isMod || isOwner) && parsed.text.startsWith("/")) {
        const parts = parsed.text.trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const subCommand = parts[1];
        const val = parts.slice(2).join(" ");
        const fullArg = parts.slice(1).join(" ");

        // ADMIN/OWNER: Manage Moderators
        if ((isAdmin || isOwner) && command === "/mod") {
          const storedMods = await this.getStoredModWallets();

          if (subCommand === "add") {
            const target = parts[2] || "";
            const cleanTarget = target.trim();
            if (cleanTarget && !storedMods.includes(cleanTarget)) {
              storedMods.push(cleanTarget);
              await this.room.storage.put("storedModWallets", storedMods);

              let found = false;
              for (const conn of this.room.getConnections()) {
                const state = conn.state as any;
                if (state && state.wallet === cleanTarget) {
                  conn.setState({ ...state, isMod: true });
                  found = true;
                }
              }
              if (found) this.broadcastUserList();

              sender.send(JSON.stringify({ type: "system-message", text: `✅ Added MOD: ${cleanTarget}` }));
            } else {
              sender.send(JSON.stringify({ type: "system-message", text: `⚠️ Invalid or already mod: ${cleanTarget}` }));
            }
          } else if (subCommand === "remove") {
            const target = parts[2] || "";
            const cleanTarget = target.trim();
            const newMods = storedMods.filter(m => m !== cleanTarget);
            await this.room.storage.put("storedModWallets", newMods);

            let found = false;
            for (const conn of this.room.getConnections()) {
              const state = conn.state as any;
              if (state && state.wallet === cleanTarget) {
                conn.setState({ ...state, isMod: false });
                found = true;
              }
            }
            if (found) this.broadcastUserList();

            sender.send(JSON.stringify({ type: "system-message", text: `❌ Removed MOD: ${cleanTarget}` }));
          }
          return;
        }

        // OWNER/ADMIN: Manage Admins
        if ((isAdmin || isOwner) && command === "/admin") {
          const storedAdmins = await this.getStoredAdminWallets();

          if (subCommand === "add") {
            if (!isOwner) {
              sender.send(JSON.stringify({ type: "system-message", text: `⛔ Only the Owner can add admins.` }));
              return;
            }
            const target = parts[2] || "";
            const cleanTarget = target.trim();

            if (cleanTarget && !storedAdmins.includes(cleanTarget)) {
              storedAdmins.push(cleanTarget);
              await this.room.storage.put("storedAdminWallets", storedAdmins);

              let found = false;
              for (const conn of this.room.getConnections()) {
                const state = conn.state as any;
                if (state && state.wallet === cleanTarget) {
                  conn.setState({ ...state, isAdmin: true });
                  conn.send(JSON.stringify({ type: "admin-mode" }));
                  found = true;
                }
              }
              if (found) this.broadcastUserList();

              sender.send(JSON.stringify({ type: "system-message", text: `✅ Added ADMIN: ${cleanTarget}` }));
            } else {
              sender.send(JSON.stringify({ type: "system-message", text: `⚠️ Invalid or already admin: ${cleanTarget}` }));
            }
          } else if (subCommand === "remove") {
            if (!isOwner) {
              sender.send(JSON.stringify({ type: "system-message", text: `⛔ Only the Owner can remove admins.` }));
              return;
            }
            const target = parts[2] || "";
            const cleanTarget = target.trim();
            const newAdmins = storedAdmins.filter(a => a !== cleanTarget);
            await this.room.storage.put("storedAdminWallets", newAdmins);

            // Immediate update
            let found = false;
            for (const conn of this.room.getConnections()) {
              const state = conn.state as any;
              if (state && state.wallet === cleanTarget) {
                conn.setState({ ...state, isAdmin: false });
                // We don't send "admin-mode" false, just remove privileges
                found = true;
              }
            }
            if (found) this.broadcastUserList();

            sender.send(JSON.stringify({ type: "system-message", text: `❌ Removed ADMIN: ${cleanTarget}` }));
          }
          return;
        }

        // WHITELIST / BAN / MUTE / CLEAR (Privileged)
        if (command === "/whitelist" || command === "/aa") {
          let stored = await this.getStoredMemberWallets();

          // 1. /aa <wallet> shortcut
          if (command === "/aa") {
            const target = parts[1] || "";
            const cleanTarget = target.trim();
            if (cleanTarget && !stored.includes(cleanTarget)) {
              stored.push(cleanTarget);
              await this.room.storage.put("storedMemberWallets", stored);
              sender.send(JSON.stringify({ type: "system-message", text: `✅ [AA] Added ${cleanTarget} to whitelist.` }));
            } else if (stored.includes(cleanTarget)) {
              sender.send(JSON.stringify({ type: "system-message", text: `⚠️ ${cleanTarget} is already whitelisted.` }));
            }
            return;
          }

          // 2. /whitelist bulk <csv>
          if (subCommand === "bulk") {
            const addrs = val.split(",").map((a: string) => a.trim()).filter(Boolean);
            let count = 0;
            addrs.forEach((a: string) => {
              if (!stored.includes(a)) {
                stored.push(a);
                count++;
              }
            });
            await this.room.storage.put("storedMemberWallets", stored);
            sender.send(JSON.stringify({ type: "system-message", text: `✅ Bulk added ${count} addresses.` }));
            return;
          }

          // 3. /whitelist remove <wallet>
          if (subCommand === "remove") {
            stored = stored.filter((a: string) => a !== val);
            await this.room.storage.put("storedMemberWallets", stored);
            sender.send(JSON.stringify({ type: "system-message", text: `❌ Removed ${val} from whitelist.` }));
            return;
          }

          // 4. Default: /whitelist <wallet> (or add)
          let target = val;
          // Handle "room 1 <wallet>" pattern or similar
          if (target.toLowerCase().startsWith("room ")) {
            const parts = target.split(" ");
            if (parts.length >= 3) {
              target = parts[parts.length - 1];
            }
          }

          const cleanTarget = target.trim();
          if (cleanTarget && !stored.includes(cleanTarget)) {
            stored.push(cleanTarget);
            await this.room.storage.put("storedMemberWallets", stored);
            sender.send(JSON.stringify({ type: "system-message", text: `✅ Added ${cleanTarget} to whitelist.` }));
          } else if (cleanTarget) {
            sender.send(JSON.stringify({ type: "system-message", text: `⚠️ ${cleanTarget} is already whitelisted.` }));
          }
          return;
        }

        if (command === "/ban") {
          const target = parts[1] || "";
          const cleanTarget = target.trim();
          if (!cleanTarget) return;

          // Remove from whitelist
          let stored = await this.getStoredMemberWallets();
          if (stored.includes(cleanTarget)) {
            stored = stored.filter(w => w !== cleanTarget);
            await this.room.storage.put("storedMemberWallets", stored);
            sender.send(JSON.stringify({ type: "system-message", text: `🔨 Banned (removed from whitelist): ${cleanTarget}` }));

            // Kick if online
            for (const conn of this.room.getConnections()) {
              const state = conn.state as any;
              if (state && state.wallet === cleanTarget) {
                conn.close(1008, "Banned by moderator");
              }
            }
          } else {
            sender.send(JSON.stringify({ type: "system-message", text: `⚠️ ${cleanTarget} is not on the whitelist.` }));
          }
          return;
        }

        if (command === "/mute") {
          const target = parts[1];
          if (this.mutedUsers.has(target)) {
            this.mutedUsers.delete(target);
            sender.send(JSON.stringify({ type: "system-message", text: `🔊 Unmuted ${target}.` }));
          } else {
            this.mutedUsers.add(target);
            sender.send(JSON.stringify({ type: "system-message", text: `🔇 Muted ${target}.` }));
          }
          return;
        }

        if (command === "/clear") {
          await this.room.storage.delete("chatHistory");
          this.room.broadcast(JSON.stringify({ type: "clear-chat" }));
          sender.send(JSON.stringify({ type: "system-message", text: "🧼 Chat history cleared." }));
          return;
        }

        if (command === "/pin") {
          this.pinnedMessage = fullArg;
          await this.room.storage.put("pinnedMessage", fullArg);
          this.room.broadcast(JSON.stringify({ type: "pinned-update", text: fullArg }));
          sender.send(JSON.stringify({ type: "system-message", text: "📌 Message pinned." }));
          return;
        }

        if (command === "/unpin") {
          this.pinnedMessage = null;
          await this.room.storage.delete("pinnedMessage");
          this.room.broadcast(JSON.stringify({ type: "pinned-update", text: null }));
          sender.send(JSON.stringify({ type: "system-message", text: "📍 Message unpinned." }));
          return;
        }
      }

      // Check if muted
      if (this.mutedUsers.has(username)) {
        sender.send(JSON.stringify({ type: "system-message", text: "🤐 You are muted and cannot chat." }));
        return;
      }

      // Rate Limit Check
      const text = (parsed.text || "")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .trim();

      if (!text) return;

      const now = Date.now();
      const timestamps = this.rateLimits.get(sender.id) || [];
      // Filter out timestamps outside the window
      const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);

      if (recent.length >= MAX_MESSAGES_PER_WINDOW) {
        // Rate limit exceeded - send warning only to sender
        sender.send(JSON.stringify({
          type: "system-message",
          text: "You're chatting too fast! 🐢",
          timestamp: now
        }));
        // Update valid timestamps but don't add new one (blocking)
        this.rateLimits.set(sender.id, recent);
        return;
      }

      // Allowed - update timestamps
      recent.push(now);
      this.rateLimits.set(sender.id, recent);

      const msgData = {
        msgType: "chat",
        username,
        color,
        text,
        isAdmin,
        isMod,
        isOwner,
        timestamp: Date.now(),
      };

      // Broadcast to everyone
      console.log("[BROADCAST] msgData:", JSON.stringify(msgData));
      this.room.broadcast(
        JSON.stringify({ type: "chat-message", ...msgData })
      );

      // Persist to history
      const history =
        ((await this.room.storage.get("chatHistory")) as any[]) || [];
      history.push(msgData);
      await this.room.storage.put(
        "chatHistory",
        history.slice(-MAX_HISTORY)
      );

    }

    // Cursor position — relay to everyone else (no persistence)
    if (parsed.type === "cursor") {
      const state = sender.state as any;
      if (!state?.username) return;

      this.room.broadcast(
        JSON.stringify({
          type: "cursor",
          id: sender.id,
          username: state.username,
          color: state.color,
          x: parsed.x,
          y: parsed.y,
        }),
        [sender.id] // exclude sender
      );
    }
  }

  static onBeforeConnect(req: Party.Request) {
    const origin = req.headers.get("Origin") || "";
    // Allow localhost for dev, and any subdomain of frub.bio
    if (origin.includes("localhost") || origin.includes("127.0.0.1") || origin.endsWith("frub.bio")) {
      return req;
    }
    return new Response("Unauthorized Origin", { status: 403 });
  }

  async onRequest(req: Party.Request) {
    if (req.method === "GET") {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/wallets")) {
        // Return persistent log of all wallets that ever connected
        const walletLog = (await this.room.storage.get("walletLog") as Record<string, string>) || {};
        return new Response(JSON.stringify(walletLog, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("Not Found", { status: 404 });
  }

  async onClose(conn: Party.Connection) {
    const state = conn.state as any;
    if (state?.username) {
      // Broadcast leave message
      const leaveMsg = {
        msgType: "system",
        text: `✧ ${state.username} has left the chat ✧`,
        timestamp: Date.now(),
      };
      this.room.broadcast(
        JSON.stringify({ type: "system-message", ...leaveMsg })
      );

      // Persist to history
      const history =
        ((await this.room.storage.get("chatHistory")) as any[]) || [];
      history.push(leaveMsg);
      await this.room.storage.put(
        "chatHistory",
        history.slice(-MAX_HISTORY)
      );

      // Tell others to remove cursor
      this.room.broadcast(
        JSON.stringify({ type: "cursor-gone", id: conn.id })
      );
    }

    // Always broadcast updated user list (active connection count changed)
    await this.broadcastUserList();
  }

  async broadcastUserList() {
    const users: { username: string; color: string; wallet?: string; isAdmin?: boolean }[] = [];
    let totalConnections = 0;
    for (const conn of this.room.getConnections()) {
      totalConnections++;
      const state = conn.state as any;
      if (state?.username) {
        users.push({
          username: state.username,
          color: state.color,
          isAdmin: state.isAdmin,
          isMod: state.isMod,
          isOwner: state.isOwner
          // Wallet is intentionally omitted for privacy
        });
      }
    }
    this.room.broadcast(JSON.stringify({ type: "user-list", users, total: totalConnections }));
  }

  startRound() {
    this.gameState = "READY";
    this.dqUsers.clear();
    this.room.broadcast(JSON.stringify({
      type: "game-ready",
      round: this.currentRound,
      totalRounds: this.totalRounds
    }));

    // Random delay 2000 - 10000 ms
    const delay = Math.floor(Math.random() * 8000) + 2000;

    if (this.gameTimer) clearTimeout(this.gameTimer as unknown as number);
    this.gameTimer = setTimeout(() => {
      this.gameState = "GO";
      this.gameStartTime = Date.now();
      this.room.broadcast(JSON.stringify({ type: "game-go" }));
    }, delay);
  }

  endSeries() {
    // Find overall winner (most wins)
    let bestUser = "";
    let bestWins = 0;
    for (const [user, wins] of this.roundWins) {
      if (wins > bestWins) {
        bestWins = wins;
        bestUser = user;
      }
    }

    if (bestUser && this.totalRounds > 1) {
      this.room.broadcast(JSON.stringify({
        type: "game-series-end",
        winner: bestUser,
        scores: Object.fromEntries(this.roundWins),
        totalRounds: this.totalRounds
      }));
      this.room.broadcast(JSON.stringify({
        type: "system-message",
        text: `👑 ${bestUser} wins the series! (${bestWins}/${this.totalRounds} rounds)`,
        timestamp: Date.now()
      }));
    }

    // Reset
    this.gameState = "IDLE";
    this.totalRounds = 1;
    this.currentRound = 0;
    this.roundWins.clear();
  }
}

NekoChat satisfies Party.Worker;
