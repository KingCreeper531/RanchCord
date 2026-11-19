import { Capacitor } from '@capacitor/core';

export interface ScreenShareChoice {
  resolution: '720' | '1080' | 'source';
  fps: 15 | 30 | 60;
  audio: boolean;
}

/** API the Windows app adds to the page (see desktop/src-tauri/src/bridge.js). */
export interface DesktopBridge {
  platform: string;
  version: string;
  /** 'tauri' for the Rust app; missing on the older Electron app. */
  shell?: 'tauri' | 'electron';
  /** False when Windows draws the title bar itself. */
  customTitleBar?: boolean;
  /** False when the web view shows its own screen picker, so we ask for quality first. */
  nativeScreenPicker?: boolean;
  getServerUrl(): Promise<string | null>;
  changeServer(): void;
  setBadge(count: number): void;
  flash(): void;
  setTitleBarColors(background: string, symbols: string): void;
  /** Your own app name and icon (PNG bytes, or null for the usual one) on the title bar, taskbar and tray. Newer apps only. */
  setBrand?(name: string, icon: Uint8Array | null): void;
  lastScreenShareChoice(): Promise<ScreenShareChoice | null>;
  setOpenAtLogin?(enabled: boolean): void;
  getOpenAtLogin?(): Promise<boolean>;
}

declare global {
  interface Window {
    ranchDesktop?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | undefined = typeof window !== 'undefined' ? window.ranchDesktop : undefined;
export const isDesktopApp = Boolean(desktop);
/** The app draws its own title bar (older Electron app). */
export const hasCustomTitleBar = Boolean(desktop) && desktop?.customTitleBar !== false;
export const isNative = Capacitor.isNativePlatform();
export const nativePlatform = Capacitor.getPlatform() as 'android' | 'ios' | 'web';
export const isAndroid = nativePlatform === 'android' || /Android/i.test(navigator.userAgent);
export const isIOS =
  nativePlatform === 'ios' ||
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isMobileDevice = isNative || isAndroid || isIOS;
export const isStandalonePwa =
  !isNative && !isDesktopApp && (matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true);

/** Phones can watch screen shares but can't capture their own screen from a web view. */
export const canShareScreen = Boolean(navigator.mediaDevices?.getDisplayMedia) && !isMobileDevice;

export const modKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
