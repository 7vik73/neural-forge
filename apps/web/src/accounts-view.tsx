'use client';
import { useEffect, useState } from 'react';
import { api, post, openWorkspace, type Account, type Workspace } from './lib';
import { ErrorMessage, Icon, Modal, Loading } from './ui';

export function AuthView({
  initialized = true,
  onReady,
}: {
  initialized?: boolean;
  onReady: () => void;
}) {
  const [mode, setMode] = useState<'login' | 'register' | 'reset'>('login');
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [token, setToken] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    setMode(
      hash.has('reset')
        ? 'reset'
        : window.location.pathname === '/signup' ||
            hash.has('setup') ||
            hash.has('invite') ||
            !initialized
          ? 'register'
          : 'login',
    );
    if (hash.has('reset')) setToken(hash.get('reset')!);
    if (window.location.hash) window.history.replaceState({}, '', window.location.pathname);
  }, [initialized]);
  async function submit() {
    setBusy(true);
    setError('');
    try {
      await post(
        `auth/${mode}`,
        mode === 'reset'
          ? { token, password }
          : {
              username,
              password,
              ...(mode === 'register'
                ? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
                : {}),
            },
      );
      setPassword('');
      if (mode === 'reset') {
        setMode('login');
        setNotice('Password changed. Sign in with your new password.');
      } else onReady();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="setup-page">
      <div className="setup-brand">
        <span className="brand-symbol">
          <Icon name="Workflow" size={25} />
        </span>
        neuralforge
      </div>
      <section className="setup-card">
        <span className="pill">YOUR WORKFLOW STUDIO</span>
        <h1>
          {mode === 'register'
            ? 'Create your account.'
            : mode === 'reset'
              ? 'Reset your password.'
              : 'Welcome back.'}
        </h1>
        <p>
          {mode === 'register'
            ? 'Organize your workflows in private or shared workspaces.'
            : 'Sign in to your account and choose a workspace.'}
        </p>
        {notice && <p className="success-message">{notice}</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {mode !== 'reset' && (
            <label>
              Username
              <input
                autoFocus
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                placeholder="Your username"
              />
            </label>
          )}
          <label>
            Password
            <input
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'login' ? 1 : 12}
              maxLength={200}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder={mode === 'login' ? 'Your password' : 'At least 12 characters'}
            />
          </label>
          <ErrorMessage message={error} />
          <button className="button primary" disabled={busy}>
            {busy
              ? 'Please wait…'
              : mode === 'register'
                ? 'Create account'
                : mode === 'reset'
                  ? 'Change password'
                  : 'Sign in'}
          </button>
        </form>
        <p className="auth-switch">
          {mode === 'register' ? (
            <>
              Already have an account? <a href="/login">Sign in</a>
            </>
          ) : (
            <>
              New here? <a href="/signup">Create account</a>
            </>
          )}
        </p>
        {mode === 'login' && (
          <small>
            Forgot your password? Ask your installation administrator for a recovery link.
          </small>
        )}
      </section>
    </div>
  );
}

export function WorkspaceManager({
  current,
  onClose,
  onChanged,
}: {
  current?: Workspace;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]),
    [trash, setTrash] = useState<Workspace[]>([]);
  const [name, setName] = useState(''),
    [search, setSearch] = useState(''),
    [error, setError] = useState('');
  const [editing, setEditing] = useState(''),
    [rename, setRename] = useState('');
  const [sharing, setSharing] = useState<Workspace>();
  const [confirm, setConfirm] = useState<Workspace>(),
    [password, setPassword] = useState('');
  async function load() {
    const [active, deleted] = await Promise.all([
      api<Workspace[]>('workspaces'),
      api<Workspace[]>('workspaces?trash=true'),
    ]);
    setWorkspaces(active);
    setTrash(deleted);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function perform(work: () => Promise<any>) {
    try {
      setError('');
      await work();
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal
      title="Your workspaces"
      subtitle="Organize projects privately or collaborate with selected accounts."
      onClose={onClose}
      wide
    >
      <div className="workspace-manager">
        <ErrorMessage message={error} />
        <label>
          Search workspaces
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find a workspace"
          />
        </label>
        <div className="account-list">
          {workspaces
            .filter((w) => w.name.toLowerCase().includes(search.toLowerCase()))
            .map((w) => (
              <div className="account-row" key={w.id}>
                <button
                  className="text-button"
                  aria-label={`Open ${w.name}`}
                  onClick={() => void openWorkspace(w.id).catch((e) => setError(e.message))}
                >
                  <Icon name="FolderOpen" size={17} />
                  {w.name}
                  {current?.id === w.id && <small>Current</small>}
                  <small>
                    {w.role !== 'owner'
                      ? `Shared with me · ${w.role}`
                      : w.shared
                        ? 'Shared workspace'
                        : 'Private workspace'}
                  </small>
                </button>
                {w.role === 'owner' && (
                  <div className="button-group">
                    <button className="text-button" onClick={() => setSharing(w)}>
                      Share
                    </button>
                    <button
                      className="text-button"
                      onClick={() => {
                        setEditing(w.id);
                        setRename(w.name);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="text-button danger"
                      aria-label={`Trash ${w.name}`}
                      onClick={() => {
                        setConfirm(w);
                        setPassword('');
                      }}
                    >
                      Move to trash
                    </button>
                  </div>
                )}
                {editing === w.id && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void perform(async () => {
                        await api(`workspaces/${w.id}`, {
                          method: 'PATCH',
                          body: { name: rename },
                        });
                        setEditing('');
                      });
                    }}
                  >
                    <label>
                      New workspace name
                      <input
                        value={rename}
                        onChange={(e) => setRename(e.target.value)}
                        required
                        maxLength={80}
                      />
                    </label>
                    <button className="button secondary">Save name</button>
                  </form>
                )}
              </div>
            ))}
        </div>
        <form
          className="workspace-create"
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () => {
              const result = await post<Workspace>('workspaces', { name });
              setName('');
              await openWorkspace(result.id);
            });
          }}
        >
          <label>
            New workspace name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
              placeholder="e.g. Personal projects"
            />
          </label>
          <button className="button primary">
            <Icon name="Plus" size={16} />
            Create workspace
          </button>
        </form>
        <h3>Workspace trash</h3>
        <p className="muted">
          Recoverable for 30 days. Restored workflows stay disabled until you enable them.
        </p>
        {!trash.length && <p className="muted">Your workspace trash is empty.</p>}
        {trash.map((w) => (
          <div className="account-row" key={w.id}>
            <span>
              {w.name}
              <small> Deleted {new Date(w.deletedAt!).toLocaleDateString()}</small>
            </span>
            <div className="button-group">
              <button
                className="button secondary"
                aria-label={`Restore ${w.name}`}
                onClick={() => void perform(() => post(`workspaces/${w.id}/restore`))}
              >
                Restore
              </button>
              <button
                className="text-button danger"
                onClick={() => {
                  setConfirm(w);
                  setPassword('');
                }}
              >
                Delete permanently
              </button>
            </div>
          </div>
        ))}
        {confirm && (
          <div className="restore-confirm">
            <h3>
              {confirm.deletedAt ? 'Permanently delete' : 'Move to trash'} “{confirm.name}”?
            </h3>
            <p>
              {confirm.deletedAt
                ? 'This removes its data, connections and managed files permanently.'
                : 'Its automations stop. You can restore this workspace for 30 days.'}
            </p>
            {confirm.deletedAt && (
              <label>
                Confirm your password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            )}
            <div className="button-group">
              <button className="button secondary" onClick={() => setConfirm(undefined)}>
                Cancel
              </button>
              <button
                className="button primary"
                onClick={() =>
                  void perform(async () => {
                    if (confirm.deletedAt)
                      await post(`workspaces/${confirm.id}/purge`, { password });
                    else await api(`workspaces/${confirm.id}`, { method: 'DELETE' });
                    if (confirm.id === current?.id) window.location.assign('/');
                    setConfirm(undefined);
                    setPassword('');
                  })
                }
              >
                {confirm.deletedAt ? 'Confirm permanent deletion' : 'Confirm move to trash'}
              </button>
            </div>
          </div>
        )}
      </div>
      {sharing && (
        <Members
          workspace={sharing}
          onClose={() => {
            setSharing(undefined);
            void load();
          }}
        />
      )}
    </Modal>
  );
}

export function AccountView({ account, onChanged }: { account: Account; onChanged: () => void }) {
  const [displayName, setDisplayName] = useState(account.displayName),
    [username, setUsername] = useState(account.username);
  const [currentPassword, setCurrentPassword] = useState(''),
    [password, setPassword] = useState(''),
    [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function perform(work: () => Promise<any>) {
    try {
      setError('');
      await work();
      setCurrentPassword('');
      setPassword('');
      setNotice('Account updated.');
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Account settings</h1>
          <p>Your identity and sign-in. Workspace preferences are separate.</p>
        </div>
      </div>
      <ErrorMessage message={error} />
      {notice && <p className="success-message">{notice}</p>}
      {account.mustCompleteProfile && (
        <p className="field-note">
          Your existing data is preserved. Choose a permanent username to finish upgrading your
          account.
        </p>
      )}
      <div className="settings-grid">
        <section className="settings-card">
          <h2>Your profile</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(() =>
                api('account', {
                  method: 'PATCH',
                  body: { displayName, username, currentPassword },
                }),
              );
            }}
          >
            <label>
              Display name
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </label>
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} required />
            </label>
            <label>
              Current password
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required={username !== account.username}
              />
            </label>
            <button className="button primary">Save profile</button>
          </form>
        </section>
        <section className="settings-card">
          <h2>Change your password</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(() => post('account/password', { currentPassword, password }));
            }}
          >
            <label>
              Current password
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </label>
            <label>
              New password
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button className="button secondary">Change password</button>
          </form>
        </section>
        <section className="settings-card full">
          <h2>Delete your account</h2>
          <p>
            Your automations stop and your workspaces move to trash for 30 days. An administrator
            can restore your account during that period. The last active administrator cannot be
            deleted.
          </p>
          <button className="text-button danger" onClick={() => setDeleting(!deleting)}>
            Delete account
          </button>
          {deleting && (
            <>
              <label>
                Confirm your password
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </label>
              <button
                className="button secondary"
                onClick={() =>
                  void perform(async () => {
                    await api('account', { method: 'DELETE', body: { password: currentPassword } });
                    window.location.assign('/');
                  })
                }
              >
                Confirm account deletion
              </button>
            </>
          )}
        </section>
      </div>
    </>
  );
}

export function AdminView() {
  const [users, setUsers] = useState<Account[]>([]);
  const [link, setLink] = useState(''),
    [error, setError] = useState('');
  async function load() {
    setUsers(await api<Account[]>('admin/users'));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function perform(work: () => Promise<any>) {
    try {
      setError('');
      await work();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>People on this installation</h1>
          <p>Manage account access. Workspace content follows membership permissions.</p>
        </div>
      </div>
      <ErrorMessage message={error} />
      {link && (
        <section className="settings-card">
          <label>
            Private recovery link
            <input
              aria-label="Private access link"
              readOnly
              value={link}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <small>Single use. Expires in 30 minutes.</small>
        </section>
      )}
      <div className="account-list">
        {users.map((user) => (
          <section className="settings-card" key={user.id}>
            <div className="account-row">
              <div>
                <strong>{user.displayName}</strong>
                <small>
                  @{user.username} · {user.isAdmin ? 'Administrator' : 'User'} · {user.status}
                </small>
              </div>
              <div className="button-group">
                <button
                  className="button secondary"
                  onClick={() =>
                    void perform(async () => {
                      setLink('');
                      const result = await post(`admin/users/${user.id}/recovery`);
                      setLink(result.url);
                    })
                  }
                  disabled={user.status !== 'active'}
                >
                  Recovery link
                </button>
                <button
                  className="text-button"
                  onClick={() =>
                    void perform(() =>
                      api(`admin/users/${user.id}`, {
                        method: 'PATCH',
                        body: { status: user.status === 'active' ? 'suspended' : 'active' },
                      }),
                    )
                  }
                >
                  {user.status === 'active' ? 'Suspend' : 'Reactivate'} {user.username}
                </button>
                <button
                  className="text-button"
                  onClick={() =>
                    void perform(() =>
                      api(`admin/users/${user.id}`, {
                        method: 'PATCH',
                        body: { status: user.status, isAdmin: !user.isAdmin },
                      }),
                    )
                  }
                  disabled={user.status !== 'active'}
                >
                  {user.isAdmin ? 'Remove administrator' : 'Make administrator'}
                </button>
                {user.status !== 'deleted' && (
                  <button
                    className="text-button danger"
                    onClick={() =>
                      void perform(() =>
                        api(`admin/users/${user.id}`, {
                          method: 'PATCH',
                          body: { status: 'deleted' },
                        }),
                      )
                    }
                  >
                    Trash account {user.username}
                  </button>
                )}
              </div>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

export function InstallationView() {
  const [settings, setSettings] = useState<any>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    void api('system/settings')
      .then(setSettings)
      .catch((e) => setError(e.message));
  }, []);
  if (!settings)
    return (
      <>
        <ErrorMessage message={error} />
        <Loading />
      </>
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Installation settings</h1>
          <p>Defaults for new workspaces. Existing workspaces keep their own preferences.</p>
        </div>
      </div>
      <ErrorMessage message={error} />
      {notice && <p className="success-message">{notice}</p>}
      <OAuthSetup />
      <section className="settings-card">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void api('system/settings', { method: 'PATCH', body: settings })
              .then(() => setNotice('Installation defaults saved.'))
              .catch((e) => setError(e.message));
          }}
        >
          <label>
            Default timezone
            <input
              value={settings.timezone ?? 'UTC'}
              onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
            />
          </label>
          <label>
            Default local model
            <input
              value={settings.model}
              onChange={(e) => setSettings({ ...settings, model: e.target.value })}
            />
          </label>
          <label>
            Default retention days
            <input
              type="number"
              min={1}
              max={3650}
              value={settings.retentionDays ?? 30}
              onChange={(e) => setSettings({ ...settings, retentionDays: Number(e.target.value) })}
            />
          </label>
          <button className="button primary">Save installation defaults</button>
        </form>
        <p>
          Four shared execution slots. One Ollama request at a time. Full installation backups and
          administrator recovery are local operator commands.
        </p>
      </section>
    </>
  );
}

function Members({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const [members, setMembers] = useState<any[]>([]),
    [username, setUsername] = useState(''),
    [role, setRole] = useState('editor'),
    [error, setError] = useState('');
  const load = () => api<any[]>(`workspaces/${workspace.id}/members`).then(setMembers);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [workspace.id]);
  async function act(work: () => Promise<any>) {
    try {
      await work();
      await load();
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal
      title={`Share ${workspace.name}`}
      subtitle="Add an existing account on this computer. Editors can use this workspace’s connected apps."
      onClose={onClose}
    >
      <div className="workspace-manager">
        <ErrorMessage message={error} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await post(`workspaces/${workspace.id}/members`, { username, role });
              setUsername('');
            });
          }}
        >
          <label>
            Member username
            <input value={username} onChange={(e) => setUsername(e.target.value)} required />
          </label>
          <label>
            Role
            <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
          </label>
          <button className="button primary">Add member</button>
        </form>
        <div className="account-list">
          {members.map((m) => (
            <div className="account-row" key={m.userId}>
              <strong>{m.user.username}</strong>
              <select
                aria-label={`Role for ${m.user.username}`}
                value={m.role}
                onChange={(e) =>
                  void act(() =>
                    api(`workspaces/${workspace.id}/members/${m.userId}`, {
                      method: 'PATCH',
                      body: { role: e.target.value },
                    }),
                  )
                }
              >
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </select>
              <button
                className="text-button danger"
                onClick={() =>
                  void act(() =>
                    api(`workspaces/${workspace.id}/members/${m.userId}`, { method: 'DELETE' }),
                  )
                }
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        {!members.length && (
          <p className="muted">This workspace is private. Add a member to share it.</p>
        )}
      </div>
    </Modal>
  );
}

type OAuthCredentialStatus = { provider: string; updatedAt: string };

function OAuthSetup() {
  const [provider, setProvider] = useState('google'),
    [clientId, setClientId] = useState(''),
    [clientSecret, setClientSecret] = useState(''),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const [credentials, setCredentials] = useState<OAuthCredentialStatus[] | null>(null);
  const [statusError, setStatusError] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  async function loadStatus() {
    setStatusError('');
    try {
      setCredentials(await api<OAuthCredentialStatus[]>('system/integrations'));
    } catch {
      setStatusError('Could not check saved credentials. Try again before making changes.');
    }
  }
  useEffect(() => {
    void loadStatus();
  }, []);
  const saved = credentials?.find((item) => item.provider === provider);
  const providerName = provider === 'google' ? 'Google' : 'Microsoft';
  function clearDraft() {
    setClientId('');
    setClientSecret('');
    setEditing(false);
    setError('');
  }
  async function save() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await post<OAuthCredentialStatus>(`system/integrations/${provider}`, {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      setCredentials((current) => [
        ...(current ?? []).filter((item) => item.provider !== result.provider),
        result,
      ]);
      clearDraft();
      setNotice(`${providerName} app credentials saved securely.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card">
      <h2>App developer credentials</h2>
      <p>
        Configure once for this installation. Workspace members then authorize their own accounts.
        Existing connections keep their original configuration until reconnected.
      </p>
      <label>
        Provider
        <select
          disabled={busy}
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            clearDraft();
            setNotice('');
          }}
        >
          <option value="google">Google</option>
          <option value="microsoft">Microsoft</option>
        </select>
      </label>
      {statusError ? (
        <div>
          <ErrorMessage message={statusError} />
          <button type="button" className="button secondary" onClick={() => void loadStatus()}>
            Check saved status again
          </button>
        </div>
      ) : credentials === null ? (
        <p role="status">Checking saved credentials…</p>
      ) : (
        <>
          <div className={`oauth-save-status ${saved ? 'configured' : ''}`} role="status">
            <Icon name={saved ? 'ShieldCheck' : 'Link2'} size={22} />
            <div>
              <strong>
                {providerName} · {saved ? 'Saved securely' : 'Not configured'}
              </strong>
              {saved ? (
                <>
                  <p>
                    Client ID stored · Secret{' '}
                    <span aria-hidden="true" className="secret-mask">
                      ••••••••••••
                    </span>
                    <span className="sr-only">stored and hidden</span>
                  </p>
                  <small>
                    Last saved{' '}
                    <time dateTime={saved.updatedAt}>
                      {new Date(saved.updatedAt).toLocaleString()}
                    </time>
                  </small>
                </>
              ) : (
                <p>No app credentials have been saved for {providerName}.</p>
              )}
            </div>
          </div>
          {saved && !editing && (
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                clearDraft();
                setNotice('');
                setEditing(true);
              }}
            >
              Replace credentials
            </button>
          )}
          {(!saved || editing) && (
            <form
              autoComplete="off"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) void save();
              }}
            >
              {saved && (
                <p>
                  Enter both replacement values. Saved credentials stay unchanged until you save.
                </p>
              )}
              <label>
                Client ID
                <input
                  name="oauth-client-id"
                  autoComplete="off"
                  required
                  disabled={busy}
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                />
              </label>
              <label>
                Client secret
                <input
                  type="password"
                  name="oauth-client-secret"
                  autoComplete="new-password"
                  required
                  disabled={busy}
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
              </label>
              <div className="oauth-save-actions">
                <button className="button primary" disabled={busy}>
                  {busy
                    ? 'Saving…'
                    : saved
                      ? 'Save replacement credentials'
                      : 'Save app credentials'}
                </button>
                {saved && (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={clearDraft}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}
          {saved && (
            <p>
              Credentials are stored. Connect your account separately in Apps &amp; connections.
            </p>
          )}
        </>
      )}
      <p>
        Callback:{' '}
        <code>{`${typeof window !== 'undefined' ? window.location.origin : ''}/api/v1/connections/${provider}/callback`}</code>
      </p>
      <ErrorMessage message={error} />
      {notice && (
        <p className="success-message" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
