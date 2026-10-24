'use client';
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Braces,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  GitBranch,
  GripVertical,
  Home,
  LayoutGrid,
  Link2,
  List,
  LoaderCircle,
  Mail,
  MoreHorizontal,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Upload,
  WandSparkles,
  Workflow,
  X,
  Zap,
  User,
  Users,
  Server,
} from 'lucide-react';
import type { ReactNode } from 'react';
export const icons = {
  User,
  Users,
  Server,
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Braces,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  GitBranch,
  GripVertical,
  Home,
  LayoutGrid,
  Link2,
  List,
  LoaderCircle,
  Mail,
  MoreHorizontal,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Upload,
  WandSparkles,
  Workflow,
  X,
  Zap,
};
export function Icon({
  name,
  size = 18,
  ...props
}: {
  name: keyof typeof icons;
  size?: number;
  className?: string;
}) {
  const Component = icons[name];
  return <Component size={size} strokeWidth={1.7} {...props} />;
}
const brandedApps = new Set([
  'gmail',
  'sheets',
  'drive',
  'calendar',
  'telegram',
  'slack',
  'discord',
  'notion',
  'outlook',
  'excel',
  'mysql',
  'postgres',
  'gemini',
  'ollama',
  'openai',
  'google',
  'microsoft',
]);
export function StepIcon({ type, small }: { type: string; small?: boolean }) {
  const group = type.split('.')[0]!;
  const brand = group === 'trigger' ? type.split('.')[1] : group;
  if (brand && brandedApps.has(brand)) {
    return (
      <span className={`step-icon app-logo ${small ? 'small' : ''}`} aria-hidden="true">
        {/* Local brand assets remain available offline and never contact an image CDN. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/app-logos/${brand}.svg`}
          alt=""
          width={small ? 18 : 25}
          height={small ? 18 : 25}
        />
      </span>
    );
  }
  const name =
    group === 'trigger'
      ? 'Zap'
      : group === 'ai'
        ? 'Sparkles'
        : group === 'logic'
          ? 'GitBranch'
          : group === 'notes'
            ? 'FileText'
            : group === 'files'
              ? 'FolderOpen'
              : group === 'gmail' || group === 'email'
                ? 'Mail'
                : group === 'telegram'
                  ? 'Send'
                  : group === 'sheets'
                    ? 'LayoutGrid'
                    : 'Braces';
  return (
    <span className={`step-icon ${group} ${small ? 'small' : ''}`}>
      <Icon name={name} size={small ? 16 : 21} />
    </span>
  );
}
export function Status({ status }: { status: string }) {
  return (
    <span className={`status ${status}`}>
      <span />
      {status === 'unknown' ? 'Outcome unknown' : status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <Icon name="X" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function Empty({
  icon = 'Workflow',
  title,
  text,
  children,
}: {
  icon?: keyof typeof icons;
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={icon} size={27} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}
export function ErrorMessage({ message }: { message?: string }) {
  return message ? (
    <div role="alert" className="error-message">
      <Icon name="CircleHelp" size={17} />
      <span>{message}</span>
    </div>
  ) : null;
}
export function Loading({ text = 'Loading your workspace…' }: { text?: string }) {
  return (
    <div className="loading">
      <Icon name="LoaderCircle" className="spin" />
      {text}
    </div>
  );
}
