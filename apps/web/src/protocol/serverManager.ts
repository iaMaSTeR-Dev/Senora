// serverManager.ts
// Multi-Server Architecture, Strict Endpoint Validation & Discovery for SENORA

export interface ServerCapabilities {
  auth_methods: string[];
  encryption_modes: string[];
  calling: string[];
  max_upload_bytes: number;
  push_notifications: string[];
  features: string[];
}

export interface ServerDiscovery {
  server_id: string;
  name: string;
  version: string;
  api_version: string;
  protocol_version: string;
  health: string;
  maintenance: boolean;
  capabilities: ServerCapabilities;
}

export interface SavedServer {
  id: string;
  name: string;
  url: string; // Normalized HTTP/HTTPS origin, e.g. "https://chat.example.com"
  wsUrl: string; // Normalized WS/WSS URL, e.g. "wss://chat.example.com/api/v1/ws"
  isDefault?: boolean;
  lastConnectedAt?: number;
  status?: 'online' | 'offline' | 'unreachable' | 'incompatible';
  latencyMs?: number;
  capabilities?: ServerCapabilities;
  error?: string;
}

export interface ValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  normalizedWsUrl?: string;
  error?: string;
}

const STORAGE_SERVERS_KEY = 'senora_saved_servers';
const STORAGE_ACTIVE_SERVER_KEY = 'senora_active_server_id';

/**
 * Validates a server URL according to strict multi-server security rules.
 */
export function validateServerUrl(inputUrl: string): ValidationResult {
  if (!inputUrl || typeof inputUrl !== 'string') {
    return { valid: false, error: 'Server URL cannot be empty' };
  }

  const trimmed = inputUrl.trim();

  // Reject unsupported schemes early
  if (/^(ftp|javascript|data|file|blob|ws|wss):/i.test(trimmed)) {
    return { valid: false, error: 'Unsupported URL scheme. Only HTTP and HTTPS are permitted.' };
  }

  // Ensure scheme is present; if not, reject rather than guessing silently
  if (!/^https?:\/\//i.test(trimmed)) {
    return { valid: false, error: 'URL must start with http:// or https://' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Malformed server URL format' };
  }

  // Reject embedded credentials (e.g. https://user:pass@example.com)
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Embedded credentials in server URL are strictly forbidden' };
  }

  // Reject query parameters or hash in server origin
  if (parsed.search || parsed.hash) {
    return { valid: false, error: 'Server origin cannot contain query parameters or fragments' };
  }

  const isLocal =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]' ||
    parsed.hostname.endsWith('.local');

  // Enforce HTTPS for public remote servers
  if (parsed.protocol === 'http:' && !isLocal) {
    // In production or public domains, require HTTPS
    const isDevEnv =
      typeof window !== 'undefined' &&
      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    if (!isDevEnv) {
      return { valid: false, error: 'HTTPS is required for remote self-hosted servers' };
    }
  }

  // Normalize origin
  const port = parsed.port ? `:${parsed.port}` : '';
  const normalizedUrl = `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}`;

  // Derive WebSocket URL
  const wsScheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  const normalizedWsUrl = `${wsScheme}//${parsed.hostname.toLowerCase()}${port}/api/v1/ws`;

  return {
    valid: true,
    normalizedUrl,
    normalizedWsUrl,
  };
}

class ServerManager {
  private activeServer: SavedServer | null = null;
  private listeners: Set<(server: SavedServer) => void> = new Set();

  constructor() {
    this.initDefaultServer();
  }

  private getDefaultOrigin(): string {
    if (typeof window !== 'undefined' && window.location && window.location.origin) {
      if (window.location.origin.startsWith('http')) {
        return window.location.origin;
      }
    }
    return 'http://localhost:8080';
  }

  private initDefaultServer() {
    const servers = this.getSavedServers();
    const activeId =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(STORAGE_ACTIVE_SERVER_KEY)
        : null;

    if (activeId) {
      const match = servers.find((s) => s.id === activeId);
      if (match) {
        this.activeServer = match;
        return;
      }
    }

    if (servers.length > 0) {
      this.activeServer = servers[0];
      return;
    }

    // Initialize with default server
    const defaultOrigin = this.getDefaultOrigin();
    const val = validateServerUrl(defaultOrigin);
    const def: SavedServer = {
      id: 'default',
      name: 'SENORA Official',
      url: val.normalizedUrl || defaultOrigin,
      wsUrl: val.normalizedWsUrl || `${defaultOrigin.replace('http', 'ws')}/api/v1/ws`,
      isDefault: true,
      status: 'online',
    };

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_SERVERS_KEY, JSON.stringify([def]));
      localStorage.setItem(STORAGE_ACTIVE_SERVER_KEY, def.id);
    }
    this.activeServer = def;
  }

  getSavedServers(): SavedServer[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(STORAGE_SERVERS_KEY);
      if (!raw) return [];
      const servers = JSON.parse(raw) as SavedServer[];
      for (const server of servers) {
        if (server.isDefault && server.name === 'Senora Official') {
          server.name = 'SENORA Official';
        }
      }
      return servers;
    } catch {
      return [];
    }
  }

  getActiveServer(): SavedServer {
    if (!this.activeServer) {
      this.initDefaultServer();
    }
    return (
      this.activeServer || {
        id: 'default',
        name: 'SENORA Official',
        url: this.getDefaultOrigin(),
        wsUrl: `${this.getDefaultOrigin().replace('http', 'ws')}/api/v1/ws`,
      }
    );
  }

  async testConnection(
    rawUrl: string
  ): Promise<{ success: boolean; latencyMs: number; discovery?: ServerDiscovery; error?: string }> {
    const validation = validateServerUrl(rawUrl);
    if (!validation.valid || !validation.normalizedUrl) {
      return { success: false, latencyMs: 0, error: validation.error || 'Invalid URL' };
    }

    const start = performance.now();
    try {
      // 1. Try discovery endpoint
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(`${validation.normalizedUrl}/api/v1/discovery`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timeoutId);
      const latencyMs = Math.round(performance.now() - start);

      if (res.ok) {
        const data = (await res.json()) as ServerDiscovery;
        return {
          success: true,
          latencyMs,
          discovery: data,
        };
      }

      // 2. Fallback to health endpoint for legacy/simple setups
      const healthRes = await fetch(`${validation.normalizedUrl}/api/v1/health`, {
        headers: { Accept: 'application/json' },
      });
      if (healthRes.ok) {
        return {
          success: true,
          latencyMs,
          discovery: {
            server_id: 'legacy',
            name: 'SENORA Server',
            version: '1.0.0',
            api_version: 'v1',
            protocol_version: '1.0.0',
            health: 'healthy',
            maintenance: false,
            capabilities: {
              auth_methods: ['password'],
              encryption_modes: ['standard'],
              calling: ['webrtc_p2p'],
              max_upload_bytes: 52428800,
              push_notifications: [],
              features: ['groups'],
            },
          },
        };
      }

      return {
        success: false,
        latencyMs,
        error: `Server returned HTTP ${res.status}: ${res.statusText}`,
      };
    } catch (e: any) {
      const latencyMs = Math.round(performance.now() - start);
      let errMsg = e?.message || 'Connection failed';
      if (e?.name === 'AbortError') {
        errMsg = 'Connection timed out (8s)';
      }
      return { success: false, latencyMs, error: errMsg };
    }
  }

  async addServer(rawUrl: string, customName?: string): Promise<SavedServer> {
    const val = validateServerUrl(rawUrl);
    if (!val.valid || !val.normalizedUrl || !val.normalizedWsUrl) {
      throw new Error(val.error || 'Invalid server URL');
    }

    const test = await this.testConnection(val.normalizedUrl);
    const servers = this.getSavedServers();

    // Check duplicate
    const existing = servers.find((s) => s.url === val.normalizedUrl);
    if (existing) {
      return existing;
    }

    const serverName =
      customName?.trim() ||
      test.discovery?.name ||
      new URL(val.normalizedUrl).hostname;

    const newServer: SavedServer = {
      id: `srv_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name: serverName,
      url: val.normalizedUrl,
      wsUrl: val.normalizedWsUrl,
      lastConnectedAt: Date.now(),
      status: test.success ? 'online' : 'unreachable',
      latencyMs: test.latencyMs,
      capabilities: test.discovery?.capabilities,
      error: test.error,
    };

    servers.push(newServer);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_SERVERS_KEY, JSON.stringify(servers));
    }

    return newServer;
  }

  updateServer(id: string, updates: Partial<SavedServer>): void {
    const servers = this.getSavedServers();
    const idx = servers.findIndex((s) => s.id === id);
    if (idx !== -1) {
      servers[idx] = { ...servers[idx], ...updates };
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_SERVERS_KEY, JSON.stringify(servers));
      }
      if (this.activeServer?.id === id) {
        this.activeServer = servers[idx];
        this.notifyListeners(this.activeServer);
      }
    }
  }

  removeServer(id: string): void {
    const servers = this.getSavedServers();
    const filtered = servers.filter((s) => s.id !== id);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_SERVERS_KEY, JSON.stringify(filtered));
    }

    if (this.activeServer?.id === id) {
      const next = filtered[0] || null;
      if (next) {
        this.setActiveServer(next.id);
      } else {
        this.initDefaultServer();
      }
    }
  }

  setActiveServer(id: string): SavedServer {
    const servers = this.getSavedServers();
    const target = servers.find((s) => s.id === id);
    if (!target) {
      throw new Error(`Server with ID ${id} not found`);
    }

    this.activeServer = target;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_ACTIVE_SERVER_KEY, target.id);
    }
    this.notifyListeners(target);
    return target;
  }

  onServerChange(listener: (server: SavedServer) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(server: SavedServer) {
    for (const listener of this.listeners) {
      try {
        listener(server);
      } catch (e) {
        console.error('[ServerManager] Listener error:', e);
      }
    }
  }
}

export const serverManager = new ServerManager();
