import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Globe } from '@phosphor-icons/react';
import { login, register } from '../lib/actions';
import { api, errorMessage } from '../lib/api';
import { hasCustomTitleBar, isDesktopApp, isNative } from '../lib/platform';
import { fileUrl, hasServer, normalizeServerUrl, serverBase, setServerBase } from '../lib/server';
import { DEFAULT_LOGO, cachedBrand, rememberBrand } from '../lib/brand';
import type { Instance } from '../types';
import { Button, TextField } from './ui';

export function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'register'>(() => (localStorage.getItem('rc.hasAccount') ? 'login' : 'register'));
  const [instance, setInstance] = useState<Pick<Instance, 'name' | 'logo' | 'signupCodeRequired'> | null>(null);
  const [server, setServer] = useState(serverBase());
  const [editingServer, setEditingServer] = useState(isNative && !hasServer());
  const [form, setForm] = useState({ username: '', password: '', displayName: '', signupCode: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const checkServer = async () => {
    setServerError(null);
    try {
      const info = await api.get<Instance>('/api/instance');
      setInstance(info);
      rememberBrand(info.name, info.logo);
      return true;
    } catch {
      setInstance(null);
      setServerError("Can't reach that server. Check the address and that the server is running.");
      return false;
    }
  };

  useEffect(() => {
    if (hasServer()) void checkServer();
  }, []);

  const saveServer = async () => {
    const url = normalizeServerUrl(server);
    if (!url) return;
    setServerBase(url);
    setServer(url);
    if (await checkServer()) setEditingServer(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await login(form.username.trim(), form.password);
      else
        await register({
          username: form.username.trim().toLowerCase(),
          password: form.password,
          displayName: form.displayName.trim() || undefined,
          signupCode: form.signupCode.trim() || undefined,
        });
      localStorage.setItem('rc.hasAccount', '1');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className={`auth${hasCustomTitleBar ? ' has-titlebar' : ''}`}>
      <div className="auth-bg" aria-hidden>
        <span className="auth-blob auth-blob-1" />
        <span className="auth-blob auth-blob-2" />
        <span className="auth-blob auth-blob-3" />
      </div>
      <motion.div
        className="auth-card"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 26 }}
      >
        <div className="auth-brand">
          <img src={instance ? (instance.logo ? fileUrl(instance.logo) : DEFAULT_LOGO) : cachedBrand().logo} alt="" className="auth-mascot" />
          <span className="auth-wordmark">{instance?.name ?? cachedBrand().name}</span>
        </div>

        {editingServer ? (
          <form
            className="auth-form"
            onSubmit={(e) => {
              e.preventDefault();
              void saveServer();
            }}
          >
            <h1>Connect to a server</h1>
            <p className="auth-sub">Enter the address of your friends' server.</p>
            <TextField
              label="Server address"
              value={server}
              autoFocus
              placeholder="ranch.example.com"
              prefix={<Globe size={16} />}
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => setServer(e.target.value)}
              error={serverError}
            />
            <Button type="submit" size="lg" block disabled={!server.trim()}>
              Continue
            </Button>
          </form>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <h1>{mode === 'login' ? 'Welcome back!' : 'Create an account'}</h1>
            <p className="auth-sub">
              {mode === 'login' ? "We're so excited to see you again!" : `Join ${instance?.name ?? cachedBrand().name} and hang out with your friends.`}
            </p>
            {serverError && <div className="form-error">{serverError}</div>}
            <TextField
              label="Username"
              value={form.username}
              autoFocus
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              required
              onChange={set('username')}
            />
            {mode === 'register' && (
              <TextField label="Display name" value={form.displayName} placeholder="What your friends see (optional)" maxLength={32} onChange={set('displayName')} />
            )}
            <TextField
              label="Password"
              type="password"
              value={form.password}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={mode === 'register' ? 6 : undefined}
              onChange={set('password')}
            />
            {mode === 'register' && instance?.signupCodeRequired && (
              <TextField label="Signup code" value={form.signupCode} hint="Ask whoever runs this server for the code." required onChange={set('signupCode')} />
            )}
            {error && <div className="form-error">{error}</div>}
            <Button type="submit" size="lg" block loading={busy}>
              {mode === 'login' ? 'Log in' : 'Create account'}
            </Button>
            <div className="auth-switch">
              {mode === 'login' ? (
                <>
                  Need an account?{' '}
                  <button type="button" onClick={() => { setMode('register'); setError(null); }}>
                    Register
                  </button>
                </>
              ) : (
                <>
                  Already have an account?{' '}
                  <button type="button" onClick={() => { setMode('login'); setError(null); }}>
                    Log in
                  </button>
                </>
              )}
            </div>
            {(isNative || isDesktopApp) && (
              <button
                type="button"
                className="auth-server"
                onClick={() => (isDesktopApp ? window.ranchDesktop?.changeServer() : setEditingServer(true))}
              >
                <Globe size={14} /> {isNative ? serverBase().replace(/^https?:\/\//, '') : location.host} · change
              </button>
            )}
          </form>
        )}
      </motion.div>
    </div>
  );
}
