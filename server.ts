import type * as Party from "partykit/server";

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

  private isWhitelisted(wallet: string): boolean {
    const admins = this.getAdminWallets();
    const members = this.getMemberWallets();
    return admins.includes(wallet) || members.includes(wallet);
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

  constructor(readonly room: Party.Room) { }

  async onStart() {
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

    // Send visitor count to the new connection
    conn.send(JSON.stringify({ type: "visitor-count", count: visitorCount }));
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

      // Whitelist Check
      if (!wallet || !this.isWhitelisted(wallet)) {
        sender.send(JSON.stringify({
          type: "join-error",
          reason: "Unauthorized. Your wallet is not on the whitelist."
        }));
        return;
      }

      console.log(`[JOIN] User: ${username}`);

      const color = getRandomColor();
      const isAdmin = this.getAdminWallets().includes(wallet);
      sender.setState({ username, color, wallet, isAdmin });

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
      const state = sender.state as any;
      if (!state?.username) return;

      const text = (parsed.text || "")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .substring(0, 500);
      if (!text.trim()) return;

      // Rate Limit Check
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
        username: state.username,
        color: state.color,
        text,
        timestamp: Date.now(),
      };

      // Broadcast to everyone
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
    const users: { username: string; color: string; wallet?: string }[] = [];
    let totalConnections = 0;
    for (const conn of this.room.getConnections()) {
      totalConnections++;
      const state = conn.state as any;
      if (state?.username) {
        users.push({
          username: state.username,
          color: state.color
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
