import { useEffect, useState } from 'react';
import { AppShell } from './components/AppShell';
import { AuthScreen } from './components/AuthScreen';
import { IncomingCall } from './components/calls/IncomingCall';
import { ModalHost, Toasts } from './components/ModalHost';
import { ReactionPickerHost } from './components/pickers/ReactionPicker';
import { ProfilePopoverHost } from './components/ProfilePopover';
import { Button, MenuHost, Spinner } from './components/ui';
import { logout, startSession } from './lib/actions';
import { errorMessage, getToken, onUnauthorized } from './lib/api';
import { loadEmojiData } from './lib/emoji';
import { setBadge } from './lib/notify';
import { cachedBrand, useBrandFavicon } from './lib/brand';
import { useData } from './store/data';
import { ui, useUi } from './store/ui';

function Splash({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  return (
    <div className="splash">
      <img src={cachedBrand().logo} alt="" className="splash-mascot" />
      {error ? (
        <>
          <p className="splash-error">{error}</p>
          <div className="ui-row">
            <Button onClick={onRetry}>Try again</Button>
            <Button variant="ghost" onClick={() => void logout(true)}>
              Log out
            </Button>
          </div>
        </>
      ) : (
        <Spinner size={22} />
      )}
    </div>
  );
}

export function App() {
  const ready = useData((s) => s.ready);
  const [token, setTokenState] = useState(getToken());
  useBrandFavicon();
  const [bootError, setBootError] = useState<string | null>(null);

  // keep in sync with login/logout
  useEffect(() => {
    const unsub = useData.subscribe((s, prev) => {
      if (s.ready !== prev.ready) setTokenState(getToken());
    });
    onUnauthorized(() => void logout(true));
    return unsub;
  }, []);

  useEffect(() => {
    if (!token || ready) return;
    setBootError(null);
    startSession().catch((err) => setBootError(errorMessage(err)));
  }, [token, ready]);

  // Warm up the emoji data so :shortcodes: and the picker are instant.
  useEffect(() => {
    if (!ready) return;
    const idle = (window as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (idle) idle(() => void loadEmojiData());
    else setTimeout(() => void loadEmojiData(), 1500);
  }, [ready]);

  // Unread badge on the taskbar / tab title / app icon.
  useEffect(() => {
    return useData.subscribe((s) => {
      let n = 0;
      for (const r of Object.values(s.readStates)) n += r.mentionCount;
      n += Object.values(s.relationships).filter((r) => r.type === 3).length;
      setBadge(n);
    });
  }, []);

  // Opened from an invite link like https://server/invite/abc123
  useEffect(() => {
    if (!ready) return;
    const m = /^\/invite\/([A-Za-z0-9]{6,16})/.exec(location.pathname);
    if (m) {
      history.replaceState(null, '', '/' + location.hash);
      ui.openModal('addGroup', { initialCode: m[1] });
    }
  }, [ready]);

  // Ctrl+K quick switcher
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && useData.getState().ready) {
        e.preventDefault();
        const top = useUi.getState().modals.at(-1);
        if (top?.type === 'switcher') ui.closeModal(top.id);
        else ui.openModal('switcher');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!getToken()) {
    return (
      <>
        <AuthScreen />
        <Toasts />
      </>
    );
  }
  if (!ready) return <Splash error={bootError} onRetry={() => { setBootError(null); startSession().catch((err) => setBootError(errorMessage(err))); }} />;

  return (
    <>
      <AppShell />
      <ModalHost />
      <MenuHost />
      <ProfilePopoverHost />
      <ReactionPickerHost />
      <IncomingCall />
      <Toasts />
    </>
  );
}
