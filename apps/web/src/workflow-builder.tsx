'use client';
import { AIControls } from './ai-controls';
import { registerPendingSave } from './lib';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Connection as FlowConnection,
  type NodeProps,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ancestors } from '@forge/workflow';
import {
  type Binding,
  type Field,
  type Json,
  type ValidationIssue,
  type WorkflowNode,
} from '@forge/contracts';
import {
  api,
  download,
  post,
  pretty,
  type Connection,
  type NodeDefinition,
  type Note,
  type Workflow,
  type WorkflowDefinition,
} from './lib';
import { Empty, ErrorMessage, Icon, Loading, Modal, StepIcon } from './ui';
import { DescribeDialog } from './workflow-create';

type FlowNode = Node<{ label: string; type: string; issue: boolean }, 'step'>;
function FlowStep({ data, selected }: NodeProps<FlowNode>) {
  return (
    <div className={`flow-step ${selected ? 'selected' : ''} ${data.issue ? 'has-issue' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <StepIcon type={data.type} />
      <span>
        <small>{data.type.split('.')[0]}</small>
        <strong>{data.label}</strong>
      </span>
      {data.type === 'logic.condition' ? (
        <>
          <Handle id="true" type="source" position={Position.Right} style={{ top: '30%' }} />
          <Handle id="false" type="source" position={Position.Right} style={{ top: '75%' }} />
          <small className="branch-label">yes / no</small>
        </>
      ) : (
        <Handle type="source" position={Position.Right} id="out" />
      )}
    </div>
  );
}
const nodeTypes = { step: FlowStep };
const initialInput = {
  text: 'We discussed the launch. Maya will finish the design by Friday. Arun will test signup. Our next meeting is Monday.',
};

export function Builder({
  id,
  onBack,
  onRun,
  readOnly = false,
}: {
  id: string;
  onBack: () => void;
  onRun: () => void;
  readOnly?: boolean;
}) {
  const [workflow, setWorkflow] = useState<Workflow>();
  const [graph, setGraph] = useState<WorkflowDefinition>();
  const [name, setName] = useState('');
  const [catalog, setCatalog] = useState<NodeDefinition[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState<'steps' | 'canvas'>('steps');
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState('Saved');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [add, setAdd] = useState(false);
  const [query, setQuery] = useState('');
  const [describe, setDescribe] = useState(false);
  const [confirm, setConfirm] = useState<'run' | 'preview' | 'enable'>();
  const [input, setInput] = useState(pretty(initialInput));
  const [busy, setBusy] = useState(false);
  const [webhook, setWebhook] = useState('');
  const graphRef = useRef(graph);
  const nameRef = useRef(name);
  const revision = useRef(0);
  const saved = useRef('');
  const saving = useRef<Promise<void> | null>(null);
  const [undo, setUndo] = useState<WorkflowDefinition[]>([]);
  const [redo, setRedo] = useState<WorkflowDefinition[]>([]);
  graphRef.current = graph;
  nameRef.current = name;
  useEffect(() => {
    void Promise.all([
      api<Workflow>(`workflows/${id}`),
      api<NodeDefinition[]>('catalog'),
      api<Connection[]>('connections'),
      api<Note[]>('notes'),
    ])
      .then(([w, c, con, n]) => {
        setWorkflow(w);
        setGraph(w.draft);
        setName(w.name);
        setCatalog(c);
        setConnections(con);
        setNotes(n);
        setSelected(w.draft.nodes[0]?.id ?? '');
        if (w.draft.nodes.some((n) => n.type === 'data.csv.parse'))
          setInput(pretty({ text: 'message\nPlease send the invoice\nLunch tomorrow?' }));
        if (w.draft.nodes.some((n) => n.type === 'trigger.webhook'))
          setInput(pretty({ body: { name: 'Alex', email: 'alex@example.com', message: 'Hello' } }));
        revision.current = w.revision;
        saved.current = JSON.stringify({ name: w.name, definition: w.draft });
      })
      .catch((e) => setError(e.message));
  }, [id, readOnly]);
  const save = useCallback(async () => {
    if (saving.current) await saving.current;
    const definition = graphRef.current;
    if (!definition) return;
    const snapshot = JSON.stringify({ name: nameRef.current, definition });
    if (readOnly || snapshot === saved.current) return;
    setSaveState('Saving…');
    const work = api<{ revision: number }>(`workflows/${id}`, {
      method: 'PATCH',
      body: { name: nameRef.current, definition, revision: revision.current },
    })
      .then((result) => {
        revision.current = result.revision;
        saved.current = snapshot;
        setSaveState('Saved');
      })
      .catch((e) => {
        setSaveState('Save failed');
        setError(e.message);
        throw e;
      });
    saving.current = work;
    try {
      await work;
    } finally {
      saving.current = null;
    }
  }, [id]);
  useEffect(() => registerPendingSave(save), [save]);
  useEffect(() => {
    if (!graph) return;
    if (JSON.stringify({ name, definition: graph }) !== saved.current)
      setSaveState('Unsaved changes');
    const timer = setTimeout(() => {
      void save().catch(() => {});
    }, 1000);
    return () => clearTimeout(timer);
  }, [graph, name, save]);
  useEffect(
    () => () => {
      void save().catch(() => {});
    },
    [save],
  );
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => {
      if (JSON.stringify({ name: nameRef.current, definition: graphRef.current }) !== saved.current)
        e.preventDefault();
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, []);
  function change(next: WorkflowDefinition, history = true) {
    if (readOnly) return;
    if (graph && history) {
      setUndo((old) => [...old.slice(-49), structuredClone(graph)]);
      setRedo([]);
    }
    setGraph(next);
    setIssues([]);
  }
  function updateNode(next: WorkflowNode) {
    if (graph)
      change({
        ...graph,
        ...(next.type === 'trigger.schedule' && next.config.timezone
          ? { settings: { ...graph.settings, timezone: String(next.config.timezone) } }
          : {}),
        nodes: graph.nodes.map((n) => (n.id === next.id ? next : n)),
      });
  }
  function addNode(type: string) {
    if (!graph) return;
    const meta = catalog.find((n) => n.type === type)!;
    const nodeId = `step_${crypto.randomUUID().slice(0, 8)}`;
    const previous = graph.nodes.at(-1);
    const next: WorkflowNode = {
      id: nodeId,
      type,
      version: 1,
      label: meta.label,
      config: Object.fromEntries(
        meta.fields
          .filter((f) => f.target === 'config' && f.default !== undefined)
          .map((f) => [f.key, structuredClone(f.default!)]),
      ),
      inputs: {},
      position: { x: (previous?.position?.x ?? 80) + 300, y: previous?.position?.y ?? 120 },
    };
    change({
      ...graph,
      nodes: [...graph.nodes, next],
      edges: previous
        ? [
            ...graph.edges,
            {
              id: crypto.randomUUID(),
              source: previous.id,
              sourcePort: previous.type === 'logic.condition' ? 'true' : 'out',
              target: nodeId,
              targetPort: 'in',
            },
          ]
        : graph.edges,
    });
    setSelected(nodeId);
    setAdd(false);
  }
  async function validate() {
    try {
      const result = await post<{ issues: ValidationIssue[] }>(`workflows/${id}/validate`, {
        definition: graph,
      });
      setIssues(result.issues);
      if (result.issues[0]?.nodeId) setSelected(result.issues[0].nodeId);
      return result.issues;
    } catch (e) {
      setError((e as Error).message);
      return [{ message: 'Validation failed.' }];
    }
  }
  async function execute() {
    setBusy(true);
    setError('');
    try {
      await save();
      if (confirm === 'enable') {
        const result = await post(`workflows/${id}/enable`, { revision: revision.current });
        if (!result.ok) {
          setIssues(result.issues);
          setConfirm(undefined);
          return;
        }
        setWorkflow((w) => (w ? { ...w, enabled: true } : w));
        if (graph?.nodes.some((n) => n.type === 'trigger.webhook')) setWebhook(result.webhookToken);
      } else {
        const result = await post(`workflows/${id}/runs`, {
          preview: confirm === 'preview',
          input: JSON.parse(input),
        });
        if (result.issues) {
          setIssues(result.issues);
          setConfirm(undefined);
          return;
        }
        onRun();
      }
      setConfirm(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const selectedNode = graph?.nodes.find((n) => n.id === selected);
  const definition = catalog.find((n) => n.type === selectedNode?.type);
  const nodes: FlowNode[] = useMemo(
    () =>
      graph?.nodes.map((n, i) => ({
        id: n.id,
        type: 'step' as const,
        position: n.position ?? { x: i * 300 + 80, y: 120 },
        data: {
          label: n.label,
          type: n.type,
          issue: issues.some((issue) => issue.nodeId === n.id),
        },
        selected: n.id === selected,
      })) ?? [],
    [graph, selected, issues],
  );
  if (!graph || !workflow)
    return error ? <ErrorMessage message={error} /> : <Loading text="Opening your workflow…" />;
  if (readOnly)
    return (
      <div className="builder">
        <header className="builder-heading">
          <button className="button secondary" onClick={onBack}>
            Back to workflows
          </button>
          <h1>{workflow.name}</h1>
        </header>
        <p className="field-note">
          Viewer access · you can inspect this workflow and its run history. Ask the owner for
          editor access to make changes or run it.
        </p>
        <div className="guided-steps">
          {graph.nodes.map((node, i) => (
            <section className="settings-card" key={node.id}>
              <h3>
                {i + 1}. {node.label}
              </h3>
              <p>{catalog.find((n) => n.type === node.type)?.description}</p>
              <details>
                <summary>Step configuration and inputs</summary>
                <pre>{pretty({ config: node.config, inputs: node.inputs })}</pre>
              </details>
            </section>
          ))}
        </div>
        <details className="technical-details">
          <summary>Workflow definition</summary>
          <pre>{pretty(graph)}</pre>
        </details>
      </div>
    );
  const destinations = graph.nodes.filter(
    (n) => catalog.find((d) => d.type === n.type)?.effect === 'write',
  );
  return (
    <div className="builder">
      <header className="builder-heading">
        <button
          className="icon-button"
          aria-label="Back to workflows"
          onClick={() =>
            void save()
              .then(onBack)
              .catch(() => {})
          }
        >
          <Icon name="ArrowRight" className="back-arrow" />
        </button>
        <div className="builder-title">
          <input
            aria-label="Workflow name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <span>
            <span className={`health-dot ${saveState === 'Saved' ? 'online' : ''}`} />
            {saveState}
            <span>·</span>
            {workflow.enabled ? 'Active version + editable draft' : 'Draft'}
          </span>
        </div>
        <div className="button-group">
          <button className="button secondary compact" onClick={() => setDescribe(true)}>
            <Icon name="Sparkles" size={15} />
            Ask AI
          </button>
          <button
            className="button secondary compact"
            onClick={() => {
              setConfirm('preview');
              setError('');
            }}
          >
            <Icon name="Play" size={15} />
            Preview
          </button>
          <button
            className="button primary compact"
            onClick={() => {
              setConfirm('run');
              setError('');
            }}
          >
            <Icon name="Play" size={15} />
            Run now
          </button>
          {workflow.enabled ? (
            <button
              className="button secondary compact"
              onClick={() =>
                void post(`workflows/${id}/disable`).then(() =>
                  setWorkflow({ ...workflow, enabled: false }),
                )
              }
            >
              Disable
            </button>
          ) : (
            <button
              className="button dark compact"
              onClick={() => {
                setConfirm('enable');
                setError('');
              }}
            >
              Enable
              <Icon name="Zap" size={14} />
            </button>
          )}
        </div>
      </header>
      <details className="workflow-preferences">
        <summary>Workflow settings · timezone and AI</summary>
        <label>
          Workflow timezone
          <input
            aria-label="Workflow timezone"
            disabled={readOnly}
            value={graph.settings.timezone}
            onChange={(e) =>
              change({
                ...graph,
                settings: { ...graph.settings, timezone: e.target.value },
                nodes: graph.nodes.map((n) =>
                  n.type === 'trigger.schedule'
                    ? { ...n, config: { ...n.config, timezone: e.target.value } }
                    : n,
                ),
              })
            }
          />
        </label>
        <AIControls
          value={graph.settings.ai}
          readOnly={readOnly}
          onChange={(ai) => change({ ...graph, settings: { ...graph.settings, ai } })}
        />
      </details>

      <div className="builder-toolbar">
        <div className="segmented">
          <button className={mode === 'steps' ? 'active' : ''} onClick={() => setMode('steps')}>
            <Icon name="List" size={15} />
            Guided steps
          </button>
          <button className={mode === 'canvas' ? 'active' : ''} onClick={() => setMode('canvas')}>
            <Icon name="Workflow" size={15} />
            Canvas
          </button>
        </div>
        <div className="toolbar-actions">
          <button
            className="icon-button"
            aria-label="Undo"
            disabled={!undo.length}
            onClick={() => {
              const previous = undo.at(-1);
              if (previous) {
                setRedo((r) => [...r, graph]);
                setGraph(previous);
                setUndo((u) => u.slice(0, -1));
              }
            }}
          >
            <Icon name="Undo2" size={16} />
          </button>
          <button
            className="icon-button redo-button"
            aria-label="Redo"
            disabled={!redo.length}
            onClick={() => {
              const next = redo.at(-1);
              if (next) {
                setUndo((u) => [...u, graph]);
                setGraph(next);
                setRedo((r) => r.slice(0, -1));
              }
            }}
          >
            <Icon name="Undo2" size={16} />
          </button>
          <span className="toolbar-divider" />
          <button className="text-button" onClick={() => void validate()}>
            <Icon name="CheckCircle2" size={15} />
            Check setup
          </button>
          <button
            className="icon-button"
            title="Export workflow"
            onClick={() =>
              void save()
                .then(() => api(`workflows/${id}/export`))
                .then((data) => download(`${name}.json`, data))
                .catch((e) => setError(e.message))
            }
          >
            <Icon name="Download" size={16} />
          </button>
        </div>
      </div>
      {error && (
        <div className="builder-notice">
          <ErrorMessage message={error} />
        </div>
      )}
      {issues.length > 0 && (
        <div className="validation-banner">
          <Icon name="CircleHelp" size={17} />
          <span>
            {issues.length} {issues.length === 1 ? 'detail needs' : 'details need'} your attention.
          </span>
          <button className="text-button" onClick={() => setIssues([])}>
            Dismiss
          </button>
        </div>
      )}
      <div className="builder-body">
        <section className="builder-workspace">
          {mode === 'steps' ? (
            <div className="guided-view">
              <div className="guided-intro">
                <span className="eyebrow">ONE STEP AT A TIME</span>
                <h2>Here’s how your workflow works.</h2>
                <p>Choose a step to fill in its details. Add more as you go.</p>
              </div>
              <div className="guided-steps">
                {graph.nodes.map((node, index) => (
                  <div className="guided-step-wrap" key={node.id}>
                    <button
                      className={`guided-step ${selected === node.id ? 'selected' : ''}`}
                      onClick={() => setSelected(node.id)}
                    >
                      <span className="step-number">{index + 1}</span>
                      <StepIcon type={node.type} />
                      <span className="guided-step-title">
                        <strong>{node.label}</strong>
                        <small>{catalog.find((d) => d.type === node.type)?.description}</small>
                      </span>
                      {issues.some((i) => i.nodeId === node.id) ? (
                        <span className="needs-setup">Needs setup</span>
                      ) : (
                        <Icon name="ChevronRight" size={17} />
                      )}
                    </button>
                    {index < graph.nodes.length - 1 && (
                      <div className="guided-connector">
                        <Icon name="ArrowDown" size={15} />
                        <small>
                          {graph.edges.filter((e) => e.source === node.id).length > 1
                            ? 'Parallel branches · see canvas'
                            : node.type === 'logic.condition'
                              ? 'Conditional branch · see canvas'
                              : ''}
                        </small>
                      </div>
                    )}
                  </div>
                ))}
                <button
                  className="add-step-button"
                  onClick={() => {
                    setQuery('');
                    setAdd(true);
                  }}
                >
                  <Icon name="Plus" size={19} />
                  Add a step
                </button>
              </div>
              <div className="guided-tip">
                <Icon name="CircleHelp" size={16} />
                Your workflow stays a draft until you enable it. Preview is a good place to start.
              </div>
            </div>
          ) : (
            <div className="canvas-wrap">
              <ReactFlow<FlowNode>
                nodes={nodes}
                edges={graph.edges.map((e) => ({
                  id: e.id,
                  source: e.source,
                  target: e.target,
                  sourceHandle: e.sourcePort,
                  animated: false,
                  label:
                    e.sourcePort === 'out' ? undefined : e.sourcePort === 'true' ? 'Yes' : 'No',
                  style: { stroke: '#a6b7ae', strokeWidth: 2 },
                }))}
                nodeTypes={nodeTypes}
                onNodeClick={(_, node) => setSelected(node.id)}
                onNodeDragStop={(_, node) =>
                  change({
                    ...graph,
                    nodes: graph.nodes.map((n) =>
                      n.id === node.id ? { ...n, position: node.position } : n,
                    ),
                  })
                }
                onConnect={(connection: FlowConnection) =>
                  change({
                    ...graph,
                    edges: [
                      ...graph.edges,
                      {
                        id: crypto.randomUUID(),
                        source: connection.source,
                        target: connection.target,
                        sourcePort: (connection.sourceHandle ?? 'out') as 'out',
                        targetPort: 'in',
                      },
                    ],
                  })
                }
                onEdgesDelete={(edges) =>
                  change({
                    ...graph,
                    edges: graph.edges.filter((e) => !edges.some((x) => x.id === e.id)),
                  })
                }
                fitView
                minZoom={0.3}
                maxZoom={1.5}
              >
                <Background color="#d9dedb" gap={22} />
                <Controls />
              </ReactFlow>
              <button
                className="button primary canvas-add"
                onClick={() => {
                  setQuery('');
                  setAdd(true);
                }}
              >
                <Icon name="Plus" size={17} />
                Add step
              </button>
            </div>
          )}
        </section>
        <aside className="step-panel">
          {selectedNode && definition ? (
            <>
              <div className="step-panel-heading">
                <StepIcon type={selectedNode.type} />
                <div>
                  <span>{definition.category} step</span>
                  <h3>{definition.label}</h3>
                </div>
              </div>
              <div className="panel-tabs">
                <span className="active">Setup</span>
                <span>Input & output</span>
              </div>
              <div className="step-fields">
                {selectedNode.type.startsWith('trigger.') && (
                  <label>
                    When should this start?
                    <select
                      aria-label="Starting trigger"
                      value={selectedNode.type}
                      onChange={(e) => {
                        const meta = catalog.find((d) => d.type === e.target.value)!;
                        updateNode({
                          ...selectedNode,
                          type: meta.type,
                          label: meta.label,
                          config: Object.fromEntries(
                            meta.fields
                              .filter((f) => f.target === 'config' && f.default !== undefined)
                              .map((f) => [
                                f.key,
                                f.key === 'timezone'
                                  ? graph.settings.timezone
                                  : structuredClone(f.default!),
                              ]),
                          ),
                          inputs: {},
                        });
                      }}
                    >
                      {catalog
                        .filter((d) => d.category === 'trigger')
                        .map((d) => (
                          <option key={d.type} value={d.type}>
                            {d.label}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <label>
                  Step name
                  <input
                    value={selectedNode.label}
                    onChange={(e) => updateNode({ ...selectedNode, label: e.target.value })}
                  />
                </label>
                {definition.fields.map((field) => (
                  <NodeField
                    key={`${selectedNode.id}-${field.key}`}
                    field={field}
                    node={selectedNode}
                    definition={definition}
                    graph={graph}
                    catalog={catalog}
                    connections={connections}
                    notes={notes}
                    update={updateNode}
                  />
                ))}
                {!definition.fields.length && (
                  <div className="field-note">
                    <Icon name="CheckCircle2" size={17} />
                    <p>
                      {selectedNode.type === 'trigger.manual'
                        ? 'Ready to go. Add your sample input when you preview or run the workflow.'
                        : selectedNode.type === 'trigger.webhook'
                          ? 'Enable this workflow to get its private webhook URL and token.'
                          : 'This step needs no additional settings.'}
                    </p>
                  </div>
                )}
                {issues
                  .filter((i) => i.nodeId === selected)
                  .map((issue, i) => (
                    <ErrorMessage key={i} message={issue.message} />
                  ))}
                <details className="output-preview">
                  <summary>Available output fields</summary>
                  <div className="data-chips">
                    {definition.outputs.map((key) => (
                      <span key={key}>{key}</span>
                    ))}
                  </div>
                  <p className="muted">
                    These fields become available to later steps. Actual values appear in run
                    history.
                  </p>
                </details>
                <div className="step-actions">
                  <button
                    className="text-button"
                    onClick={() => {
                      const copy = {
                        ...structuredClone(selectedNode),
                        id: `step_${crypto.randomUUID().slice(0, 8)}`,
                        label: `${selectedNode.label} (copy)`,
                        position: {
                          x: (selectedNode.position?.x ?? 0) + 300,
                          y: (selectedNode.position?.y ?? 0) + 120,
                        },
                      };
                      change({ ...graph, nodes: [...graph.nodes, copy] });
                      setSelected(copy.id);
                    }}
                  >
                    <Icon name="Copy" size={15} />
                    Duplicate step
                  </button>
                  <button
                    className="text-button danger"
                    onClick={() => {
                      change({
                        ...graph,
                        nodes: graph.nodes.filter((n) => n.id !== selected),
                        edges: graph.edges.filter(
                          (e) => e.source !== selected && e.target !== selected,
                        ),
                      });
                      setSelected(graph.nodes.find((n) => n.id !== selected)?.id ?? '');
                    }}
                  >
                    <Icon name="Trash2" size={15} />
                    Remove
                  </button>
                </div>
              </div>
            </>
          ) : (
            <Empty
              title="Choose a step"
              text="Select a step to see what it does and fill in its settings."
            />
          )}
        </aside>
      </div>
      {add && (
        <Modal
          title="What should happen next?"
          subtitle="Choose an action. We’ll guide you through the details."
          onClose={() => setAdd(false)}
        >
          <div className="node-picker">
            <div className="search-input">
              <Icon name="Search" size={16} />
              <input
                autoFocus
                placeholder="Search steps, tasks, or apps…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="node-picker-list">
              {catalog
                .filter(
                  (n) =>
                    (!graph.nodes.some((x) => x.type.startsWith('trigger.')) ||
                      n.category !== 'trigger') &&
                    `${n.label} ${n.type}`.toLowerCase().includes(query.toLowerCase()),
                )
                .map((n) => (
                  <button key={n.type} onClick={() => addNode(n.type)}>
                    <StepIcon type={n.type} />
                    <span>
                      <strong>{n.label}</strong>
                      <small>{n.category}</small>
                    </span>
                    <Icon name="Plus" size={16} />
                  </button>
                ))}
            </div>
          </div>
        </Modal>
      )}
      {describe && (
        <DescribeDialog
          existing={graph}
          onClose={() => setDescribe(false)}
          onCreate={async (next) => {
            change(next);
            setDescribe(false);
          }}
        />
      )}
      {confirm && (
        <Modal
          title={
            confirm === 'enable'
              ? 'Ready to put this workflow to work?'
              : confirm === 'preview'
                ? 'Try it with sample data'
                : 'Run this workflow now?'
          }
          subtitle={
            confirm === 'preview'
              ? 'AI and reads can run. Writes and sends are simulated and clearly marked.'
              : confirm === 'enable'
                ? 'Future trigger events will run automatically using this version.'
                : 'This will perform real operations using the saved draft.'
          }
          onClose={() => setConfirm(undefined)}
        >
          <div className="run-confirm">
            {confirm !== 'enable' && <RunInput graph={graph} value={input} onChange={setInput} />}
            {confirm === 'enable' && (
              <div className="field-note">
                <Icon name="CalendarClock" />
                <div>
                  <strong>{graph.nodes.find((n) => n.type.startsWith('trigger.'))?.label}</strong>
                  <p>
                    {workflow.nextRun
                      ? `Next scheduled time: ${new Date(workflow.nextRun).toLocaleString()}`
                      : `Timezone: ${graph.settings.timezone}`}
                  </p>
                </div>
              </div>
            )}
            <h4>
              {destinations.length
                ? 'This workflow can make these changes'
                : 'This workflow reads and processes information'}
            </h4>
            {destinations.map((n) => (
              <div className="destination" key={n.id}>
                <StepIcon type={n.type} small />
                <span>
                  {n.label}
                  <small>
                    {String(n.config.to ?? n.config.chatId ?? n.config.spreadsheetId ?? '') ||
                      connections.find((c) => c.id === n.config.connectionId)?.name ||
                      'Your local workspace'}
                  </small>
                </span>
              </div>
            ))}
            <ErrorMessage message={error} />
            <div className="modal-actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => setConfirm(undefined)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy} onClick={() => void execute()}>
                <Icon
                  name={busy ? 'LoaderCircle' : confirm === 'enable' ? 'Zap' : 'Play'}
                  className={busy ? 'spin' : ''}
                  size={16}
                />
                {confirm === 'enable'
                  ? 'Enable workflow'
                  : confirm === 'preview'
                    ? 'Start preview'
                    : 'Run now'}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {webhook && (
        <Modal
          title="Your webhook is ready"
          subtitle="Save this token now. It is shown only once."
          onClose={() => setWebhook('')}
        >
          <div className="run-confirm">
            <label>
              Local URL
              <input readOnly value={`${window.location.origin}/api/v1/hooks/${id}`} />
            </label>
            <label>
              Authorization header
              <textarea readOnly value={`Bearer ${webhook}`} rows={2} />
            </label>
            <p className="muted">
              Send JSON with this Authorization header. External services cannot reach this local
              URL without additional hosting.
            </p>
            <button className="button primary" onClick={() => setWebhook('')}>
              Saved it
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function NodeField({
  field,
  node,
  definition,
  graph,
  catalog,
  connections,
  notes,
  update,
}: {
  field: Field;
  node: WorkflowNode;
  definition: NodeDefinition;
  graph: WorkflowDefinition;
  catalog: NodeDefinition[];
  connections: Connection[];
  notes: Note[];
  update: (node: WorkflowNode) => void;
}) {
  const binding = node.inputs[field.key];
  const value =
    field.target === 'config'
      ? node.config[field.key]
      : binding?.kind === 'constant'
        ? binding.value
        : undefined;
  const [mapping, setMapping] = useState(binding?.kind === 'reference');
  const [advanced, setAdvanced] = useState(false);
  const [resources, setResources] = useState<{ id: string; name: string }[]>([]);
  const [resourceError, setResourceError] = useState('');
  const [jsonText, setJsonText] = useState(pretty(value ?? (field.kind === 'json' ? {} : '')));
  const [invalid, setInvalid] = useState('');
  useEffect(() => {
    setJsonText(pretty(value ?? {}));
    setInvalid('');
  }, [value]);
  function setValue(next: Json) {
    update(
      field.target === 'config'
        ? { ...node, config: { ...node.config, [field.key]: next } }
        : { ...node, inputs: { ...node.inputs, [field.key]: { kind: 'constant', value: next } } },
    );
  }
  function setBinding(next: Binding) {
    update({ ...node, inputs: { ...node.inputs, [field.key]: next } });
  }
  const prior = ancestors(graph, node.id);
  const choices = [
    ...graph.nodes
      .filter((n) => prior.has(n.id))
      .flatMap((n) =>
        (catalog.find((d) => d.type === n.type)?.outputs ?? []).map((key) => ({
          nodeId: n.id,
          path: key,
          label: `${n.label} → ${key}`,
        })),
      ),
    ...['text', 'body', 'items', 'id', 'item', 'index'].map((key) => ({
      nodeId: '$input',
      path: key,
      label: `Workflow input → ${key}`,
    })),
  ];
  if (field.advanced && !advanced)
    return (
      <button className="text-button advanced-field" onClick={() => setAdvanced(true)}>
        Advanced: {field.label}
        <Icon name="ChevronDown" size={13} />
      </button>
    );
  let control;
  if (mapping && field.target === 'inputs')
    control = (
      <>
        <select
          aria-label={field.label}
          value={binding?.kind === 'reference' ? `${binding.nodeId}|${binding.path}` : ''}
          onChange={(e) => {
            const [nodeId, path] = e.target.value.split('|');
            if (nodeId) setBinding({ kind: 'reference', nodeId, path: path ?? '', format: 'none' });
          }}
        >
          <option value="">Choose an earlier output…</option>
          {choices.map((c) => (
            <option key={`${c.nodeId}|${c.path}`} value={`${c.nodeId}|${c.path}`}>
              {c.label}
            </option>
          ))}
        </select>
        {binding?.kind === 'reference' && (
          <>
            <input
              aria-label="Output field path"
              placeholder="Field path, e.g. data.name"
              value={binding.path}
              onChange={(e) => setBinding({ ...binding, path: e.target.value })}
            />
            <select
              aria-label="Format mapped value"
              value={binding.format}
              onChange={(e) => setBinding({ ...binding, format: e.target.value as any })}
            >
              {['none', 'text', 'upper', 'lower', 'json', 'date'].map((format) => (
                <option key={format}>{format}</option>
              ))}
            </select>
          </>
        )}
      </>
    );
  else if (field.kind === 'connection')
    control = (
      <select
        aria-label={field.label}
        value={String(value ?? '')}
        onChange={(e) => setValue(e.target.value)}
      >
        <option value="">Choose an account…</option>
        {connections
          .filter(
            (c) =>
              c.kind ===
                (node.type.startsWith('ai.')
                  ? node.config.provider || graph.settings.ai?.provider
                  : definition.connectionKind) &&
              (!c.apps ||
                c.apps.includes(
                  node.type.startsWith('trigger.')
                    ? node.type.split('.')[1]!
                    : node.type.split('.')[0]!,
                )),
          )
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.status})
            </option>
          ))}
      </select>
    );
  else if (field.kind === 'resource')
    control = (
      <div className="resource-control">
        <select
          aria-label={field.label}
          value={String(value ?? '')}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="">Choose {field.label.toLowerCase()}</option>
          {value && !resources.some((r) => String(r.id) === String(value)) && (
            <option value={String(value)}>{String(value)}</option>
          )}
          {resources.map((r) => (
            <option key={r.id} value={String(r.id)}>
              {r.name}
            </option>
          ))}
        </select>
        <button
          className="text-button"
          type="button"
          disabled={!node.config.connectionId}
          onClick={() =>
            void api<any[]>(
              `connections/${node.config.connectionId}/resources?kind=${field.resourceKind}${field.resourceParent ? `&value=${encodeURIComponent(String(node.config[field.resourceParent] ?? ''))}` : ''}`,
            )
              .then(setResources)
              .then(() => setResourceError(''))
              .catch((e) => setResourceError(e.message))
          }
        >
          Load choices
        </button>
        <ErrorMessage message={resourceError} />
      </div>
    );
  else if (field.kind === 'note')
    control = (
      <select
        aria-label={field.label}
        value={String(value ?? '')}
        onChange={(e) => setValue(e.target.value)}
      >
        <option value="">Choose a note…</option>
        {notes.map((n) => (
          <option key={n.id} value={n.id}>
            {n.title}
          </option>
        ))}
      </select>
    );
  else if (field.kind === 'select')
    control = (
      <select
        aria-label={field.label}
        value={String(value ?? field.default ?? '')}
        onChange={(e) => setValue(e.target.value)}
      >
        {field.options?.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    );
  else if (field.kind === 'boolean')
    control = (
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => setValue(e.target.checked)}
        />
        {field.key === 'includeAutomated'
          ? 'Include notes created or edited by workflows'
          : 'Allow this workflow to access trusted local destinations'}
      </label>
    );
  else if (
    field.key === 'body' &&
    node.type === 'logic.foreach' &&
    value &&
    typeof value === 'object'
  )
    control = (
      <ListBodyEditor
        body={value as unknown as WorkflowDefinition}
        catalog={catalog}
        connections={connections}
        notes={notes}
        onChange={(next) => setValue(next as unknown as Json)}
      />
    );
  else if (field.kind === 'json')
    control = (
      <>
        <textarea
          className="code-input"
          rows={field.key === 'body' ? 10 : 4}
          value={jsonText}
          onChange={(e) => {
            setJsonText(e.target.value);
            try {
              const next = JSON.parse(e.target.value);
              setInvalid('');
              setValue(next);
            } catch {
              setInvalid('Enter valid JSON to save this field.');
            }
          }}
        />
        <ErrorMessage message={invalid} />
      </>
    );
  else if (field.kind === 'textarea')
    control = (
      <textarea
        rows={4}
        aria-label={field.label}
        value={String(value ?? '')}
        onChange={(e) => setValue(e.target.value)}
      />
    );
  else
    control = (
      <input
        aria-label={field.label}
        type={field.kind === 'number' ? 'number' : 'text'}
        value={String(value ?? '')}
        placeholder={
          field.key === 'cron'
            ? '0 20 * * *'
            : field.key === 'spreadsheetId'
              ? 'Paste your spreadsheet URL'
              : ''
        }
        onChange={(e) =>
          setValue(field.kind === 'number' ? Number(e.target.value) : e.target.value)
        }
      />
    );
  return (
    <div className="field-wrap">
      <label>
        <span className="field-label">
          {field.label}
          {field.required && <span className="required">*</span>}
          {field.target === 'inputs' && (
            <button
              type="button"
              className={`mapping-toggle ${mapping ? 'active' : ''}`}
              onClick={() => setMapping(!mapping)}
            >
              <Icon name="Link2" size={12} />
              {mapping ? 'Use a value' : 'Use earlier data'}
            </button>
          )}
        </span>
        {control}
      </label>
      {field.help && <small>{field.help}</small>}
      {field.kind === 'connection' && (
        <small>Connect an account from the Connections screen first.</small>
      )}
      {field.key === 'cron' && (
        <div className="schedule-presets">
          {[
            ['Every day at 8 PM', '0 20 * * *'],
            ['Every hour', '0 * * * *'],
            ['Weekdays at 9 AM', '0 9 * * 1-5'],
          ].map(([label, cron]) => (
            <button key={cron} onClick={() => setValue(cron!)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {field.key === 'chatId' && node.config.connectionId && (
        <>
          <button
            className="text-button"
            onClick={() =>
              void api<any[]>(`connections/${node.config.connectionId}/resources?kind=chats`)
                .then(setResources)
                .catch((e) => setResourceError(e.message))
            }
          >
            Find my Telegram chats
          </button>
          {resources.map((r) => (
            <button className="data-chip" key={r.id} onClick={() => setValue(r.id)}>
              {r.name}
            </button>
          ))}
          <small>Send a message to your bot first so your chat can be discovered.</small>
          <ErrorMessage message={resourceError} />
        </>
      )}
      {field.key === 'range' && node.config.connectionId && node.config.spreadsheetId && (
        <>
          <button
            className="text-button"
            onClick={() =>
              void api<any[]>(
                `connections/${node.config.connectionId}/resources?kind=tabs&value=${encodeURIComponent(String(node.config.spreadsheetId))}`,
              )
                .then(setResources)
                .catch((e) => setResourceError(e.message))
            }
          >
            Find spreadsheet tabs
          </button>
          {resources.map((r) => (
            <button
              key={r.id}
              className="data-chip"
              onClick={() => setValue(`'${r.name.replaceAll("'", "''")}'!A:Z`)}
            >
              {r.name}
            </button>
          ))}
          <ErrorMessage message={resourceError} />
        </>
      )}
    </div>
  );
}

function RunInput({
  graph,
  value,
  onChange,
}: {
  graph: WorkflowDefinition;
  value: string;
  onChange: (value: string) => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  let input: Record<string, any> = {};
  try {
    input = JSON.parse(value);
  } catch {}
  const keys = [
    ...new Set(
      graph.nodes.flatMap((n) =>
        Object.values(n.inputs)
          .filter((b) => b.kind === 'reference' && b.nodeId === '$input')
          .map((b) => (b.kind === 'reference' ? b.path.split('.')[0]! : 'text')),
      ),
    ),
  ];
  if (!keys.length) keys.push('text');
  return (
    <div className="run-input-fields">
      {keys.map((key) => (
        <label key={key}>
          {key === 'text'
            ? 'Text to process'
            : key === 'items'
              ? 'Items to process (one per line)'
              : key === 'body'
                ? 'Example submission'
                : key[0]!.toUpperCase() + key.slice(1)}
          {key === 'body' && typeof input[key] === 'object' && input[key] ? (
            <div className="submission-fields">
              {Object.entries(input[key]).map(([field, text]) => (
                <label key={field}>
                  {field}
                  <input
                    value={String(text)}
                    onChange={(e) =>
                      onChange(
                        pretty({ ...input, [key]: { ...input[key], [field]: e.target.value } }),
                      )
                    }
                  />
                </label>
              ))}
            </div>
          ) : (
            <textarea
              aria-label={key === 'text' ? 'Text to process' : key}
              rows={key === 'text' ? 7 : 3}
              value={Array.isArray(input[key]) ? input[key].join('\n') : String(input[key] ?? '')}
              onChange={(e) =>
                onChange(
                  pretty({
                    ...input,
                    [key]:
                      key === 'items' ? e.target.value.split('\n').filter(Boolean) : e.target.value,
                  }),
                )
              }
            />
          )}
        </label>
      ))}
      <button className="text-button" onClick={() => setAdvanced(!advanced)}>
        Advanced input
        <Icon name="ChevronDown" size={12} />
      </button>
      {advanced && (
        <label>
          Structured input
          <textarea
            className="code-input"
            rows={7}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      )}
    </div>
  );
}

function ListBodyEditor({
  body,
  catalog,
  connections,
  notes,
  onChange,
}: {
  body: WorkflowDefinition;
  catalog: NodeDefinition[];
  connections: Connection[];
  notes: Note[];
  onChange: (next: WorkflowDefinition) => void;
}) {
  const [selected, setSelected] = useState(
    body.nodes.find((n) => !n.type.startsWith('trigger.'))?.id ?? '',
  );
  const current = body.nodes.find((n) => n.id === selected);
  const definition = catalog.find((n) => n.type === current?.type);
  return (
    <div className="list-body-editor">
      <p>
        These steps run once for each item. Use <strong>Workflow input → item</strong> to access the
        current item.
      </p>
      <div className="list-body-tabs">
        {body.nodes
          .filter((n) => !n.type.startsWith('trigger.'))
          .map((n, i) => (
            <button
              key={n.id}
              className={selected === n.id ? 'active' : ''}
              onClick={() => setSelected(n.id)}
            >
              {i + 1}. {n.label}
            </button>
          ))}
      </div>
      {current && definition && (
        <div className="list-body-fields">
          {definition.fields
            .filter((f) => f.key !== 'body')
            .map((field) => (
              <NodeField
                key={`${current.id}-${field.key}`}
                field={field}
                node={current}
                definition={definition}
                graph={body}
                catalog={catalog}
                connections={connections}
                notes={notes}
                update={(next) =>
                  onChange({ ...body, nodes: body.nodes.map((n) => (n.id === next.id ? next : n)) })
                }
              />
            ))}
          <button
            className="text-button danger"
            onClick={() => {
              onChange({
                ...body,
                nodes: body.nodes.filter((n) => n.id !== current.id),
                edges: body.edges.filter((e) => e.source !== current.id && e.target !== current.id),
              });
              setSelected('');
            }}
          >
            Remove item step
          </button>
        </div>
      )}
      <select
        aria-label="Add a step for each item"
        value=""
        onChange={(e) => {
          if (!e.target.value) return;
          const meta = catalog.find((n) => n.type === e.target.value)!;
          const id = `item_${crypto.randomUUID().slice(0, 8)}`;
          const previous = body.nodes.at(-1)!;
          const next: WorkflowNode = {
            id,
            type: meta.type,
            version: 1,
            label: meta.label,
            config: Object.fromEntries(
              meta.fields
                .filter((f) => f.target === 'config' && f.default !== undefined)
                .map((f) => [f.key, structuredClone(f.default!)]),
            ),
            inputs: {},
          };
          onChange({
            ...body,
            nodes: [...body.nodes, next],
            edges: [
              ...body.edges,
              {
                id: crypto.randomUUID(),
                source: previous.id,
                target: id,
                sourcePort: previous.type === 'logic.condition' ? 'true' : 'out',
                targetPort: 'in',
              },
            ],
          });
          setSelected(id);
        }}
      >
        <option value="">+ Add an item step…</option>
        {catalog
          .filter((d) => d.category !== 'trigger' && d.type !== 'logic.foreach')
          .map((d) => (
            <option key={d.type} value={d.type}>
              {d.label}
            </option>
          ))}
      </select>
    </div>
  );
}
