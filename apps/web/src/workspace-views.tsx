'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  apiUrl,
  download,
  post,
  pretty,
  shortDate,
  type Connection,
  type Note,
  type Run,
} from './lib';
import { Empty, ErrorMessage, Icon, Loading, Modal, Status, StepIcon } from './ui';

export { AuthView as Setup } from './accounts-view';

const connectionFields: Record<
  string,
  { key: string; label: string; secret?: boolean; default?: string }[]
> = {
  google: [{ key: 'apps', label: 'Google apps (comma separated)', default: 'gmail,sheets' }],
  gemini: [
    { key: 'apiKey', label: 'Gemini API key', secret: true },
    { key: 'model', label: 'Model', default: 'gemini-3.5-flash-lite' },
  ],
  openai: [
    { key: 'apiKey', label: 'OpenAI API key', secret: true },
    { key: 'model', label: 'Model', default: 'gpt-4.1-mini' },
  ],
  microsoft: [{ key: 'apps', label: 'Microsoft apps (outlook,excel)', default: 'outlook' }],
  slack: [{ key: 'token', label: 'Slack bot token', secret: true }],
  discord: [{ key: 'webhook', label: 'Discord channel webhook URL', secret: true }],
  notion: [{ key: 'token', label: 'Notion integration token', secret: true }],
  mysql: [
    { key: 'host', label: 'Database host' },
    { key: 'port', label: 'Port', default: '3306' },
    { key: 'database', label: 'Database name' },
    { key: 'user', label: 'Database user' },
    { key: 'password', label: 'Database password', secret: true },
    { key: 'tls', label: 'Use TLS (true/false)', default: 'true' },
  ],
  postgres: [
    { key: 'host', label: 'Database host' },
    { key: 'port', label: 'Port', default: '5432' },
    { key: 'database', label: 'Database name' },
    { key: 'user', label: 'Database user' },
    { key: 'password', label: 'Database password', secret: true },
    { key: 'tls', label: 'Use TLS (true/false)', default: 'true' },
  ],
  telegram: [{ key: 'token', label: 'Bot token', secret: true }],
  http: [{ key: 'token', label: 'Bearer token', secret: true }],
  smtp: [
    { key: 'host', label: 'SMTP host', default: 'smtp.gmail.com' },
    { key: 'port', label: 'SMTP port', default: '465' },
    { key: 'user', label: 'Email username' },
    { key: 'password', label: 'App password', secret: true },
    { key: 'from', label: 'From email address' },
  ],
  imap: [
    { key: 'host', label: 'IMAP host', default: 'imap.gmail.com' },
    { key: 'port', label: 'IMAP port', default: '993' },
    { key: 'user', label: 'Email username' },
    { key: 'password', label: 'App password', secret: true },
  ],
};

export function ConnectionsView({ readOnly = false }: { readOnly?: boolean }) {
  const [apps, setApps] = useState<any[]>([]),
    [search, setSearch] = useState('');
  const [connections, setConnections] = useState<Connection[]>([]);
  const [kind, setKind] = useState('');
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<string>();
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    try {
      await Promise.all([
        api<Connection[]>('connections').then(setConnections),
        api<any[]>('apps').then(setApps),
      ]);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const remainingApps = apps.filter((app) => app.id !== 'ollama' && app.status !== 'Connected');
  function choose(value: string, connection?: Connection) {
    setKind(value);
    setName(connection?.name ?? '');
    setEditing(connection?.id);
    setSecret(
      Object.fromEntries(
        (connectionFields[value] ?? []).filter((f) => f.default).map((f) => [f.key, f.default!]),
      ),
    );
    setError('');
  }
  async function save() {
    setBusy('save');
    setError('');
    try {
      const connection = await post<Connection>('connections', { kind, name, secret, id: editing });
      setSecret({});
      if (kind === 'google' || kind === 'microsoft') {
        const authorization = await post<{ url: string }>(`connections/${connection.id}/authorize`);
        window.location.assign(authorization.url);
        return;
      }
      await post(`connections/${connection.id}/test`);
      setKind('');
      setNotice('Your connection is ready.');
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load();
    } finally {
      setBusy('');
    }
  }
  async function disconnect(connection: Connection, appId?: string, appName?: string) {
    const grouped = ['google', 'microsoft'].includes(connection.kind);
    const question =
      appId && grouped
        ? `Disconnect ${appName} in this workspace? Affected workflows will be paused and active runs cancelled. Other apps stay connected. Provider permissions remain unchanged.`
        : `Disconnect ${connection.name} from this workspace? Its saved connection will be removed, affected workflows paused and active runs cancelled. Provider permissions remain unchanged.`;
    if (!window.confirm(question)) return;
    setBusy(connection.id);
    setError('');
    try {
      const result = await post<{ pausedWorkflows: number; cancelledRuns: number }>(
        `connections/${connection.id}/disconnect`,
        appId ? { appId } : {},
      );
      setNotice(
        `${appName ?? connection.name} disconnected. ${result.pausedWorkflows} workflows paused; ${result.cancelledRuns} active runs cancelled. Existing data is preserved.`,
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Your apps, connected.</h1>
          <p>Connect once. Use your accounts across any workflow.</p>
        </div>
        {remainingApps.length > 0 && (
          <button disabled={readOnly} className="button primary" onClick={() => choose('choose')}>
            <Icon name="Plus" size={17} />
            Add connection
          </button>
        )}
      </div>
      <label>
        Search apps
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Google Drive, Slack, Notion…"
        />
      </label>
      <div className="app-catalog">
        {apps
          .filter((a) => `${a.name} ${a.category}`.toLowerCase().includes(search.toLowerCase()))
          .map((a) => (
            <section className="app-card" key={a.id}>
              <div>
                <StepIcon type={a.id} />
                <h3>{a.name}</h3>
              </div>
              <span
                className={`app-connection-status ${a.status === 'Connected' ? 'connected' : ''}`}
              >
                {a.status}
              </span>
              <p>
                {a.actions.length
                  ? `${a.actions.length} supported actions`
                  : 'Available as a workflow trigger or connection'}
              </p>
              <details>
                <summary>Supported actions</summary>
                <ul>
                  {a.actions.map((n: any) => (
                    <li key={n.type}>{n.label}</li>
                  ))}
                </ul>
                <small>Live provider verification requires your test account.</small>
              </details>
              {a.status === 'Connected' &&
                a.connections
                  .filter(
                    (connection: Connection) =>
                      ['connected', 'configured'].includes(connection.status) &&
                      (!connection.apps || connection.apps.includes(a.id)),
                  )
                  .map((connection: Connection) => (
                    <div className="app-disconnect" key={connection.id}>
                      <small>{connection.name}</small>
                      <button
                        className="text-button danger"
                        disabled={readOnly || !!busy}
                        aria-label={`Disconnect ${a.name} in this workspace${a.connections.length > 1 ? ` · ${connection.name}` : ''}`}
                        onClick={() => void disconnect(connection, a.id, a.name)}
                      >
                        Disconnect in this workspace
                      </button>
                    </div>
                  ))}
              {a.id !== 'ollama' && a.status !== 'Connected' && (
                <button
                  disabled={readOnly || !!busy}
                  className="button secondary compact"
                  onClick={() => {
                    const existing = a.connections?.[0];
                    if (existing) {
                      if (
                        existing.disabledApps?.includes(a.id) &&
                        ['connected', 'configured'].includes(existing.status)
                      ) {
                        setBusy(existing.id);
                        setError('');
                        void post<{ message: string }>(
                          `connections/${existing.id}/apps/${a.id}/connect`,
                        )
                          .then((result) => {
                            setNotice(result.message);
                            return load();
                          })
                          .catch((e) => setError(e.message))
                          .finally(() => setBusy(''));
                        return;
                      }
                      if (a.connectionKind === 'google' || a.connectionKind === 'microsoft') {
                        void post<{ url: string }>(`connections/${existing.id}/authorize`)
                          .then((r) => window.location.assign(r.url))
                          .catch((e) => setError(e.message));
                      } else choose(a.connectionKind, existing);
                      return;
                    }
                    choose(a.connectionKind);
                    if (a.connectionKind === 'google' || a.connectionKind === 'microsoft')
                      setSecret({ apps: a.id });
                  }}
                >
                  {a.status === 'Needs authorization' ? 'Reconnect' : 'Connect'} {a.name}
                </button>
              )}
            </section>
          ))}
      </div>
      <div className="privacy-strip">
        <Icon name="ShieldCheck" size={19} />
        <div>
          <strong>Credentials stay on this computer</strong>
          <p>Encrypted before storage. Never included in AI prompts or workflow exports.</p>
        </div>
      </div>
      <ErrorMessage message={error} />
      {notice && (
        <div className="success-message">
          <Icon name="CheckCircle2" size={16} />
          {notice}
        </div>
      )}
      {connections.length ? (
        <div className="connection-grid">
          {connections.map((c) => (
            <div className="connection-card" key={c.id}>
              <div className="connection-card-top">
                <StepIcon type={c.kind === 'smtp' || c.kind === 'imap' ? 'email' : c.kind} />
                <Status status={c.status} />
              </div>
              <h3>{c.name}</h3>
              <p>{c.kind === 'google' ? 'Google Workspace' : c.kind.toUpperCase()}</p>
              <div className="connection-actions">
                <button
                  className="text-button"
                  disabled={readOnly || !!busy}
                  onClick={() => {
                    setBusy(c.id);
                    void post<{ message: string }>(`connections/${c.id}/test`)
                      .then((r) => {
                        setNotice(r.message);
                        setError('');
                      })
                      .catch((e) => setError(e.message))
                      .finally(() => {
                        setBusy('');
                        void load();
                      });
                  }}
                >
                  <Icon
                    name={busy === c.id ? 'LoaderCircle' : 'CheckCircle2'}
                    className={busy === c.id ? 'spin' : ''}
                    size={15}
                  />
                  Test
                </button>
                {!['connected', 'configured'].includes(c.status) && (
                  <button
                    className="text-button"
                    disabled={readOnly}
                    onClick={() =>
                      c.kind === 'google' || c.kind === 'microsoft'
                        ? void post<{ url: string }>(`connections/${c.id}/authorize`)
                            .then((r) => window.location.assign(r.url))
                            .catch((e) => setError(e.message))
                        : choose(c.kind, c)
                    }
                  >
                    Reconnect
                  </button>
                )}
                <button
                  className="text-button danger"
                  disabled={readOnly || !!busy}
                  onClick={() => void disconnect(c)}
                >
                  {c.kind === 'google'
                    ? 'Disconnect Google account'
                    : c.kind === 'microsoft'
                      ? 'Disconnect Microsoft account'
                      : 'Disconnect connection'}
                </button>
              </div>
              {c.apps && (
                <p>
                  {c.apps.length
                    ? `Enabled apps: ${c.apps.join(', ')}`
                    : 'All apps disconnected in this workspace.'}
                </p>
              )}
              {c.kind === 'google' && (
                <details>
                  <summary>Google permissions</summary>
                  <p>
                    Workspace disconnection does not revoke Google permissions. Removing this
                    project's access in Google can disconnect the same Google account in other
                    workspaces.
                  </p>
                  <a
                    href="https://myaccount.google.com/connections"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Review Google account permissions
                  </a>
                </details>
              )}
            </div>
          ))}
        </div>
      ) : (
        <Empty
          icon="Link2"
          title="Let your apps work together"
          text="Local notes work without connections. Local AI also works when Ollama is installed. Add your favorite apps whenever you’re ready."
        >
          <button disabled={readOnly} className="button primary" onClick={() => choose('choose')}>
            <Icon name="Plus" size={16} />
            Add your first connection
          </button>
        </Empty>
      )}
      {kind && (
        <Modal
          title={
            kind === 'choose'
              ? 'Connect an app'
              : `Connect ${kind === 'google' ? 'Google' : kind === 'telegram' ? 'Telegram' : kind.toUpperCase()}`
          }
          subtitle="Your credentials are encrypted and stored locally."
          onClose={() => {
            setKind('');
            setSecret({});
          }}
        >
          <div className="connection-form">
            {kind === 'choose' ? (
              <div className="connection-choices">
                {[
                  ['telegram', 'Telegram', 'Send messages and receive bot updates'],
                  ['google', 'Google', 'Gmail, Sheets, Drive and Calendar'],
                  ['gemini', 'Google Gemini', 'AI with your API key'],
                  ['openai', 'OpenAI', 'Optional AI provider'],
                  ['microsoft', 'Microsoft', 'Outlook and Excel 365'],
                  ['slack', 'Slack', 'Channels and messages'],
                  ['discord', 'Discord', 'Channel webhook'],
                  ['notion', 'Notion', 'Pages and records'],
                  ['mysql', 'MySQL', 'Structured database operations'],
                  ['postgres', 'PostgreSQL', 'Structured database operations'],
                  ['smtp', 'Send email', 'SMTP with your email provider'],
                  ['imap', 'Receive email', 'IMAP with your email provider'],
                  ['http', 'HTTP API', 'Connect with a bearer token'],
                ]
                  .filter(
                    ([key]) =>
                      remainingApps.some((app) => app.connectionKind === key) &&
                      (!['google', 'microsoft'].includes(key!) ||
                        !connections.some((connection) => connection.kind === key)),
                  )
                  .map(([key, label, description]) => (
                    <button key={key} onClick={() => choose(key!)}>
                      <StepIcon
                        type={
                          key === 'google'
                            ? 'gmail'
                            : key === 'smtp' || key === 'imap'
                              ? 'email'
                              : key!
                        }
                      />
                      <span>
                        <strong>{label}</strong>
                        <small>{description}</small>
                      </span>
                      <Icon name="ChevronRight" size={17} />
                    </button>
                  ))}
              </div>
            ) : (
              <>
                {kind === 'google' && (
                  <details className="setup-instructions" open>
                    <summary>Google connection requirements</summary>
                    <ol>
                      <li>
                        Open{' '}
                        <a
                          href="https://console.cloud.google.com/apis/library"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Google Cloud Console
                        </a>{' '}
                        and enable the APIs for the apps you selected. Ask the installation
                        administrator to save OAuth developer credentials in Installation settings.
                      </li>
                      <li>
                        Configure the OAuth consent screen. Add your email as a test user when using
                        testing mode.
                      </li>
                      <li>
                        Create an OAuth client of type <strong>Web application</strong>.
                      </li>
                      <li>
                        Add this authorized redirect URI:
                        <code>
                          {typeof window !== 'undefined' ? window.location.origin : ''}
                          /api/v1/connections/google/callback
                        </code>
                      </li>
                      <li>Use the saved developer credentials to authorize your account here.</li>
                    </ol>
                    <p>
                      Google can limit unverified applications and expire testing-mode access.
                      Reconnect when requested.
                    </p>
                  </details>
                )}
                {kind === 'telegram' && (
                  <div className="field-note">
                    <Icon name="Send" size={18} />
                    <p>
                      Open{' '}
                      <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
                        @BotFather
                      </a>{' '}
                      in Telegram, send <strong>/newbot</strong>, and copy the bot token. Then send
                      a message to your new bot.
                    </p>
                  </div>
                )}
                {['smtp', 'imap'].includes(kind) && (
                  <label>
                    Provider preset
                    <select
                      onChange={(e) => {
                        const provider = e.target.value;
                        setSecret((s) => ({
                          ...s,
                          host:
                            kind === 'smtp'
                              ? provider === 'outlook'
                                ? 'smtp.office365.com'
                                : 'smtp.gmail.com'
                              : provider === 'outlook'
                                ? 'outlook.office365.com'
                                : 'imap.gmail.com',
                          port:
                            kind === 'smtp' && provider === 'outlook'
                              ? '587'
                              : kind === 'smtp'
                                ? '465'
                                : '993',
                        }));
                      }}
                    >
                      <option value="gmail">Gmail (app password)</option>
                      <option value="outlook">
                        Outlook (provider must allow password authentication)
                      </option>
                      <option value="custom">Custom — edit the fields below</option>
                    </select>
                  </label>
                )}
                <label>
                  Connection name
                  <input
                    name={`connection-${kind}-label`}
                    autoComplete="off"
                    placeholder="For example: My personal email"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                {connectionFields[kind]?.map((field) => (
                  <label key={field.key}>
                    {field.label}
                    <input
                      type={field.secret ? 'password' : 'text'}
                      name={`connection-${kind}-${field.key}`}
                      autoComplete={field.secret ? 'new-password' : 'off'}
                      value={secret[field.key] ?? ''}
                      onChange={(e) => setSecret((s) => ({ ...s, [field.key]: e.target.value }))}
                    />
                  </label>
                ))}
                <ErrorMessage message={error} />
                <div className="modal-actions">
                  <button className="button secondary" onClick={() => choose('choose')}>
                    Back
                  </button>
                  <button
                    className="button primary"
                    disabled={!!busy || !name.trim()}
                    onClick={() => void save()}
                  >
                    <Icon
                      name={busy ? 'LoaderCircle' : 'Link2'}
                      className={busy ? 'spin' : ''}
                      size={16}
                    />
                    {kind === 'google' ? 'Save & authorize with Google' : 'Save & test connection'}
                  </button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

export function NotesView({ readOnly = false }: { readOnly?: boolean }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Partial<Note>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api<Note[]>(`notes?q=${encodeURIComponent(search)}`)
        .then(setNotes)
        .catch((e) => setError(e.message)),
    [search],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      await api(editing.id ? `notes/${editing.id}` : 'notes', {
        method: editing.id ? 'PATCH' : 'POST',
        body: { title: editing.title, text: editing.text ?? '' },
      });
      setEditing(undefined);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>A place for your notes.</h1>
          <p>Keep ideas, save workflow results, and give local AI something to work with.</p>
        </div>
        <button
          disabled={readOnly}
          className="button primary"
          onClick={() => {
            setError('');
            setEditing({ title: '', text: '' });
          }}
        >
          <Icon name="Plus" size={17} />
          New note
        </button>
      </div>
      <div className="list-toolbar">
        <div className="search-input">
          <Icon name="Search" size={17} />
          <input
            placeholder="Find a note…"
            aria-label="Search notes"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className="muted">{notes.length} notes</span>
      </div>
      <ErrorMessage message={error} />
      {notes.length ? (
        <div className="notes-grid">
          {notes.map((n) => (
            <button
              key={n.id}
              className="note-card"
              onClick={() => {
                setError('');
                setEditing(n);
              }}
            >
              <Icon name="FileText" size={20} />
              <h3>{n.title}</h3>
              <p>{n.text}</p>
              <small>{shortDate(n.updatedAt)}</small>
            </button>
          ))}
        </div>
      ) : (
        <Empty
          icon="FileText"
          title="Keep an idea close"
          text="Create a note yourself, or let a workflow save its results here."
        >
          <button
            disabled={readOnly}
            className="button primary"
            onClick={() => setEditing({ title: '', text: '' })}
          >
            <Icon name="Plus" size={16} />
            Write a note
          </button>
        </Empty>
      )}
      {editing && (
        <Modal
          title={editing.id ? 'Edit your note' : 'A new note'}
          subtitle="Stored in your local workspace."
          onClose={() => setEditing(undefined)}
          wide
        >
          <div className="note-editor">
            <label>
              Title
              <input
                autoFocus
                readOnly={readOnly}
                aria-label="Note title"
                placeholder="Give your note a title"
                value={editing.title ?? ''}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              />
            </label>
            <label>
              Content
              <textarea
                rows={12}
                readOnly={readOnly}
                aria-label="Note content"
                placeholder="What’s on your mind?"
                value={editing.text ?? ''}
                onChange={(e) => setEditing({ ...editing, text: e.target.value })}
              />
            </label>
            <ErrorMessage message={error} />
            <div className="modal-actions">
              {editing.id && !readOnly && (
                <button
                  className="text-button danger"
                  onClick={() => {
                    if (window.confirm('Delete this note?'))
                      void api(`notes/${editing.id}`, { method: 'DELETE' })
                        .then(() => {
                          setEditing(undefined);
                          void load();
                        })
                        .catch((e) => setError(e.message));
                  }}
                >
                  <Icon name="Trash2" size={15} />
                  Delete note
                </button>
              )}
              <button className="button secondary" onClick={() => setEditing(undefined)}>
                Cancel
              </button>
              <button
                className="button primary"
                disabled={readOnly || busy || !editing.title?.trim()}
                onClick={() => void save()}
              >
                <Icon
                  name={busy ? 'LoaderCircle' : 'Save'}
                  className={busy ? 'spin' : ''}
                  size={16}
                />
                Save note
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

export function RunsView() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<Run>();
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const [inspected, setInspected] = useState(false);
  const load = useCallback(
    () =>
      api<Run[]>('runs')
        .then(setRuns)
        .catch((e) => setError(e.message)),
    [],
  );
  const detail = useCallback(
    (id: string) =>
      api<Run>(`runs/${id}`)
        .then(setSelected)
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (!selected?.id) return;
    const id = selected.id;
    const stream = new EventSource(apiUrl(`runs/${id}/events`));
    stream.onmessage = () => {
      void detail(id);
      void load();
    };
    stream.onerror = () => {};
    return () => stream.close();
  }, [selected?.id, detail, load]);
  async function action(path: string, body?: unknown) {
    if (!selected) return;
    try {
      await post(`runs/${selected.id}/${path}`, body);
      await detail(selected.id);
      await load();
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Every step, in the open.</h1>
          <p>See what ran, what happened, and what needs a little attention.</p>
        </div>
        <span className="live-label">
          <span className="health-dot online" />
          Updates automatically
        </span>
      </div>
      <div className="category-tabs">
        {['all', 'succeeded', 'running', 'waiting', 'failed', 'unknown'].map((s) => (
          <button key={s} className={filter === s ? 'active' : ''} onClick={() => setFilter(s)}>
            {s === 'all'
              ? 'All runs'
              : s === 'unknown'
                ? 'Outcome unknown'
                : s[0]!.toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      <ErrorMessage message={error} />
      {runs.length ? (
        <div className="run-table">
          <div className="run-table-heading">
            <span>WORKFLOW</span>
            <span>STATUS</span>
            <span>STARTED</span>
            <span>MODE</span>
            <span />
          </div>
          {runs
            .filter((r) => filter === 'all' || r.status === filter)
            .map((run) => (
              <button
                key={run.id}
                className="run-row"
                onClick={() => {
                  setInspected(false);
                  void detail(run.id);
                }}
              >
                <span>
                  <Icon name="Workflow" size={19} />
                  <strong>{run.workflow.name}</strong>
                </span>
                <Status status={run.status} />
                <span>{shortDate(run.createdAt)}</span>
                <span className={`mode-label ${run.preview ? 'preview' : ''}`}>
                  {run.preview ? 'Preview' : 'Live run'}
                </span>
                <Icon name="ChevronRight" size={16} />
              </button>
            ))}
        </div>
      ) : (
        <Empty
          icon="Activity"
          title="Your first run will appear here"
          text="Open a workflow and choose Preview to see each step in action."
        />
      )}
      {selected && (
        <Modal
          title={selected.workflow.name}
          subtitle={`${selected.preview ? 'Preview' : 'Live run'} · ${shortDate(selected.createdAt)}`}
          onClose={() => setSelected(undefined)}
          wide
        >
          <div className="run-detail">
            <div className="run-detail-summary">
              <Status status={selected.status} />
              <span>
                {selected.nodes?.filter((n) => n.status === 'succeeded').length ?? 0} steps
                completed
              </span>
              {!['succeeded', 'failed', 'unknown', 'cancelled'].includes(selected.status) && (
                <button className="button secondary compact" onClick={() => void action('cancel')}>
                  <Icon name="Square" size={13} />
                  Cancel run
                </button>
              )}
            </div>
            <ErrorMessage message={selected.error || error} />
            {selected.restoredAt && (
              <p className="help-text">
                Restored runs are history only. Start a new run from the workflow to use this
                workspace’s resources.
              </p>
            )}
            {selected.nodes?.map((task) => {
              const node = selected.scopes
                ?.find((s) => s.key === task.scope)
                ?.definition.nodes.find((n) => n.id === task.nodeId);
              return (
                <section className="run-step" key={task.id}>
                  <div className="run-step-header">
                    <StepIcon type={node?.type ?? 'data'} small />
                    <strong>{node?.label ?? task.nodeId}</strong>
                    {task.scope !== 'root' && <small>List item</small>}
                    <Status status={task.status} />
                  </div>
                  {task.error && <ErrorMessage message={task.error} />}
                  {task.output && <Result output={task.output} />}
                  {task.status === 'waiting' && task.reason === 'approval' && (
                    <div className="approval-card">
                      <strong>{String(node?.config.message ?? 'Review before continuing')}</strong>
                      {task.input && <Result output={task.input} />}
                      <div className="button-group">
                        <button
                          className="button primary compact"
                          onClick={() =>
                            void action('approval', { taskId: task.id, approve: true })
                          }
                        >
                          <Icon name="Check" size={15} />
                          Approve
                        </button>
                        <button
                          className="button secondary compact"
                          onClick={() =>
                            void action('approval', { taskId: task.id, approve: false })
                          }
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  )}
                  {!selected.restoredAt && ['failed', 'unknown'].includes(task.status) && (
                    <div className="retry-actions">
                      {task.status === 'unknown' && (
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={inspected}
                            onChange={(e) => setInspected(e.target.checked)}
                          />
                          I inspected the destination and want to retry this operation.
                        </label>
                      )}
                      <button
                        className="button secondary compact"
                        disabled={task.status === 'unknown' && !inspected}
                        onClick={() =>
                          void action('retry', { taskId: task.id, inspectedDestination: inspected })
                        }
                      >
                        <Icon name="RotateCcw" size={14} />
                        Retry this step
                      </button>
                    </div>
                  )}
                  <details className="technical-details">
                    <summary>Input and attempts ({task.attempt})</summary>
                    <pre>{pretty(task.input)}</pre>
                    {task.attempts?.map((a) => (
                      <p key={a.number}>
                        Attempt {a.number}: {a.status} {a.error}
                      </p>
                    ))}
                  </details>
                </section>
              );
            })}
          </div>
        </Modal>
      )}
    </>
  );
}
function Result({ output }: { output: Record<string, unknown> }) {
  const text =
    typeof output.text === 'string'
      ? output.text
      : typeof output.label === 'string'
        ? output.label
        : undefined;
  return (
    <div className="step-result">
      {output.simulated === true && (
        <span className="pill neutral">Simulated — no changes made</span>
      )}
      {text ? (
        <p className="result-text">{text}</p>
      ) : (
        <div className="result-fields">
          {Object.entries(output)
            .filter(([key]) => !['simulated', 'notice'].includes(key))
            .map(([key, value]) => (
              <div key={key}>
                <span>{key}</span>
                <p>{typeof value === 'object' ? pretty(value) : String(value)}</p>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

export function SettingsView() {
  const [settings, setSettings] = useState<{
    timezone: string;
    model: string;
    retentionDays: number;
    retainAIDetails: boolean;
    localFolder: string;
  }>();
  const [models, setModels] = useState<{ name: string; size: number }[]>([]);
  const [health, setHealth] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [restore, setRestore] = useState<any>();
  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([api<any>('settings'), api<any>('system/health')]);
      setSettings(s);
      setHealth(h);
      try {
        setModels(await api('ai/models').catch(() => []));
      } catch {}
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!settings) return <Loading />;
  async function save() {
    setBusy(true);
    try {
      const { localFolder, ...data } = settings!;
      await api('settings', { method: 'PATCH', body: data });
      setNotice('Settings saved.');
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Make yourself at home.</h1>
          <p>Local AI, workspace preferences, and a little peace of mind.</p>
        </div>
        <button className="button primary" disabled={busy} onClick={() => void save()}>
          <Icon name="Save" size={16} />
          Save changes
        </button>
      </div>
      <ErrorMessage message={error} />
      {notice && (
        <div className="success-message">
          <Icon name="CheckCircle2" size={16} />
          {notice}
        </div>
      )}
      <div className="settings-grid">
        <section className="settings-card">
          <div className="settings-card-heading">
            <span className="option-icon purple">
              <Icon name="Sparkles" />
            </span>
            <div>
              <h2>AI that stays local</h2>
              <p>Powered by Ollama on this computer.</p>
            </div>
          </div>
          <label>
            Local model
            <select
              value={settings.model}
              onChange={(e) => setSettings({ ...settings, model: e.target.value })}
            >
              {!models.some((m) => m.name === settings.model) && (
                <option value={settings.model}>{settings.model} (not installed)</option>
              )}
              {models.map((m) => (
                <option key={m.name}>{m.name}</option>
              ))}
            </select>
          </label>
          <div className="field-note">
            <Icon name="CircleHelp" size={17} />
            <p>
              Start Ollama and install <strong>qwen3:4b</strong> to get started. AI requests run one
              at a time to keep your computer responsive.
            </p>
          </div>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void post('ai/test')
                .then(() => {
                  setNotice('Your local model returned valid structured data.');
                  setError('');
                })
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <Icon
              name={busy ? 'LoaderCircle' : 'CheckCircle2'}
              className={busy ? 'spin' : ''}
              size={16}
            />
            Test local AI
          </button>
        </section>
        <section className="settings-card">
          <div className="settings-card-heading">
            <span className="option-icon green">
              <Icon name="Radio" />
            </span>
            <div>
              <h2>Workspace health</h2>
              <p>A quick check behind the scenes.</p>
            </div>
          </div>
          {[
            ['database', 'Database'],
            ['redis', 'Workflow queue'],
            ['worker', 'Workflow worker'],
            ['ollama', 'Local AI'],
          ].map(([key, label]) => (
            <div className="health-row" key={key}>
              <span>{label}</span>
              <Status status={health[key!] ? 'connected' : 'unavailable'} />
            </div>
          ))}
          <button className="text-button" onClick={() => void load()}>
            <Icon name="RotateCcw" size={14} />
            Check again
          </button>
        </section>
        <section className="settings-card">
          <h2>Your preferences</h2>
          <label>
            Timezone
            <input
              value={settings.timezone}
              onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
            />
          </label>
          <label>
            Keep completed run history for
            <select
              value={settings.retentionDays}
              onChange={(e) => setSettings({ ...settings, retentionDays: Number(e.target.value) })}
            >
              {[7, 30, 90, 365].map((days) => (
                <option key={days} value={days}>
                  {days} days
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.retainAIDetails}
              onChange={(e) => setSettings({ ...settings, retainAIDetails: e.target.checked })}
            />
            Keep detailed AI inputs in run history
          </label>
          <small>
            Workflow results remain available. AI-step input details are removed after execution.
            Trigger inputs and workflow results remain available.
          </small>
        </section>
        <section className="settings-card">
          <h2>Your local folder</h2>
          <p>File steps can only access files inside this folder.</p>
          <code className="folder-path">{settings.localFolder}</code>
          <p className="muted">
            This managed folder belongs only to this workspace. Other workspaces use separate
            folders. Supported files: text, Markdown, JSON, and CSV.
          </p>
          <div className="field-note">
            <Icon name="FolderOpen" size={17} />
            <p>Notes are stored separately in the local database. They are included in backups.</p>
          </div>
        </section>
        <section className="settings-card full">
          <h2>Take your workspace with you</h2>
          <p>
            Create an encrypted backup of workflows, notes, connections, run history, and supported
            files. Keep the backup passphrase somewhere safe.
          </p>
          <div className="backup-controls">
            <label>
              Backup passphrase
              <input
                type="password"
                minLength={12}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="At least 12 characters"
                autoComplete="new-password"
              />
            </label>
            <button
              className="button secondary"
              disabled={busy || passphrase.length < 12}
              onClick={() => {
                setBusy(true);
                void post('backup', { passphrase })
                  .then((data) => {
                    download(
                      `neural-forge-${new Date().toISOString().slice(0, 10)}.backup.json`,
                      data,
                    );
                    setNotice('Encrypted backup downloaded.');
                    setPassphrase('');
                  })
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              <Icon name="Download" size={16} />
              Download backup
            </button>
            <label className="button secondary file-button">
              <Icon name="Upload" size={16} />
              Choose backup
              <input
                type="file"
                accept=".json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file)
                    void file
                      .text()
                      .then(JSON.parse)
                      .then(setRestore)
                      .catch((e) => setError(e.message));
                }}
              />
            </label>
          </div>
          {restore && (
            <div className="restore-confirm">
              <p>
                Restore creates a new private workspace. Your account and existing workspaces stay
                unchanged. Restored workflows remain disabled until reviewed.
              </p>
              <button
                className="button primary"
                disabled={busy || passphrase.length < 12}
                onClick={() => {
                  setBusy(true);
                  void post('workspaces/restore', { passphrase, backup: restore })
                    .then((result) => window.location.assign(`/w/${result.workspaceId}`))
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                Restore this backup
              </button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
