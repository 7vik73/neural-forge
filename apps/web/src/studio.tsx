'use client';
import { AccountView, AdminView, InstallationView, WorkspaceManager } from './accounts-view';
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  emptyGraph,
  post,
  shortDate,
  flushPendingSaves,
  type Account,
  type Workspace,
  type Workflow,
  type WorkflowTemplate,
  type Run,
  type WorkflowDefinition,
} from './lib';
import { Empty, ErrorMessage, Icon, Loading, Modal, Status, StepIcon } from './ui';
import { Builder } from './workflow-builder';
import { ConnectionsView, NotesView, RunsView, SettingsView, Setup } from './workspace-views';
import { DescribeDialog, TemplateGallery } from './workflow-create';

type View =
  | 'home'
  | 'workflows'
  | 'templates'
  | 'runs'
  | 'connections'
  | 'notes'
  | 'settings'
  | 'builder'
  | 'account'
  | 'admin'
  | 'installation';
export function Studio() {
  const [auth, setAuth] = useState<'loading' | 'setup' | 'login' | 'ready'>('loading');
  const [account, setAccount] = useState<Account>();
  const [workspace, setWorkspace] = useState<Workspace>();
  const [workspaceManager, setWorkspaceManager] = useState(false);
  const [view, setView] = useState<View>('home');
  const [workflowId, setWorkflowId] = useState('');
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [health, setHealth] = useState<{ database: boolean; redis: boolean; ollama: boolean }>();
  const [error, setError] = useState('');
  const [describe, setDescribe] = useState(false);
  const [search, setSearch] = useState('');
  const [newDialog, setNewDialog] = useState(false);
  const [name, setName] = useState('My workflow');
  const refresh = useCallback(async () => {
    try {
      if (!workspace) return;
      const [w, r, t, h] = await Promise.all([
        api<Workflow[]>('workflows'),
        api<Run[]>('runs'),
        api<WorkflowTemplate[]>('templates'),
        api<any>('system/health'),
      ]);
      setWorkflows(w);
      setRuns(r);
      setTemplates(t);
      setHealth(h);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspace]);
  const navigate = useCallback((next: View, id?: string) => {
    setView(next);
    setSearch('');
    if (id) setWorkflowId(id);
    window.history.pushState(
      {},
      '',
      `${window.location.pathname}?view=${next}${id ? `&id=${id}` : ''}`,
    );
  }, []);
  useEffect(() => {
    void (async () => {
      try {
        const state = await api<{ initialized: boolean }>('system/bootstrap');
        if (!state.initialized) {
          window.location.replace('/signup');
          return;
        }
        if (/#(?:invite|reset)=/.test(window.location.hash)) {
          setAuth('login');
          return;
        }
        try {
          const user = await api<Account>('auth/me');
          setAccount(user);
          if (user.mustCompleteProfile) {
            setView('account');
            setAuth('ready');
            return;
          }
          const spaces = await api<Workspace[]>('workspaces');
          const id = window.location.pathname.match(/^\/w\/([^/]+)/)?.[1];
          const selected = spaces.find((w) => w.id === id);
          if (!selected && !id && spaces.length) {
            const previous = localStorage.getItem(`forge-last-workspace:${user.id}`);
            window.location.replace(
              `/w/${spaces.find((w) => w.id === previous)?.id ?? spaces[0]!.id}${window.location.search}`,
            );
            return;
          }
          if (selected) {
            setWorkspace(selected);
            localStorage.setItem(`forge-last-workspace:${user.id}`, selected.id);
          } else if (id) setError('This workspace is unavailable. Choose one of your workspaces.');
          setAuth('ready');
        } catch {
          setAuth('login');
        }
      } catch (e) {
        setError((e as Error).message);
        setAuth('login');
      }
    })();
    const sync = () => {
      const params = new URLSearchParams(window.location.search);
      const next = params.get('view') as View;
      if (
        [
          'home',
          'workflows',
          'templates',
          'runs',
          'connections',
          'notes',
          'settings',
          'builder',
          'account',
          'admin',
          'installation',
        ].includes(next)
      )
        setView(next);
      else setView('home');
      setWorkflowId(params.get('id') ?? '');
    };
    sync();
    window.addEventListener('popstate', sync);
    const ended = () => {
      setWorkflows([]);
      setRuns([]);
      setAccount(undefined);
      setWorkspace(undefined);
      setAuth('login');
    };
    const externalSignout = (event: StorageEvent) => {
      if (event.key === 'forge-auth-event') window.location.reload();
    };
    window.addEventListener('forge-session-ended', ended);
    window.addEventListener('storage', externalSignout);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('forge-session-ended', ended);
      window.removeEventListener('storage', externalSignout);
    };
  }, []);
  useEffect(() => {
    if (auth === 'ready') {
      void refresh();
      const timer = setInterval(() => void refresh(), 15000);
      return () => clearInterval(timer);
    }
  }, [auth, refresh]);
  async function create(definition = emptyGraph(), title = name) {
    try {
      const workflow = await post<{ id: string }>('workflows', { name: title, definition });
      setNewDialog(false);
      await refresh();
      navigate('builder', workflow.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function instantiate(template: WorkflowTemplate) {
    try {
      const workflow = await post<{ id: string }>(`templates/${template.id}/instantiate`);
      await refresh();
      navigate('builder', workflow.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (auth === 'loading') return <Loading />;
  if (auth !== 'ready')
    return (
      <Setup
        initialized={auth === 'login'}
        onReady={() => {
          localStorage.setItem('forge-auth-event', String(Date.now()));
          window.location.assign('/');
        }}
      />
    );
  const navigation: {
    id: View;
    title: string;
    icon: 'Home' | 'Workflow' | 'LayoutGrid' | 'Activity' | 'Link2' | 'FileText';
  }[] = [
    { id: 'home', title: 'Overview', icon: 'Home' },
    { id: 'workflows', title: 'My workflows', icon: 'Workflow' },
    { id: 'templates', title: 'Templates', icon: 'LayoutGrid' },
    { id: 'runs', title: 'Run history', icon: 'Activity' },
    { id: 'connections', title: 'Apps & connections', icon: 'Link2' },
    { id: 'notes', title: 'My notes', icon: 'FileText' },
  ];
  const succeeded = runs.filter((r) => r.status === 'succeeded').length;
  const active = workflows.filter((w) => w.enabled).length;
  const needsAttention = runs.filter((r) =>
    ['failed', 'unknown', 'waiting'].includes(r.status),
  ).length;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate('home');
          }}
        >
          <span className="brand-symbol">
            <Icon name="Workflow" size={23} />
          </span>
          <span>
            neural<span className="brand-light">forge</span>
            <small>LOCAL WORKFLOW STUDIO</small>
          </span>
        </a>
        <button
          className="workspace-label workspace-switcher"
          aria-label="Switch workspace"
          onClick={() => setWorkspaceManager(true)}
        >
          <span className="workspace-avatar">
            {workspace?.name.slice(0, 1).toUpperCase() ?? '+'}
          </span>
          <span>
            {workspace?.name ?? 'Choose a workspace'}
            <small>Private to your account</small>
          </span>
          <Icon name="ChevronDown" size={14} />
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id || (view === 'builder' && item.id === 'workflows') ? 'selected' : ''}`}
              onClick={() => navigate(item.id)}
            >
              <Icon name={item.icon} />
              {item.title}
              {item.id === 'workflows' && <span className="nav-count">{workflows.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <span className={`health-dot ${health?.ollama ? 'online' : ''}`} />
            <strong>{health?.ollama ? 'Local AI available' : 'Gemini or optional local AI'}</strong>
            <p>
              Your workflows. Your computer.
              <br />
              Choose AI per workflow.
            </p>
            <button onClick={() => navigate('settings')}>
              Manage Ollama <Icon name="ArrowUpRight" size={13} />
            </button>
          </div>
          <button
            className={`nav-item ${view === 'settings' ? 'selected' : ''}`}
            onClick={() => navigate('settings')}
          >
            <Icon name="Settings2" />
            Workspace settings
          </button>
          <button className="nav-item" onClick={() => navigate('account')}>
            <Icon name="User" />
            Account settings
          </button>
          {account?.isAdmin && (
            <>
              <button className="nav-item" onClick={() => navigate('admin')}>
                <Icon name="Users" />
                Manage accounts
              </button>
              <button className="nav-item" onClick={() => navigate('installation')}>
                <Icon name="Server" />
                Installation settings
              </button>
            </>
          )}
          <div className="owner-label">
            <span className="owner-avatar">Y</span>
            <span>
              {account?.displayName}
              <small>@{account?.username}</small>
            </span>
            <button
              className="icon-button"
              title="Sign out"
              onClick={() =>
                void flushPendingSaves()
                  .then(() => post('auth/logout'))
                  .then(() => {
                    localStorage.setItem('forge-auth-event', String(Date.now()));
                    window.location.assign('/');
                  })
                  .catch((e) => setError(e.message))
              }
            >
              <Icon name="ExternalLink" size={15} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            Workspace <Icon name="ChevronRight" size={14} />
            <strong>
              {view === 'builder'
                ? 'Workflow builder'
                : (navigation.find((n) => n.id === view)?.title ?? 'Settings')}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="local-badge">
              <Icon name="ShieldCheck" size={14} />
              Local installation
            </span>
            <button
              className="icon-button"
              title="Setup and help"
              onClick={() => navigate('settings')}
            >
              <Icon name="CircleHelp" size={19} />
            </button>
          </div>
        </header>
        {account?.mustCompleteProfile ? (
          <main className="page-content">
            <AccountView account={account} onChanged={() => window.location.reload()} />
          </main>
        ) : !workspace && !['account', 'admin', 'installation'].includes(view) ? (
          <main className="page-content">
            <ErrorMessage message={error} />
            <Empty
              title="Create a workspace"
              text="Keep different projects in separate private workspaces."
            >
              <button className="button primary" onClick={() => setWorkspaceManager(true)}>
                Manage workspaces
              </button>
            </Empty>
          </main>
        ) : view === 'builder' && workflowId ? (
          <Builder
            readOnly={workspace?.role === 'viewer'}
            key={workflowId}
            id={workflowId}
            onBack={() => {
              navigate('workflows');
              void refresh();
            }}
            onRun={() => {
              navigate('runs');
              void refresh();
            }}
          />
        ) : (
          <main className="page-content">
            <ErrorMessage message={error} />
            {view === 'home' && (
              <>
                <div className="page-heading">
                  <div>
                    <div className="eyebrow">YOUR AUTOMATION WORKSPACE</div>
                    <h1>A little less busywork.</h1>
                    <p>Turn everyday tasks into workflows that take care of themselves.</p>
                  </div>
                  <button className="button primary" onClick={() => setNewDialog(true)}>
                    <Icon name="Plus" size={17} />
                    New workflow
                  </button>
                </div>
                <section className="create-hero">
                  <div className="hero-copy">
                    <span className="pill">
                      <Icon name="Sparkles" size={13} />
                      POWERED BY LOCAL AI
                    </span>
                    <h2>
                      What would you like
                      <br />
                      to automate?
                    </h2>
                    <p>
                      Describe an idea in your own words.
                      <br />
                      We’ll help you connect the steps.
                    </p>
                    <button className="button dark" onClick={() => setDescribe(true)}>
                      <Icon name="WandSparkles" size={17} />
                      Describe a workflow
                      <Icon name="ArrowRight" size={16} />
                    </button>
                  </div>
                  <div className="hero-visual" aria-hidden="true">
                    <div className="hero-grid" />
                    <div className="hero-workflow">
                      <div className="hero-node">
                        <StepIcon type="trigger.schedule" />
                        <span>
                          Every evening<small>8:00 PM · Your timezone</small>
                        </span>
                        <Icon name="Check" size={15} />
                      </div>
                      <div className="hero-wire" />
                      <div className="hero-node ai">
                        <StepIcon type="ai.summarize" />
                        <span>
                          Make a quick summary<small>With AI on your computer</small>
                        </span>
                        <span className="tiny-stars">✦</span>
                      </div>
                      <div className="hero-wire" />
                      <div className="hero-node">
                        <StepIcon type="telegram.send" />
                        <span>
                          Send it to me<small>Telegram · Personal chat</small>
                        </span>
                        <Icon name="Check" size={15} />
                      </div>
                    </div>
                    <div className="hero-caption">
                      <span className="health-dot online" />
                      One idea. A few simple steps.
                    </div>
                  </div>
                </section>
                <div className="metric-grid">
                  <div className="metric">
                    <span>
                      Active workflows
                      <Icon name="Workflow" size={17} />
                    </span>
                    <strong>
                      {active}
                      <small>of {workflows.length} total</small>
                    </strong>
                  </div>
                  <div className="metric">
                    <span>
                      Successful runs
                      <Icon name="CheckCircle2" size={17} />
                    </span>
                    <strong>
                      {succeeded}
                      <small>in recent history</small>
                    </strong>
                  </div>
                  <div className="metric">
                    <span>
                      Needs attention
                      <Icon name="CircleHelp" size={17} />
                    </span>
                    <strong>
                      {needsAttention}
                      <small>
                        {needsAttention ? 'Review your run history' : 'You’re all caught up'}
                      </small>
                    </strong>
                  </div>
                </div>
                <div className="section-heading">
                  <div>
                    <h2>Start with something useful</h2>
                    <p>A few ready-to-use ideas. Make them your own.</p>
                  </div>
                  <button className="text-button" onClick={() => navigate('templates')}>
                    Explore templates <Icon name="ArrowRight" size={16} />
                  </button>
                </div>
                <div className="template-grid home-templates">
                  {templates.slice(0, 3).map((t) => (
                    <TemplateCard key={t.id} template={t} onClick={() => void instantiate(t)} />
                  ))}
                </div>
                <div className="section-heading">
                  <div>
                    <h2>Your workflows</h2>
                    <p>Everything you’ve set in motion.</p>
                  </div>
                  <button className="text-button" onClick={() => navigate('workflows')}>
                    View all <Icon name="ArrowRight" size={16} />
                  </button>
                </div>
                {workflows.length ? (
                  <div className="workflow-list">
                    {workflows.slice(0, 4).map((w) => (
                      <WorkflowRow
                        key={w.id}
                        workflow={w}
                        onClick={() => navigate('builder', w.id)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="welcome-strip">
                    <span className="empty-icon">
                      <Icon name="Workflow" />
                    </span>
                    <div>
                      <strong>Your first workflow starts here</strong>
                      <p>Try a template, describe an idea, or start with a blank canvas.</p>
                    </div>
                    <button className="button secondary" onClick={() => navigate('templates')}>
                      Choose a template
                      <Icon name="ArrowRight" size={15} />
                    </button>
                  </div>
                )}
              </>
            )}
            {view === 'workflows' && (
              <>
                <div className="page-heading">
                  <div>
                    <h1>My workflows</h1>
                    <p>Small automations. More time for everything else.</p>
                  </div>
                  <div className="button-group">
                    <label className="button secondary file-button">
                      <Icon name="Upload" size={16} />
                      Import
                      <input
                        type="file"
                        accept="application/json,.json"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file)
                            void file
                              .text()
                              .then(JSON.parse)
                              .then((data) => post('workflows/import', data))
                              .then(refresh)
                              .catch((e) => setError(e.message));
                        }}
                      />
                    </label>
                    <button className="button primary" onClick={() => setNewDialog(true)}>
                      <Icon name="Plus" size={17} />
                      New workflow
                    </button>
                  </div>
                </div>
                <div className="list-toolbar">
                  <div className="search-input">
                    <Icon name="Search" size={17} />
                    <input
                      placeholder="Search your workflows…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <span className="muted">{workflows.length} workflows</span>
                </div>
                {workflows.length ? (
                  <div className="workflow-list">
                    {workflows
                      .filter((w) => w.name.toLowerCase().includes(search.toLowerCase()))
                      .map((w) => (
                        <WorkflowRow
                          key={w.id}
                          workflow={w}
                          onClick={() => navigate('builder', w.id)}
                        />
                      ))}
                  </div>
                ) : (
                  <Empty
                    title="A good place to start"
                    text="Pick a template or describe a task you’d love to stop doing manually."
                  >
                    <button className="button primary" onClick={() => navigate('templates')}>
                      Explore templates
                      <Icon name="ArrowRight" size={16} />
                    </button>
                  </Empty>
                )}
              </>
            )}
            {view === 'templates' && (
              <TemplateGallery templates={templates} onChoose={instantiate} />
            )}
            {view === 'connections' && <ConnectionsView readOnly={workspace?.role === 'viewer'} />}
            {view === 'notes' && <NotesView readOnly={workspace?.role === 'viewer'} />}
            {view === 'runs' && <RunsView />}
            {view === 'settings' &&
              (workspace?.role === 'owner' ? (
                <SettingsView />
              ) : (
                <p className="field-note">
                  Only the owner can change workspace settings or download backups. Workflow editors
                  can configure each workflow’s schedule and AI settings in the builder.
                </p>
              ))}
            {view === 'account' && account && (
              <AccountView account={account} onChanged={() => window.location.reload()} />
            )}
            {view === 'admin' && account?.isAdmin && <AdminView />}
            {view === 'installation' && account?.isAdmin && <InstallationView />}
            <footer className="page-footer">
              <Icon name="ShieldCheck" size={14} />
              <span>Built to run on your computer. Choose local or connected AI per workflow.</span>
              <span>NEURAL FORGE</span>
            </footer>
          </main>
        )}
      </div>
      {workspaceManager && (
        <WorkspaceManager
          current={workspace}
          onClose={() => setWorkspaceManager(false)}
          onChanged={() => {
            void api<Workspace[]>('workspaces')
              .then((spaces) => setWorkspace(spaces.find((w) => w.id === workspace?.id)))
              .catch((e) => setError(e.message));
          }}
        />
      )}
      {newDialog && (
        <Modal
          title="How would you like to start?"
          subtitle="There’s no wrong starting point. You can always change the steps."
          onClose={() => setNewDialog(false)}
        >
          <div className="start-options">
            <button
              onClick={() => {
                setNewDialog(false);
                setDescribe(true);
              }}
            >
              <span className="option-icon purple">
                <Icon name="WandSparkles" />
              </span>
              <span>
                <strong>Describe a workflow</strong>
                <small>Tell your selected AI provider what you have in mind</small>
              </span>
              <Icon name="ChevronRight" />
            </button>
            <button
              onClick={() => {
                setNewDialog(false);
                navigate('templates');
              }}
            >
              <span className="option-icon green">
                <Icon name="LayoutGrid" />
              </span>
              <span>
                <strong>Choose a template</strong>
                <small>Start with a working example</small>
              </span>
              <Icon name="ChevronRight" />
            </button>
            <div className="blank-start">
              <label>
                Or start from scratch
                <input
                  aria-label="Workflow name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <button className="button secondary" onClick={() => void create()}>
                Build visually
                <Icon name="ArrowRight" size={16} />
              </button>
            </div>
          </div>
        </Modal>
      )}
      {describe && (
        <DescribeDialog
          onClose={() => setDescribe(false)}
          onCreate={async (definition, title) => {
            await create(definition, title);
            setDescribe(false);
          }}
        />
      )}
    </div>
  );
}
export function TemplateCard({
  template,
  onClick,
}: {
  template: WorkflowTemplate;
  onClick: () => void;
}) {
  return (
    <button className="template-card" onClick={onClick}>
      <div className="template-card-top">
        <span className="category-label">{template.category}</span>
        <Icon name="ArrowUpRight" size={17} />
      </div>
      <h3>{template.name}</h3>
      <p>{template.description}</p>
      <div className="template-card-bottom">
        <div className="mini-apps">
          {[...new Set(template.definition.nodes.map((n) => n.type.split('.')[0]))]
            .slice(0, 3)
            .map((type) => (
              <StepIcon key={type} type={type!} small />
            ))}
          <span>{template.definition.nodes.length} steps</span>
        </div>
        <span className="easy-label">Guided setup</span>
      </div>
    </button>
  );
}
function WorkflowRow({ workflow: w, onClick }: { workflow: Workflow; onClick: () => void }) {
  return (
    <button className="workflow-row" onClick={onClick}>
      <span className="workflow-row-icon">
        <Icon name="Workflow" size={21} />
      </span>
      <span className="workflow-row-name">
        <strong>{w.name}</strong>
        <small>
          {w.draft.nodes.length} steps <span>·</span> Edited {shortDate(w.updatedAt)}
        </small>
        {w.checkpoints?.[0]?.value.error && (
          <small className="text-error">Trigger needs attention</small>
        )}
      </span>
      <span className={`workflow-state ${w.enabled ? 'enabled' : ''}`}>
        <span />
        {w.enabled ? 'Active' : 'Draft'}
      </span>
      {w.runs?.[0] && <Status status={w.runs[0].status} />}
      <Icon name="ChevronRight" size={17} />
    </button>
  );
}
