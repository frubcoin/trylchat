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

export default class NekoChat implements Party.Server {
  constructor(readonly room: Party.Room) { }

  async onStart() {
    // Initialize visitor count if not set
    const count = await this.room.storage.get("visitorCount");
    if (count === undefined) {
      await this.room.storage.put(
        "visitorCount",
        Math.floor(Math.random() * 9000) + 1000
      );
    }
  }

  async onConnect(conn: Party.Connection) {
    // Increment visitor count
    let visitorCount =
      ((await this.room.storage.get("visitorCount")) as number) || 0;
    visitorCount++;
    await this.room.storage.put("visitorCount", visitorCount);

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
      if (!username) return;

      const color = getRandomColor();
      sender.setState({ username, color });

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

      // Save to history
      history.push(joinMsg);
      await this.room.storage.put(
        "chatHistory",
        history.slice(-MAX_HISTORY)
      );

      // Broadcast updated user list
      await this.broadcastUserList();

      // Broadcast visitor count
      const visitorCount = await this.room.storage.get("visitorCount");
      this.room.broadcast(
        JSON.stringify({ type: "visitor-count", count: visitorCount })
      );
    }

    if (parsed.type === "chat") {
      const state = sender.state as any;
      if (!state?.username) return;

      const text = (parsed.text || "")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .substring(0, 500);
      if (!text.trim()) return;

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

      // Broadcast updated user list
      await this.broadcastUserList();
    }
  }

  async broadcastUserList() {
    const users: { username: string; color: string }[] = [];
    for (const conn of this.room.getConnections()) {
      const state = conn.state as any;
      if (state?.username) {
        users.push({ username: state.username, color: state.color });
      }
    }
    this.room.broadcast(JSON.stringify({ type: "user-list", users }));
  }
}

NekoChat satisfies Party.Worker;
