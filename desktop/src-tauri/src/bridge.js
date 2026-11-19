// Runs before every page in the RanchCord window (the launcher and your server's app).
// It gives the web app `window.ranchDesktop` and routes notifications to Windows.
(() => {
  if (window.ranchDesktop) return;
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const quiet = (p) => p.catch(() => {});

  window.ranchDesktop = {
    platform: 'windows',
    shell: 'tauri',
    version: '__VERSION__',
    /** The server this build connects to when none has been picked yet. */
    defaultServer: '__DEFAULT_SERVER__' || null,
    // Windows draws the title bar and WebView2 shows its own "choose what to share" picker.
    customTitleBar: false,
    nativeScreenPicker: false,
    getServerUrl: () => invoke('get_server'),
    connect: (url) => invoke('connect', { input: String(url ?? '') }),
    checkServer: (url) => invoke('check_server', { url: String(url ?? '') }),
    changeServer: () => quiet(invoke('change_server')),
    setBadge: (count) => quiet(invoke('set_badge', { count: Math.max(0, Math.floor(Number(count) || 0)) })),
    flash: () => quiet(invoke('flash')),
    setTitleBarColors: (background, text) => quiet(invoke('set_title_bar_colors', { background: String(background), text: String(text) })),
    lastScreenShareChoice: async () => null,
    setOpenAtLogin: (enabled) => quiet(invoke('set_open_at_login', { enabled: Boolean(enabled) })),
    getOpenAtLogin: () => invoke('get_open_at_login').catch(() => false),
  };

  // Web notifications become real Windows notifications; clicking one opens the right chat.
  const live = new Map();
  class RanchNotification extends EventTarget {
    static get permission() {
      return 'granted';
    }
    static requestPermission(callback) {
      callback?.('granted');
      return Promise.resolve('granted');
    }
    constructor(title, options = {}) {
      super();
      this.title = String(title ?? '');
      this.body = String(options.body ?? '');
      this.tag = String(options.tag ?? '');
      this.data = options.data ?? null;
      this.onclick = null;
      this.onclose = null;
      this.onerror = null;
      this.onshow = null;
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      live.set(id, this);
      if (live.size > 100) live.delete(live.keys().next().value);
      quiet(invoke('notify', { id, title: this.title, body: this.body }));
    }
    close() {}
  }
  window.__ranchNotificationClick = (id) => {
    const n = live.get(id);
    if (!n) return;
    const event = new Event('click');
    n.dispatchEvent(event);
    if (typeof n.onclick === 'function') n.onclick.call(n, event);
  };
  try {
    Object.defineProperty(window, 'Notification', { value: RanchNotification, configurable: true, writable: true });
  } catch {
    /* keep WebView2's own */
  }
})();
