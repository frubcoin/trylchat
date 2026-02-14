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
      publicKey as any,
      { name: 'Ed25519' } as any,
      false,
      ['verify']
    );
    return await crypto.subtle.verify('Ed25519' as any, key, signature as any, message as any);
  } catch {
    // Fallback for older CF Workers runtimes
    const key = await crypto.subtle.importKey(
      'raw',
      publicKey as any,
      { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' } as any,
      false,
      ['verify']
    );
    return await crypto.subtle.verify(
      { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' } as any,
      key, signature as any, message as any
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

function getDeterministicPaletteColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % RETRO_COLORS.length;
  return RETRO_COLORS[index];
}

const MAX_HISTORY = 200;
const HISTORY_ON_JOIN = 100;

// Token gating
const TOKEN_MINT = "UwU8RVXB69Y6Dcju6cN2Qef6fykkq6UUNpB15rZku6Z";
const GATED_ROOMS = ["holders-lounge"];

// Rate limit: 5 messages per 10 seconds
const RATE_LIMIT_WINDOW = 10000;
const MAX_MESSAGES_PER_WINDOW = 5;
const AUTH_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const HTTP_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const HTTP_RATE_LIMIT_MAX = 30;
const TRIVIAL_TRANSLATION_MESSAGES = new Set(["ok", "k", "kk", "lol", "lmao", "gg", "gm", "gn", "yes", "no", "np", "ty", "thx"]);

type GameState = "IDLE" | "READY" | "GO";
type TranslationCacheEntry = { translatedText: string; timestamp: number };
type DetectCacheEntry = { language: string; confidence: number; timestamp: number };
type SenderLanguageHint = { language: string; confidence: number; timestamp: number };

export default class NekoChat implements Party.Server {
  authChallenges = new Map<string, { nonce: string; roomId: string; expiresAt: number }[]>();
  httpRateLimits = new Map<string, number[]>();
  translationCache = new Map<string, TranslationCacheEntry>();
  detectCache = new Map<string, DetectCacheEntry>();
  readonly TRANSLATION_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
  readonly DETECT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
  readonly TRANSLATION_CACHE_MAX = 2000;
  readonly DETECT_CACHE_MAX = 2000;
  readonly TRANSLATION_MONTHLY_LIMIT = 500_000;
  readonly TRANSLATION_DAILY_SOFT_LIMIT: number;
  readonly TRANSLATION_MESSAGE_CHAR_CAP = 400;
  readonly TRANSLATION_MIN_MESSAGE_LENGTH = 3;
  readonly TRANSLATION_DETECT_MIN_CONFIDENCE = 0.55;
  readonly SENDER_LANGUAGE_HINT_TTL_MS = 2 * 60 * 1000; // 2 minutes
  monthlyTranslationMonth: string | null = null;
  monthlyTranslationChars = 0;
  dailyTranslationDay: string | null = null;
  dailyTranslationChars = 0;
  senderLanguageHints = new Map<string, SenderLanguageHint>();
  typingEventTimestamps = new Map<string, number>();
  cursorEventTimestamps = new Map<string, number>();
  readonly TYPING_MIN_INTERVAL_MS = 250;
  readonly CURSOR_MIN_INTERVAL_MS = 40;

  private normalizeLanguageCode(value: unknown): string {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return "";
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(raw)) return "";
    return raw;
  }

  private pruneCache<T extends { timestamp: number }>(cache: Map<string, T>, maxEntries: number) {
    if (cache.size <= maxEntries) return;
    const entries = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toDelete = Math.ceil(entries.length / 3);
    for (let i = 0; i < toDelete; i++) {
      cache.delete(entries[i][0]);
    }
  }

  private getCurrentMonthKey(): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }

  private getCurrentDayKey(): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const day = String(now.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private async ensureMonthlyTranslationUsageLoaded() {
    const monthKey = this.getCurrentMonthKey();
    if (this.monthlyTranslationMonth === monthKey) return;
    this.monthlyTranslationMonth = monthKey;
    this.monthlyTranslationChars = ((await this.room.storage.get<number>(`translationUsage:${monthKey}`)) as number) || 0;
  }

  private async ensureDailyTranslationUsageLoaded() {
    const dayKey = this.getCurrentDayKey();
    if (this.dailyTranslationDay === dayKey) return;
    this.dailyTranslationDay = dayKey;
    this.dailyTranslationChars = ((await this.room.storage.get<number>(`translationUsageDaily:${dayKey}`)) as number) || 0;
  }

  private async canSpendTranslationChars(chars: number): Promise<boolean> {
    if (chars <= 0) return true;
    await this.ensureMonthlyTranslationUsageLoaded();
    await this.ensureDailyTranslationUsageLoaded();
    return (this.monthlyTranslationChars + chars) <= this.TRANSLATION_MONTHLY_LIMIT
      && (this.dailyTranslationChars + chars) <= this.TRANSLATION_DAILY_SOFT_LIMIT;
  }

  private async recordTranslationChars(chars: number) {
    if (chars <= 0) return;
    await this.ensureMonthlyTranslationUsageLoaded();
    await this.ensureDailyTranslationUsageLoaded();
    this.monthlyTranslationChars += chars;
    this.dailyTranslationChars += chars;
    const monthKey = this.monthlyTranslationMonth as string;
    const dayKey = this.dailyTranslationDay as string;
    await this.room.storage.put(`translationUsage:${monthKey}`, this.monthlyTranslationChars);
    await this.room.storage.put(`translationUsageDaily:${dayKey}`, this.dailyTranslationChars);
  }

  private normalizeTranslationText(input: string): string {
    return String(input || "").replace(/\s+/g, " ").trim();
  }

  private shouldAttemptTranslation(text: string): boolean {
    if (!text) return false;
    if (text.length < this.TRANSLATION_MIN_MESSAGE_LENGTH) return false;
    const lowered = text.toLowerCase();
    if (TRIVIAL_TRANSLATION_MESSAGES.has(lowered)) return false;

    const withoutUrls = text.replace(/https?:\/\/\S+/gi, "").trim();
    // Skip messages that are mostly emoji/symbols/URLs and have no letters.
    if (!/\p{L}/u.test(withoutUrls)) return false;
    return true;
  }

  private getSenderLanguageHint(senderId: string): SenderLanguageHint | null {
    if (!senderId) return null;
    const cached = this.senderLanguageHints.get(senderId);
    if (!cached) return null;
    if ((Date.now() - cached.timestamp) > this.SENDER_LANGUAGE_HINT_TTL_MS) {
      this.senderLanguageHints.delete(senderId);
      return null;
    }
    return cached;
  }

  private setSenderLanguageHint(senderId: string, language: string, confidence: number) {
    if (!senderId || !language) return;
    this.senderLanguageHints.set(senderId, { language, confidence, timestamp: Date.now() });
  }

  private shouldProcessRealtimeEvent(cache: Map<string, number>, id: string, minIntervalMs: number): boolean {
    const now = Date.now();
    const last = cache.get(id) || 0;
    if ((now - last) < minIntervalMs) return false;
    cache.set(id, now);
    return true;
  }

  private async detectLanguageGoogle(text: string): Promise<{ language: string; confidence: number } | null> {
    const apiKey = String((this.room.env.GOOGLE_TRANSLATE_API_KEY as string) || "").trim();
    if (!apiKey) return null;

    const normalizedText = this.normalizeTranslationText(text);
    const cacheKey = normalizedText;
    const cached = this.detectCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.timestamp) < this.DETECT_CACHE_TTL_MS) {
      return { language: cached.language, confidence: cached.confidence };
    }
    if (!(await this.canSpendTranslationChars(normalizedText.length))) {
      return null;
    }

    try {
      const res = await fetch(`https://translation.googleapis.com/language/translate/v2/detect?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: normalizedText })
      });
      if (!res.ok) return null;
      const data = await res.json() as any;
      const top = data?.data?.detections?.[0]?.[0];
      const lang = String(top?.language || "").toLowerCase();
      const confidence = Number(top?.confidence ?? 0);
      const isReliable = top?.isReliable;
      const normalized = this.normalizeLanguageCode(lang);
      if (!normalized) return null;
      if (Number.isFinite(confidence) && confidence > 0 && confidence < this.TRANSLATION_DETECT_MIN_CONFIDENCE) return null;
      if (isReliable === false) return null;
      await this.recordTranslationChars(normalizedText.length);
      this.detectCache.set(cacheKey, { language: normalized, confidence: Number.isFinite(confidence) ? confidence : 1, timestamp: now });
      this.pruneCache(this.detectCache, this.DETECT_CACHE_MAX);
      return { language: normalized, confidence: Number.isFinite(confidence) ? confidence : 1 };
    } catch {
      return null;
    }
  }

  private async translateGoogle(text: string, targetLanguage: string, sourceLanguage?: string | null): Promise<string | null> {
    const apiKey = String((this.room.env.GOOGLE_TRANSLATE_API_KEY as string) || "").trim();
    if (!apiKey) return null;

    const target = this.normalizeLanguageCode(targetLanguage);
    const source = this.normalizeLanguageCode(sourceLanguage || "");
    if (!target) return null;
    if (source && source === target) return null;

    const normalizedText = this.normalizeTranslationText(text);
    const cacheKey = `${source || "auto"}|${target}|${normalizedText}`;
    const cached = this.translationCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.timestamp) < this.TRANSLATION_CACHE_TTL_MS) {
      return cached.translatedText;
    }

    if (!(await this.canSpendTranslationChars(normalizedText.length))) {
      return null;
    }

    try {
      const body: Record<string, string> = { q: normalizedText, target, format: "text" };
      if (source) body.source = source;
      const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) return null;
      const data = await res.json() as any;
      const translatedText = String(data?.data?.translations?.[0]?.translatedText || "").trim();
      if (!translatedText) return null;
      await this.recordTranslationChars(normalizedText.length);
      this.translationCache.set(cacheKey, { translatedText, timestamp: now });
      this.pruneCache(this.translationCache, this.TRANSLATION_CACHE_MAX);
      return translatedText;
    } catch {
      return null;
    }
  }

  private getReplyColorForIdentity(username: string, wallet?: string | null): string {
    const seed = (wallet || username || "").toLowerCase().trim();
    return getDeterministicPaletteColor(seed || "guest");
  }

  private normalizeWallet(wallet: string): string {
    return (wallet || "").trim();
  }

  private isValidWalletFormat(wallet: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet);
  }

  private buildSignMessage(roomId: string, nonce: string): string {
    return `Sign in to tryl.chat\nRoom: ${roomId}\nNonce: ${nonce}`;
  }

  private issueAuthChallenge(wallet: string): { nonce: string; message: string; expiresAt: number } {
    const normalizedWallet = this.normalizeWallet(wallet);
    const nonce = crypto.randomUUID();
    const expiresAt = Date.now() + AUTH_CHALLENGE_TTL_MS;
    const existing = (this.authChallenges.get(normalizedWallet) || [])
      .filter((c) => Date.now() <= c.expiresAt && c.roomId === this.room.id);
    existing.push({ nonce, roomId: this.room.id, expiresAt });
    // Keep only the newest few challenges to avoid stale buildup.
    this.authChallenges.set(normalizedWallet, existing.slice(-3));
    return {
      nonce,
      message: this.buildSignMessage(this.room.id, nonce),
      expiresAt,
    };
  }

  private validateAuthChallenge(wallet: string, nonce: string, signMessage: string): { ok: boolean; reason?: string } {
    const normalizedWallet = this.normalizeWallet(wallet);
    const pendingList = (this.authChallenges.get(normalizedWallet) || [])
      .filter((c) => c.roomId === this.room.id && Date.now() <= c.expiresAt);
    if (pendingList.length === 0) {
      this.authChallenges.delete(normalizedWallet);
      return { ok: false, reason: "Auth challenge expired. Please sign in again." };
    }
    this.authChallenges.set(normalizedWallet, pendingList);
    const pending = pendingList.find((c) => c.nonce === nonce);
    if (!pending) return { ok: false, reason: "Invalid auth challenge nonce." };
    const expectedMessage = this.buildSignMessage(this.room.id, nonce);
    if (signMessage !== expectedMessage) return { ok: false, reason: "Invalid signed message." };
    return { ok: true };
  }

  private consumeAuthChallenge(wallet: string, nonce: string) {
    const normalizedWallet = this.normalizeWallet(wallet);
    const pendingList = this.authChallenges.get(normalizedWallet) || [];
    const remaining = pendingList.filter((c) => c.nonce !== nonce && Date.now() <= c.expiresAt && c.roomId === this.room.id);
    if (remaining.length > 0) this.authChallenges.set(normalizedWallet, remaining);
    else this.authChallenges.delete(normalizedWallet);
  }

  private static isAllowedOrigin(origin: string): boolean {
    if (!origin) return false;
    try {
      const url = new URL(origin);
      const host = (url.hostname || "").toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;
      if (host === "frub.bio" || host.endsWith(".frub.bio")) return true;
      return false;
    } catch {
      return false;
    }
  }

  private getCorsHeaders(req: Party.Request): Record<string, string> {
    const origin = req.headers.get("Origin") || "";
    if (NekoChat.isAllowedOrigin(origin)) {
      return {
        "Access-Control-Allow-Origin": origin,
        "Vary": "Origin",
      };
    }
    return {};
  }

  private isHttpRateLimited(req: Party.Request): boolean {
    const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown";
    const now = Date.now();
    const history = (this.httpRateLimits.get(ip) || []).filter(t => now - t < HTTP_RATE_LIMIT_WINDOW_MS);
    history.push(now);
    this.httpRateLimits.set(ip, history);
    return history.length > HTTP_RATE_LIMIT_MAX;
  }

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

  private async getStoredUrlPermissionWallets(): Promise<string[]> {
    return (await this.room.storage.get<string[]>("storedUrlPermissionWallets")) || [];
  }

  private hasUrlInText(text: string): boolean {
    return /(https?:\/\/[^\s]+)/i.test(text);
  }

  private async canShareUrl(wallet: string | null | undefined, isAdmin: boolean, isMod: boolean, isOwner: boolean): Promise<boolean> {
    if (!wallet) return false;
    if (isAdmin || isMod || isOwner) return true;
    const allowed = await this.getStoredUrlPermissionWallets();
    return allowed.includes(wallet);
  }

  private async broadcastTypingUsers() {
    const typingUsers: string[] = [];
    for (const conn of this.room.getConnections()) {
      const state = conn.state as any;
      if (state?.username && state?.isTyping) {
        typingUsers.push(state.username);
      }
    }
    console.log("[TYPING] Broadcasting users:", typingUsers);
    this.room.broadcast(JSON.stringify({ type: "typing-users", users: typingUsers }));
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
    const owner = this.getOwnerWallet();
    const admins = await this.getAllAdminWallets();
    const mods = await this.getStoredModWallets();
    const envMembers = this.getMemberWallets();
    const storedMembers = await this.getStoredMemberWallets();
    return (
      wallet === owner ||
      admins.includes(wallet) ||
      mods.includes(wallet) ||
      envMembers.includes(wallet) ||
      storedMembers.includes(wallet)
    );
  }



  // Token check cache
  tokenCache: Map<string, { ok: boolean; timestamp: number; ttlMs: number }>;
  readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  readonly FAIL_CACHE_TTL_MS = 15 * 1000; // 15 seconds for failed checks

  constructor(readonly room: Party.Room) {
    this.tokenCache = new Map();
    const dailyCapRaw = Number((this.room.env.TRANSLATION_DAILY_SOFT_LIMIT as string) || 15000);
    this.TRANSLATION_DAILY_SOFT_LIMIT = Number.isFinite(dailyCapRaw) && dailyCapRaw > 0 ? Math.floor(dailyCapRaw) : 15000;
  }

  private getTokenCheckEndpoints(): string[] {
    const fromEnv = ((this.room.env.SOLANA_RPC_URLS as string) || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const heliusApiKey = (this.room.env.HELIUS_API_KEY as string) || "";
    const helius = heliusApiKey
      ? [`https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`]
      : [];

    const defaults = [
      "https://api.mainnet-beta.solana.com",
      "https://solana.public-rpc.com"
    ];

    return Array.from(new Set([...fromEnv, ...helius, ...defaults]));
  }

  private rpcLabel(rpcUrl: string): string {
    try {
      const u = new URL(rpcUrl);
      return `${u.origin}${u.pathname}`;
    } catch {
      return rpcUrl;
    }
  }

  private proxyLabel(proxyUrl: string): string {
    try {
      const u = new URL(proxyUrl);
      return `${u.origin}${u.pathname}`;
    } catch {
      return proxyUrl;
    }
  }

  private async verifyTokenViaProxy(wallet: string): Promise<{ ok: boolean; detail: string } | null> {
    const proxyUrl = ((this.room.env.TOKEN_CHECK_PROXY_URL as string) || "").trim();
    if (!proxyUrl) return null;
    const proxyDebug = String((this.room.env.PROXY_DEBUG as string) || "").toLowerCase() === "true";

    try {
      const url = new URL(proxyUrl);
      url.searchParams.set("wallet", wallet);
      const proxySecret = ((this.room.env.TOKEN_CHECK_PROXY_SECRET as string) || "").trim();
      const hasSecret = proxySecret.length > 0;
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: proxySecret ? { "x-relay-secret": proxySecret } : {}
      });
      if (!response.ok) {
        if (proxyDebug) {
          let extra = "";
          try {
            const text = await response.text();
            if (text) extra = ` body=${text.substring(0, 220)}`;
          } catch {
            // ignore parse/read failure
          }
          console.warn(`[PROXY] ${this.proxyLabel(proxyUrl)} status=${response.status} hasSecret=${hasSecret}${extra}`);
        }
        return { ok: false, detail: `Relay ${this.proxyLabel(proxyUrl)} returned HTTP ${response.status}` };
      }

      const data: any = await response.json();
      if (proxyDebug) {
        console.log(`[PROXY] ${this.proxyLabel(proxyUrl)} status=200 hasSecret=${hasSecret} ok=${!!data?.ok}`);
      }
      if (typeof data?.ok === "boolean") {
        return { ok: data.ok, detail: String(data?.detail || "Relay response") };
      }
      return { ok: false, detail: "Relay returned malformed response" };
    } catch (err: any) {
      return { ok: false, detail: `Relay request failed: ${err?.message || "unknown error"}` };
    }
  }

  private async verifyTokenHolder(wallet: string): Promise<{ ok: boolean; detail: string }> {
    // 1. Check Cache
    const cached = this.tokenCache.get(wallet);
    if (cached && (Date.now() - cached.timestamp < cached.ttlMs)) {
      // console.log(`[CACHE] Hit for ${wallet}: ${cached.ok}`);
      return { ok: cached.ok, detail: "Cached result" };
    }

    // Try multiple RPC endpoints — Helius returns 401 from CF Workers
    const proxied = await this.verifyTokenViaProxy(wallet);
    if (proxied) {
      this.tokenCache.set(wallet, {
        ok: proxied.ok,
        timestamp: Date.now(),
        ttlMs: proxied.ok ? this.CACHE_TTL_MS : this.FAIL_CACHE_TTL_MS
      });
      return proxied;
    }

    const endpoints = this.getTokenCheckEndpoints();
    const rpcErrors: string[] = [];

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
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort("timeout"), 8000);
        const response = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal
        });
        clearTimeout(timeout);
        if (!response.ok) {
          rpcErrors.push(`${this.rpcLabel(rpc)}: HTTP ${response.status}`);
          continue; // Try next endpoint
        }
        const data: any = await response.json();
        if (data.error) {
          rpcErrors.push(`${this.rpcLabel(rpc)}: RPC ${JSON.stringify(data.error)}`);
          continue;
        }
        // console.log(`[TOKEN CHECK] Response:`, JSON.stringify(data).substring(0, 300));
        if (data.result?.value?.length > 0) {
          for (const account of data.result.value) {
            const amount = account.account.data.parsed.info.tokenAmount.uiAmount;
            if (amount > 0) {
              this.tokenCache.set(wallet, { ok: true, timestamp: Date.now(), ttlMs: this.CACHE_TTL_MS });
              return { ok: true, detail: `Balance: ${amount}` };
            }
          }
          this.tokenCache.set(wallet, { ok: false, timestamp: Date.now(), ttlMs: this.FAIL_CACHE_TTL_MS });
          return { ok: false, detail: `Found ${data.result.value.length} account(s) but all balances are 0` };
        }
        this.tokenCache.set(wallet, { ok: false, timestamp: Date.now(), ttlMs: this.FAIL_CACHE_TTL_MS });
        return { ok: false, detail: `No token accounts found for mint ${TOKEN_MINT}` };
      } catch (err: any) {
        rpcErrors.push(`${this.rpcLabel(rpc)}: ${err?.message || "request failed"}`);
        continue;
      }
    }
    const detail = rpcErrors.length
      ? `All RPC endpoints failed (${rpcErrors.slice(0, 3).join(" | ")})`
      : "All RPC endpoints failed";
    return { ok: false, detail };
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
  lastGameStartTime: number = 0;



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
    // Send current visitor count; increment happens on successful join.
    const visitorCount =
      ((await this.room.storage.get("realVisitorCount")) as number) || 0;

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

      // ═══ SIGNATURE VERIFICATION (Strict Enforcement) ═══
      if (wallet) {
        if (!parsed.signature || !parsed.signMessage || !parsed.authNonce) {
          sender.send(JSON.stringify({
            type: "join-error",
            reason: "Signature and auth challenge are required for wallet login."
          }));
          return;
        }

        const challengeCheck = this.validateAuthChallenge(wallet, String(parsed.authNonce || ""), String(parsed.signMessage || ""));
        if (!challengeCheck.ok) {
          sender.send(JSON.stringify({
            type: "join-error",
            reason: challengeCheck.reason || "Invalid auth challenge."
          }));
          return;
        }

        try {
          const sigBytes = Uint8Array.from(atob(parsed.signature), (c: string) => c.charCodeAt(0));
          const msgBytes = new TextEncoder().encode(parsed.signMessage);
          const pubKeyBytes = base58Decode(wallet);
          const isValid = await verifyEd25519(msgBytes, sigBytes, pubKeyBytes);

          if (!isValid) {
            console.warn(`[SIG] Invalid signature from ${wallet} (${username})`);
            sender.send(JSON.stringify({
              type: "join-error",
              reason: "Invalid wallet signature."
            }));
            return;
          }
          // Single-use challenge token to prevent replay within TTL.
          this.consumeAuthChallenge(wallet, String(parsed.authNonce || ""));
          // console.log(`[SIG] Verified wallet ${wallet} for ${username}`);
        } catch (err) {
          console.warn("[SIG] Verification error:", err);
          sender.send(JSON.stringify({
            type: "join-error",
            reason: "Signature verification failed."
          }));
          return;
        }
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
            sender.send(JSON.stringify({
              type: "join-error",
              reason: `Token check failed: ${tokenResult.detail}`
            }));
            return;
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

      const color = (parsed.color && /^#[0-9A-F]{6}$/i.test(parsed.color))
        ? parsed.color
        : getRandomColor();
      const allAdmins = await this.getAllAdminWallets();
      const allMods = await this.getStoredModWallets();
      const ownerWallet = this.getOwnerWallet();

      const isAdmin = allAdmins.includes(wallet);
      const isMod = allMods.includes(wallet);
      const isOwner = wallet === ownerWallet;

      const canEmbedUrls = await this.canShareUrl(wallet, isAdmin, isMod, isOwner);
      const language = this.normalizeLanguageCode(parsed.language) || "en";
      const translationEnabled = !!parsed.translationEnabled;
      sender.setState({ username, color, wallet, isAdmin, isMod, isOwner, canEmbedUrls, isTyping: false, language, translationEnabled });

      // Generate unique ID for the message
      const messageId = crypto.randomUUID();

      if (isAdmin || isMod || isOwner) {
        sender.send(JSON.stringify({ type: "admin-mode" }));
      }

      const history =
        ((await this.room.storage.get("chatHistory")) as any[]) || [];

      // Update missing IDs in storage if necessary
      let updatedHistory = false;
      const recent = history.slice(-HISTORY_ON_JOIN).map((msg: any) => {
        if (!msg.id) {
          msg.id = crypto.randomUUID();
          updatedHistory = true;
        }
        const safeMsg = { ...msg };
        if (!isAdmin && !isMod && !isOwner) {
          delete safeMsg.wallet;
        }
        return safeMsg;
      });

      if (updatedHistory) {
        await this.room.storage.put("chatHistory", history);
      }

      sender.send(JSON.stringify({ type: "history", messages: recent }));

      // Send identity/role info to the user
      sender.send(JSON.stringify({
        type: "identity",
        username,
        wallet,
        isOwner,
        isAdmin,
        isMod,
        color,
        language,
        translationEnabled
      }));

      // Count only successful authenticated joins.
      const alreadyCounted = !!(sender.state as any)?.visitorCounted;
      if (!alreadyCounted) {
        const visitorCount = (((await this.room.storage.get("realVisitorCount")) as number) || 0) + 1;
        await this.room.storage.put("realVisitorCount", visitorCount);
        sender.send(JSON.stringify({ type: "visitor-count", count: visitorCount }));
        sender.setState({ ...(sender.state as any), visitorCounted: true });
      }

      // ... (rest of join logic) ...

      // Broadcast join system message
      const joinMsg = {
        id: crypto.randomUUID(), // System messages also get IDs
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
      return;
    }

    // ═══ REACTIONS ═══
    if (parsed.type === "reaction") {
      const { messageId, emoji } = parsed;
      const state = sender.state as any;
      if (!state?.username || !messageId || !emoji) return;

      // Update history with reaction
      const history = ((await this.room.storage.get("chatHistory")) as any[]) || [];
      const msgIndex = history.findIndex((m: any) => m.id === messageId);

      if (msgIndex !== -1) {
        const msg = history[msgIndex];
        if (!msg.reactions) msg.reactions = {};

        // Legacy support: if it's an array of strings, convert to objects
        // But for new logic, we just treat it as an array of reaction entries
        // Structure: { wallet: string | null, username: string }

        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

        // Fix legacy data if needed (strings to objects)
        if (msg.reactions[emoji].length > 0 && typeof msg.reactions[emoji][0] === 'string') {
          msg.reactions[emoji] = msg.reactions[emoji].map((u: string) => ({ wallet: null, username: u }));
        }

        const reactionList = msg.reactions[emoji] as { wallet: string | null, username: string }[];

        // Check if user has already reacted
        // If user has wallet, check by wallet. Else by username.
        let existingIndex = -1;
        const currentWallet = state.wallet || null;

        if (currentWallet) {
          existingIndex = reactionList.findIndex(r => r.wallet === currentWallet);
        } else {
          // Guest or legacy match
          existingIndex = reactionList.findIndex(r => r.username === state.username && !r.wallet);
        }

        if (existingIndex === -1) {
          // Add reaction
          reactionList.push({ wallet: currentWallet, username: state.username || "Guest" });
        } else {
          // Remove reaction (toggle)
          reactionList.splice(existingIndex, 1);
        }

        // Cleanup empty emoji keys
        if (reactionList.length === 0) {
          delete msg.reactions[emoji];
        }

        history[msgIndex] = msg;
        await this.room.storage.put("chatHistory", history);

        // Broadcast update
        this.room.broadcast(JSON.stringify({
          type: "reaction-update",
          messageId,
          reactions: msg.reactions
        }));
      }
      return;
    }

    // ═══ GAME: START (Admin Only) ═══
    if (parsed.type === "admin-start-game") {
      const state = sender.state as any;
      if (!state?.isAdmin && !state?.isMod && !state?.isOwner) return;

      // Parse rounds (1, 3, 5, 7)
      const rounds = Math.min(Math.max(parseInt(parsed.rounds) || 1, 1), 7);
      this.totalRounds = rounds;
      this.currentRound = 1;
      this.roundWins.clear();

      // Cooldown to prevent duplicate starts (5 seconds)
      const now = Date.now();
      if (now - this.lastGameStartTime < 5000) return;
      this.lastGameStartTime = now;

      // Broadcast series start
      this.room.broadcast(JSON.stringify({
        type: "system-message",
        id: crypto.randomUUID(),
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

    if (parsed.type === "typing") {
      const state = sender.state as any;
      if (!state?.username) return;
      if (!this.shouldProcessRealtimeEvent(this.typingEventTimestamps, sender.id, this.TYPING_MIN_INTERVAL_MS)) return;
      sender.setState({ ...state, isTyping: !!parsed.isTyping });
      await this.broadcastTypingUsers();
      return;
    }

    if (parsed.type === "set-preferences") {
      const state = sender.state as any;
      if (!state?.username) return;
      const nextLanguage = this.normalizeLanguageCode(parsed.language) || state.language || "en";
      const nextTranslationEnabled = !!parsed.translationEnabled;
      sender.setState({ ...state, language: nextLanguage, translationEnabled: nextTranslationEnabled });
      sender.send(JSON.stringify({
        type: "identity",
        username: state.username,
        wallet: state.wallet,
        isOwner: !!state.isOwner,
        isAdmin: !!state.isAdmin,
        isMod: !!state.isMod,
        color: state.color,
        language: nextLanguage,
        translationEnabled: nextTranslationEnabled
      }));
      return;
    }



    if (parsed.type === "chat") {
      if (typeof parsed.text !== "string") return;
      const { username, color, isAdmin, isMod, isOwner, wallet } = sender.state as {
        wallet?: string;
        username: string;
        color: string;
        isAdmin: boolean;
        isMod: boolean;
        isOwner: boolean;
        language?: string;
        translationEnabled?: boolean;
      };

      if (!username) return;

      const isCommand = parsed.text.startsWith("/");
      const isAdminOrMod = isAdmin || isMod || isOwner;

      if (isCommand) {
        const cmd = parsed.text.trim().split(/\s+/)[0].toLowerCase();
        // Allow non-privileged utility commands for everyone.
        if (cmd === "/help" || cmd === "/translation" || cmd === "/tusage" || isAdminOrMod) {
          await this.handleCommand(parsed.text, sender, { isAdmin, isMod, isOwner, wallet });
          return;
        }
      }

      // Block /clear for normal users
      if (parsed.text.startsWith("/clear")) {
        sender.send(JSON.stringify({ type: "system-message", text: "⛔ You must be a moderator to use /clear." }));
        return;
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

      const canEmbedUrls = await this.canShareUrl(wallet, isAdmin, isMod, isOwner);
      if (this.hasUrlInText(text) && !canEmbedUrls) {
        sender.send(JSON.stringify({
          type: "system-message",
          text: "🔒 URL sharing is limited to Owner/Admin/Mod unless granted with /permission url <wallet>."
        }));
        return;
      }

      const now = Date.now();
      const timestamps = this.rateLimits.get(sender.id) || [];
      // Filter out timestamps outside the window
      const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);

      if (!(isAdmin || isMod || isOwner) && recent.length >= MAX_MESSAGES_PER_WINDOW) {
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

      const history =
        ((await this.room.storage.get("chatHistory")) as any[]) || [];

      let normalizedReply: any = null;
      if (parsed.replyTo && typeof parsed.replyTo === "object") {
        const rawReply = parsed.replyTo as any;
        const requestedId = String(rawReply.id || "").trim();

        const referencedMsg = requestedId
          ? history.find((m: any) => m?.id === requestedId && m?.msgType === "chat")
          : null;

        const baseUsername = (referencedMsg?.username ?? rawReply.username ?? "")
          .replace(/[<>&"']/g, "")
          .trim()
          .substring(0, 20);

        const baseText = (referencedMsg?.text ?? rawReply.text ?? "")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .trim()
          .substring(0, 400);

        if (baseUsername && baseText) {
          let targetWallet: string | null = referencedMsg?.wallet || null;

          if (!targetWallet) {
            for (const conn of this.room.getConnections()) {
              const s = conn.state as any;
              if (s?.username === baseUsername && s?.wallet) {
                targetWallet = s.wallet;
                break;
              }
            }
          }

          if (!targetWallet) {
            const walletLog = (await this.room.storage.get("walletLog") as Record<string, string>) || {};
            targetWallet = walletLog[baseUsername] || null;
          }

          normalizedReply = {
            id: referencedMsg?.id || requestedId || null,
            username: baseUsername,
            text: baseText,
            color: this.getReplyColorForIdentity(baseUsername, targetWallet),
          };
        }
      }

      const msgData = {
        id: crypto.randomUUID(),
        msgType: "chat",
        username,
        color,
        text,
        replyTo: normalizedReply,
        wallet,
        isAdmin,
        isMod,
        isOwner,
        canEmbedUrls,
        timestamp: Date.now(),
      };

      // Create separate object for broadcast (exclude wallet for privacy)
      // Use last 6 chars of wallet as a grouping ID (sufficient collision resistance for this context)
      const senderId = wallet ? wallet.slice(-8) : "anon";

      const broadcastData = {
        ...msgData,
        senderId
      };
      delete (broadcastData as any).wallet;

      // Per-user fanout so translation can be personalized while keeping one source message.
      const connections = [...this.room.getConnections()];
      const targetLanguages = new Set<string>();
      for (const conn of connections) {
        const state = conn.state as any;
        if (!state?.username || !state?.translationEnabled) continue;
        const target = this.normalizeLanguageCode(state.language);
        if (target) targetLanguages.add(target);
      }

      let sourceLanguage: string | null = null;
      const translatedByTarget = new Map<string, string>();
      const translationInput = this.normalizeTranslationText(text).slice(0, this.TRANSLATION_MESSAGE_CHAR_CAP);
      const shouldTranslate = targetLanguages.size > 0 && this.shouldAttemptTranslation(translationInput);

      if (shouldTranslate) {
        const senderHint = this.getSenderLanguageHint(sender.id);
        if (senderHint) {
          sourceLanguage = senderHint.language;
        } else {
          const detected = await this.detectLanguageGoogle(translationInput);
          if (detected) {
            sourceLanguage = detected.language;
            this.setSenderLanguageHint(sender.id, detected.language, detected.confidence);
          }
        }
      }

      if (shouldTranslate && sourceLanguage) {
        targetLanguages.delete(sourceLanguage);
        const targets = [...targetLanguages];
        const results = await Promise.all(
          targets.map(async (target) => ({ target, translated: await this.translateGoogle(translationInput, target, sourceLanguage) }))
        );
        for (const item of results) {
          if (item.translated && item.translated.toLowerCase() !== translationInput.toLowerCase()) {
            translatedByTarget.set(item.target, item.translated);
          }
        }
      }

      for (const conn of connections) {
        const state = conn.state as any;
        const target = this.normalizeLanguageCode(state?.language);
        const personalizedPayload: Record<string, any> = { type: "chat-message", ...broadcastData };
        if (state?.translationEnabled && target) {
          const translated = translatedByTarget.get(target);
          if (translated) {
            personalizedPayload.translatedText = translated;
            personalizedPayload.translatedLanguage = target;
            if (sourceLanguage) personalizedPayload.sourceLanguage = sourceLanguage;
          }
        }
        conn.send(JSON.stringify(personalizedPayload));
      }

      // Send wallet reveal to admins/mods/owners
      if (wallet) {
        const adminPayload = JSON.stringify({
          type: "admin-reveal",
          msgId: msgData.id,
          wallet: wallet
        });
        for (const conn of this.room.getConnections()) {
          const s = conn.state as any;
          if (s && (s.isAdmin || s.isMod || s.isOwner)) {
            conn.send(adminPayload);
          }
        }
      }

      // Persist to history (WITH wallet, AND senderId for consistency)
      // We can add senderId to msgData too if we want it in history
      (msgData as any).senderId = senderId;

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
      if (!this.shouldProcessRealtimeEvent(this.cursorEventTimestamps, sender.id, this.CURSOR_MIN_INTERVAL_MS)) return;
      const x = Number(parsed.x);
      const y = Number(parsed.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;

      this.room.broadcast(
        JSON.stringify({
          type: "cursor",
          id: sender.id,
          username: state.username,
          color: state.color,
          x,
          y,
        }),
        [sender.id] // exclude sender
      );
    }
  }

  static onBeforeConnect(req: Party.Request) {
    const origin = req.headers.get("Origin") || "";
    if (NekoChat.isAllowedOrigin(origin)) {
      return req;
    }
    return new Response("Unauthorized Origin", { status: 403 });
  }

  async onRequest(req: Party.Request) {
    const origin = req.headers.get("Origin") || "";
    if (origin && !NekoChat.isAllowedOrigin(origin)) {
      return new Response("Unauthorized Origin", { status: 403 });
    }

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...this.getCorsHeaders(req),
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    if (req.method === "GET") {
      const url = new URL(req.url);

      if (this.isHttpRateLimited(req)) {
        return new Response("Too Many Requests", { status: 429, headers: this.getCorsHeaders(req) });
      }

      if (url.pathname.endsWith("/auth-challenge")) {
        const wallet = this.normalizeWallet(url.searchParams.get("wallet") || "");
        if (!wallet || !this.isValidWalletFormat(wallet)) {
          return new Response("Invalid wallet", { status: 400, headers: this.getCorsHeaders(req) });
        }
        const challenge = this.issueAuthChallenge(wallet);
        return new Response(JSON.stringify(challenge), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...this.getCorsHeaders(req)
          },
        });
      }

      if (url.pathname.endsWith("/check-token")) {
        const wallet = this.normalizeWallet(url.searchParams.get("wallet") || "");
        if (!wallet || !this.isValidWalletFormat(wallet)) {
          return new Response("Invalid wallet", { status: 400, headers: this.getCorsHeaders(req) });
        }

        const result = await this.verifyTokenHolder(wallet);
        return new Response(JSON.stringify({
          ok: result.ok,
          detail: result.detail
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...this.getCorsHeaders(req)
          },
        });
      }
    }
    return new Response("Not Found", { status: 404 });
  }

  async onClose(conn: Party.Connection) {
    this.typingEventTimestamps.delete(conn.id);
    this.cursorEventTimestamps.delete(conn.id);
    this.senderLanguageHints.delete(conn.id);
    const state = conn.state as any;
    if (state?.username) {
      // Broadcast leave message
      const leaveMsg = {
        id: crypto.randomUUID(),
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

    if ((conn.state as any)?.isTyping) {
      conn.setState({ ...(conn.state as any), isTyping: false });
    }
    await this.broadcastTypingUsers();

    // Always broadcast updated user list (active connection count changed)
    await this.broadcastUserList();
  }

  async broadcastUserList() {
    const users: { username: string; color: string; wallet?: string; isAdmin?: boolean; isMod?: boolean; isOwner?: boolean }[] = [];
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
    // Sort users: Owner > Admin > Mod > User
    users.sort((a, b) => {
      const getScore = (u: any) => {
        if (u.isOwner) return 4;
        if (u.isAdmin) return 3;
        if (u.isMod) return 2;
        return 1;
      };
      return getScore(b) - getScore(a);
    });

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

  async handleCommand(text: string, sender: Party.Connection, ctx: { isAdmin: boolean, isMod: boolean, isOwner: boolean, wallet?: string }) {
    const parts = text.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    const subCommand = parts[1];
    const val = parts.slice(2).join(" ");
    const fullArg = parts.slice(1).join(" ");

    const { isAdmin, isMod, isOwner } = ctx;

    if (command === "/help") {
      const available: { cmd: string, desc: string }[] = [
        { cmd: "/help", desc: "List available commands" },
        { cmd: "/clear", desc: "Clear your local chat history" },
        { cmd: "/translation usage", desc: "Show monthly translation usage (room)" }
      ];

      if (isMod || isAdmin || isOwner) {
        available.push(
          { cmd: "/mute <user>", desc: "Mute/unmute a user" },
          { cmd: "/clear", desc: "Clear global chat (or /clear <n> / /clear <wallet>)" },
          { cmd: "/pin <text>", desc: "Pin a message" },
          { cmd: "/unpin", desc: "Unpin current message" },
          { cmd: "/ra <wallet>", desc: "Remove from whitelist" },
          { cmd: "/aa <wallet>", desc: "Add to whitelist" },
          { cmd: "/permission url <wallet>", desc: "Grant URL sharing permission" }
        );
      }

      if (isAdmin || isOwner) {
        available.push(
          { cmd: "/mod add <wallet>", desc: "Promote to Mod" },
          { cmd: "/mod remove <wallet>", desc: "Demote from Mod" },
          { cmd: "/whitelist bulk <csv>", desc: "Bulk whitelist wallets" }
        );
      }

      if (isOwner) {
        available.push(
          { cmd: "/admin add <wallet>", desc: "Promote to Admin" },
          { cmd: "/admin remove <wallet>", desc: "Demote from Admin" }
        );
      }

      sender.send(JSON.stringify({
        type: "help-list",
        commands: available
      }));
      return;
    }

    if (command === "/translation" || command === "/tusage") {
      if (command === "/translation" && (subCommand || "").toLowerCase() !== "usage") {
        sender.send(JSON.stringify({ type: "system-message", text: "Usage: /translation usage" }));
        return;
      }

      await this.ensureMonthlyTranslationUsageLoaded();
      const month = this.monthlyTranslationMonth || this.getCurrentMonthKey();
      const used = this.monthlyTranslationChars;
      const limit = this.TRANSLATION_MONTHLY_LIMIT;
      const remaining = Math.max(0, limit - used);
      const pct = ((used / limit) * 100).toFixed(1);

      sender.send(JSON.stringify({
        type: "system-message",
        text: `🌐 Translation usage (${month}): ${used.toLocaleString()} / ${limit.toLocaleString()} chars (${pct}%) • Remaining: ${remaining.toLocaleString()}`
      }));
      return;
    }

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
            found = true;
          }
        }
        if (found) this.broadcastUserList();

        sender.send(JSON.stringify({ type: "system-message", text: `❌ Removed ADMIN: ${cleanTarget}` }));
      }
      return;
    }

    if (command === "/permission") {
      if (subCommand !== "url") {
        sender.send(JSON.stringify({ type: "system-message", text: "Usage: /permission url <wallet>" }));
        return;
      }

      const target = (parts[2] || "").trim();
      if (!target) {
        sender.send(JSON.stringify({ type: "system-message", text: "Usage: /permission url <wallet>" }));
        return;
      }

      const storedPermissions = await this.getStoredUrlPermissionWallets();
      if (storedPermissions.includes(target)) {
        sender.send(JSON.stringify({ type: "system-message", text: `⚠️ URL permission already granted: ${target}` }));
        return;
      }

      storedPermissions.push(target);
      await this.room.storage.put("storedUrlPermissionWallets", storedPermissions);

      for (const conn of this.room.getConnections()) {
        const state = conn.state as any;
        if (state && state.wallet === target) {
          conn.setState({ ...state, canEmbedUrls: true });
        }
      }

      sender.send(JSON.stringify({ type: "system-message", text: `✅ URL embed permission granted to ${target}` }));
      return;
    }

    // WHITELIST / BAN / MUTE / CLEAR (Privileged)
    if (command === "/whitelist" || command === "/aa" || command === "/ra") {
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

      // 1b. /ra <wallet> shortcut
      if (command === "/ra") {
        const target = parts[1] || "";
        const cleanTarget = target.trim();
        if (cleanTarget && stored.includes(cleanTarget)) {
          stored = stored.filter(a => a !== cleanTarget);
          await this.room.storage.put("storedMemberWallets", stored);
          sender.send(JSON.stringify({ type: "system-message", text: `❌ [RA] Removed ${cleanTarget} from whitelist.` }));
        } else {
          sender.send(JSON.stringify({ type: "system-message", text: `⚠️ ${cleanTarget} is not in the whitelist.` }));
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
      const arg = parts[1];
      let history = ((await this.room.storage.get("chatHistory")) as any[]) || [];

      // 1. /clear (No args) -> Clear all
      if (!arg) {
        await this.room.storage.delete("chatHistory");
        this.room.broadcast(JSON.stringify({ type: "clear-chat" }));
        sender.send(JSON.stringify({ type: "system-message", text: "🧼 Chat history cleared." }));
        return;
      }

      // 2. /clear <number> -> Clear last N messages
      if (/^\d+$/.test(arg)) {
        const count = parseInt(arg, 10);
        if (count > 0) {
          if (count >= history.length) {
            history = [];
          } else {
            history = history.slice(0, history.length - count);
          }

          await this.room.storage.put("chatHistory", history);

          this.room.broadcast(JSON.stringify({ type: "clear-chat" }));
          const safeHistory = history.map((msg: any) => {
            const safe = { ...msg };
            if (!ctx.isAdmin && !ctx.isMod && !ctx.isOwner) delete safe.wallet;
            return safe;
          });
          this.room.broadcast(JSON.stringify({ type: "history", messages: safeHistory }));

          sender.send(JSON.stringify({ type: "system-message", text: `🧼 Cleared last ${count} messages.` }));
          return;
        }
      }

      // 3. /clear <wallet>
      if (arg.length > 20) {
        const targetWallet = arg;
        const initialCount = history.length;
        history = history.filter((msg: any) => msg.wallet !== targetWallet);

        if (history.length !== initialCount) {
          await this.room.storage.put("chatHistory", history);
          this.room.broadcast(JSON.stringify({ type: "clear-chat" }));

          const safeHistory = history.map((msg: any) => {
            const safe = { ...msg };
            if (!ctx.isAdmin && !ctx.isMod && !ctx.isOwner) delete safe.wallet;
            return safe;
          });
          this.room.broadcast(JSON.stringify({ type: "history", messages: safeHistory }));

          sender.send(JSON.stringify({ type: "system-message", text: `🧼 Cleared messages from ${targetWallet}.` }));
        } else {
          sender.send(JSON.stringify({ type: "system-message", text: `⚠️ No messages found from ${targetWallet}.` }));
        }
        return;
      }

      sender.send(JSON.stringify({ type: "system-message", text: "Usage: /clear, /clear <number>, or /clear <wallet>" }));
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
}

NekoChat satisfies Party.Worker;

