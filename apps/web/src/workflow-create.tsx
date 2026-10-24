'use client';
import { useState } from 'react';
import { post, type WorkflowDefinition, type WorkflowTemplate } from './lib';
import { ErrorMessage, Icon, Modal, StepIcon } from './ui';
import { AIControls } from './ai-controls';
import type { AISettings } from '@forge/contracts';
import { TemplateCard } from './studio';

export function DescribeDialog({
  onClose,
  onCreate,
  existing,
}: {
  onClose: () => void;
  onCreate: (definition: WorkflowDefinition, name: string) => Promise<void>;
  existing?: WorkflowDefinition;
}) {
  const [ai, setAI] = useState<AISettings>(
    existing?.settings.ai ?? { provider: 'gemini', dataPolicy: 'private' },
  );
  const [description, setDescription] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{
    name: string;
    explanation: string;
    questions: string[];
    definition: WorkflowDefinition | null;
  }>();
  async function generate() {
    setBusy(true);
    setError('');
    try {
      const next = await post('ai/generate', {
        description: reply ? `${description}\nAdditional details: ${reply}` : description,
        existing: result?.definition ?? existing,
        ai,
      });
      setResult(next);
      if (reply) {
        setDescription(`${description}\n${reply}`);
        setReply('');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={existing ? 'Make a change with AI' : 'Describe it. Let’s connect the steps.'}
      subtitle="Choose an AI provider. Nothing is enabled until you review it."
      onClose={onClose}
      wide
    >
      <div className="describe-body">
        <div className="privacy-note">
          <Icon name="ShieldCheck" size={16} />
          Your selected provider processes the description.
        </div>
        <AIControls value={ai} onChange={setAI} />
        <label>
          What would you like to automate?
          <textarea
            className="description-input"
            placeholder="Every evening, summarize today’s notes and send the summary to my Telegram…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
          />
        </label>
        {!result && (
          <div className="example-prompts">
            <span>Try an idea</span>
            {[
              'Summarize text and save it as a note',
              'Classify new emails and apply Gmail labels',
              'Send me a daily notes summary on Telegram',
            ].map((example) => (
              <button key={example} onClick={() => setDescription(example)}>
                {example}
                <Icon name="ArrowUpRight" size={13} />
              </button>
            ))}
          </div>
        )}
        <ErrorMessage message={error} />
        {busy && (
          <div className="ai-working">
            <Icon name="Sparkles" className="pulse" />
            <div>
              <strong>Connecting the dots…</strong>
              <p>Your selected AI provider is preparing a validated draft.</p>
            </div>
          </div>
        )}
        {result && (
          <section className="generated-result">
            <h3>{result.name}</h3>
            <p>{result.explanation}</p>
            {result.definition?.nodes.map((node, i) => (
              <div className="generated-step" key={node.id}>
                <span className="step-number">{i + 1}</span>
                <StepIcon type={node.type} small />
                <span>{node.label}</span>
              </div>
            ))}
            {result.questions.length > 0 && (
              <div className="clarifications">
                <strong>A few details to finish setup</strong>
                <ul>
                  {result.questions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
                <label>
                  Add details
                  <textarea
                    rows={2}
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder="For example: 8 PM, Europe/London. I’ll choose the account in the editor."
                  />
                </label>
                <small>You can also fill these in after creating the draft.</small>
              </div>
            )}
          </section>
        )}
        <div className="modal-actions">
          <button className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || description.length < 5}
            onClick={() => void generate()}
          >
            <Icon
              name={busy ? 'LoaderCircle' : 'WandSparkles'}
              className={busy ? 'spin' : ''}
              size={17}
            />
            {result ? 'Update proposal' : 'Create a proposal'}
          </button>
          {result?.definition && (
            <button
              className="button dark"
              disabled={busy}
              onClick={() => void onCreate(result.definition!, result.name)}
            >
              {existing ? 'Apply changes to draft' : 'Open editable draft'}
              <Icon name="ArrowRight" size={16} />
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
export function TemplateGallery({
  templates,
  onChoose,
}: {
  templates: WorkflowTemplate[];
  onChoose: (template: WorkflowTemplate) => Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All templates');
  const [selected, setSelected] = useState<WorkflowTemplate>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const categories = ['All templates', ...new Set(templates.map((t) => t.category))];
  const filtered = templates.filter(
    (t) =>
      (category === 'All templates' || category === t.category) &&
      `${t.name} ${t.description} ${t.apps.join(' ')}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">A HEAD START FOR YOUR NEXT IDEA</div>
          <h1>Useful workflows, ready to go.</h1>
          <p>Pick a task. Follow the guided setup. Make it yours.</p>
        </div>
        <span className="pill neutral">{templates.length} original templates</span>
      </div>
      <div className="template-search">
        <Icon name="Search" size={20} />
        <input
          aria-label="Search templates"
          placeholder="What do you want to automate? Search tasks or apps…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span>⌕</span>
      </div>
      <div className="category-tabs">
        {categories.map((c) => (
          <button key={c} className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>
            {c}
          </button>
        ))}
      </div>
      <div className="template-grid">
        {filtered.map((t) => (
          <TemplateCard key={t.id} template={t} onClick={() => setSelected(t)} />
        ))}
      </div>
      {!filtered.length && (
        <p className="muted">No templates match this search. Try “notes,” “email,” or “files.”</p>
      )}
      <div className="template-help">
        <Icon name="CircleHelp" />
        <div>
          <strong>Not sure where to start?</strong>
          <p>“Turn a long text into a clear note” needs only local AI. No accounts to connect.</p>
        </div>
      </div>
      {selected && (
        <Modal
          title={selected.name}
          subtitle={selected.description}
          onClose={() => setSelected(undefined)}
        >
          <div className="template-preview">
            <div className="mini-apps">
              {selected.apps.map((app) => (
                <span className="pill neutral" key={app}>
                  {app}
                </span>
              ))}
            </div>
            <h4>Here’s how it works</h4>
            {selected.definition.nodes.map((n, i) => (
              <div className="generated-step" key={n.id}>
                <span className="step-number">{i + 1}</span>
                <StepIcon type={n.type} small />
                <span>{n.label}</span>
              </div>
            ))}
            <p className="muted">
              The guided editor will help you choose accounts and fill in the details. Your workflow
              starts as a draft.
            </p>
            <ErrorMessage message={error} />
            <div className="modal-actions">
              <button className="button secondary" onClick={() => setSelected(undefined)}>
                Back
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void onChoose(selected)
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                <Icon
                  name={busy ? 'LoaderCircle' : 'Plus'}
                  className={busy ? 'spin' : ''}
                  size={17}
                />
                Use this template
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
