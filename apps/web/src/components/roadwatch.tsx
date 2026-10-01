'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import type {
  DashboardData,
  Defect,
  Device,
  Road,
  Survey,
  WorkOrder,
  Measurement,
  Job,
  AuditEvent,
} from '@roadwatch/domain';
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  FileChartColumn,
  FileJson,
  FileText,
  Filter,
  Gauge,
  Layers,
  LoaderCircle,
  LogOut,
  Map,
  MapPin,
  Menu,
  MoreHorizontal,
  Navigation,
  Plus,
  Radio,
  RefreshCw,
  Route,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Truck,
  Upload,
  Video,
  Waypoints,
  Wrench,
  X,
} from 'lucide-react';
import { api, ApiError, download, write } from '@/lib/api';
import RoadMap from './road-map';
import { Badge, Empty, ErrorMessage, Submit, Field, Dialog } from './ui';
import {
  Alerts,
  UserManagement,
  JobObservations,
  VisionStatus,
  DeviceControls,
  EvidenceMedia,
  type ProcessingJob,
} from './operations-tools';

type User = { id: string; name?: string; email: string; role: string };
type Settings = {
  organizationName: string;
  defaultRegion: string;
  retentionDays: number;
  version?: number;
  priorityPolicy?: unknown;
};
type Calibration = {
  id: string;
  deviceId: string;
  name?: string;
  createdAt?: string;
  status?: string;
};
type Modal = 'report' | 'device' | 'survey' | 'import' | 'work-order' | null;
type Notice = { text: string; kind: 'success' | 'error' };
const labels: Record<string, string> = {
  overview: 'Overview',
  defects: 'Defect review',
  roads: 'Road network',
  fleet: 'Fleet & devices',
  surveys: 'Surveys & capture',
  maintenance: 'Maintenance',
  reports: 'Reports',
  settings: 'Administration',
};
const defectTypes = [
  'pothole',
  'longitudinal_crack',
  'transverse_crack',
  'alligator_crack',
  'patch_deterioration',
  'raveling',
  'edge_break',
  'surface_deformation',
];
const human = (value?: string | null) =>
  value ? value.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase()) : 'Not recorded';
const date = (value?: string | null) =>
  value && !Number.isNaN(Date.parse(value))
    ? new Date(value).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : 'Not recorded';
const time = (value?: string | null) =>
  value && !Number.isNaN(Date.parse(value))
    ? new Date(value).toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Not recorded';
const chainage = (metres?: number | null) =>
  metres == null
    ? 'Unknown chainage'
    : `${Math.floor(metres / 1000)}+${Math.round(metres % 1000)
        .toString()
        .padStart(3, '0')} m`;
const textField = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const numeric = (form: FormData, key: string) =>
  textField(form, key) === '' ? undefined : Number(textField(form, key));
const activeDefect = (d: Defect) => !['closed', 'rejected'].includes(d.status);

function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <Route size={23} strokeWidth={2.6} />
      </span>
      <span>
        Road<span>Watch</span>
      </span>
    </span>
  );
}
export function Login() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await write('/auth/login', {
        email: textField(form, 'email'),
        password: String(form.get('password') ?? ''),
      });
      router.replace('/');
      router.refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Sign in failed. Check your details and try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-layout">
      <section className="login-story">
        <Brand />
        <div className="login-copy">
          <span className="login-symbol">
            <Waypoints size={50} />
          </span>
          <h1>
            Better roads begin
            <br />
            with a clearer picture.
          </h1>
          <p>
            One workspace for road evidence, informed maintenance decisions, and repairs you can
            verify.
          </p>
          <div className="login-road-art" aria-hidden="true">
            <i />
            <i />
            <i />
            <span>
              <MapPin size={25} />
            </span>
          </div>
        </div>
        <div className="login-foot">
          <ShieldCheck size={17} />
          Road condition intelligence
        </div>
      </section>
      <section className="login-form-wrap">
        <form className="login-form" onSubmit={login}>
          <div className="mobile-brand">
            <Brand />
          </div>
          <h2>Welcome to RoadWatch</h2>
          <p>Sign in to your road operations workspace.</p>
          <ErrorMessage>{error}</ErrorMessage>
          <Field label="Work email">
            <input
              name="email"
              type="email"
              autoComplete="username"
              placeholder="you@organization.in"
              required
              autoFocus
            />
          </Field>
          <Field label="Password">
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Enter your password"
              minLength={8}
              required
            />
          </Field>
          <button className="button primary login-submit" disabled={busy}>
            {busy ? <LoaderCircle size={18} className="spin" /> : null}
            {busy ? 'Signing in…' : 'Sign in to workspace'}
            <ArrowRight size={18} />
          </button>
          <p className="login-help">
            Use the account provided by your workspace administrator. Access and changes are
            recorded for accountability.
          </p>
        </form>
      </section>
    </main>
  );
}

export default function RoadWatch({ section }: { section: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [user, setUser] = useState<User | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [query, setQuery] = useState('');
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const notify = useCallback(
    (text: string, kind: 'success' | 'error' = 'success') => setNotice({ text, kind }),
    [],
  );
  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await api<DashboardData>('/dashboard');
      setData(result);
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace('/login');
      else setError(e instanceof Error ? e.message : 'Workspace could not load.');
    } finally {
      setRefreshing(false);
    }
  }, [router]);
  useEffect(() => {
    let live = true;
    void api<User | { user: User }>('/auth/me')
      .then((response) => {
        if (!live) return;
        setUser('user' in response ? response.user : response);
        return reload();
      })
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 401) router.replace('/login');
        else setError(e instanceof Error ? e.message : 'Could not connect to the workspace.');
      });
    return () => {
      live = false;
    };
  }, [reload, router]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    setSelectedId(searchParams.get('id') ?? '');
  }, [searchParams]);
  const changed = async (message: string) => {
    await reload();
    notify(message);
  };
  const select = (defect: Defect) => setSelectedId(defect.id);
  const selected = data?.defects.find((d) => d.id === selectedId);
  const open = data?.defects.filter(activeDefect) ?? [];
  const pending = data?.defects.filter((d) => d.status === 'candidate').length ?? 0;
  const canExport = user ? ['admin', 'planner', 'reviewer'].includes(user.role) : false;
  const canCapture = user ? ['admin', 'planner', 'crew'].includes(user.role) : false;
  const canReport = user ? ['admin', 'planner', 'reviewer', 'crew'].includes(user.role) : false;
  const canPlan = user ? ['admin', 'planner'].includes(user.role) : false;
  const canReview = user ? ['admin', 'reviewer'].includes(user.role) : false;
  const nav = [
    { key: 'overview', icon: Gauge },
    { key: 'defects', icon: CircleAlert },
    { key: 'roads', icon: Route },
    { key: 'fleet', icon: Truck },
    { key: 'surveys', icon: Camera },
    { key: 'maintenance', icon: Wrench },
    { key: 'reports', icon: FileChartColumn },
  ];
  async function logout() {
    setLogoutBusy(true);
    try {
      await write('/auth/logout', {});
      router.replace('/login');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Sign out failed.', 'error');
    } finally {
      setLogoutBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {sidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className={`sidebar ${sidebar ? 'is-open' : ''}`}>
        <Link href="/" className="brand-link">
          <Brand />
        </Link>
        <div className="workspace-label">
          <span className="workspace-avatar">RW</span>
          <div>
            <strong>{data?.organizationName || 'Road operations'}</strong>
            <small>Engineering workspace</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <nav aria-label="Main navigation">
          {nav.map((item) => (
            <Link
              key={item.key}
              className={`nav-item ${section === item.key ? 'active' : ''}`}
              href={item.key === 'overview' ? '/' : `/${item.key}`}
              onClick={() => setSidebar(false)}
            >
              <item.icon size={19} />
              <span>{labels[item.key]}</span>
              {item.key === 'defects' && pending > 0 && (
                <span className="nav-count">{pending}</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="workspace-status">
            <span className={`live-dot ${error ? 'warning' : ''}`} />
            <div>
              <strong>{data ? 'Workspace connected' : 'Connecting workspace'}</strong>
              <small>{data?.isDemo ? 'Demonstration environment' : 'Authorized operations'}</small>
            </div>
          </div>
          <Link href="/settings" className={`nav-item ${section === 'settings' ? 'active' : ''}`}>
            <Settings2 size={19} />
            <span>Administration</span>
          </Link>
          <div className="profile">
            <span className="profile-avatar">
              {(user?.name || user?.email || 'RW').slice(0, 2).toUpperCase()}
            </span>
            <div>
              <strong>{user?.name || user?.email?.split('@')[0] || 'Account'}</strong>
              <small>{human(user?.role)}</small>
            </div>
            <button
              aria-label="Sign out"
              className="icon-button"
              disabled={logoutBusy}
              onClick={logout}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setSidebar(true)}
            >
              <Menu size={22} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>{labels[section]}</strong>
          </div>
          <div className="topbar-actions">
            <div className="global-search">
              <Search size={17} />
              <input
                aria-label="Search roads and defects"
                placeholder="Search roads or defect IDs…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button
                  aria-label="Clear search"
                  className="icon-button"
                  onClick={() => setQuery('')}
                >
                  <X size={14} />
                </button>
              )}
              {query && data && (
                <div className="search-results">
                  {[
                    ...data.roads
                      .filter((r) =>
                        `${r.name} ${r.code}`.toLowerCase().includes(query.toLowerCase()),
                      )
                      .slice(0, 4)
                      .map((r) => ({
                        id: r.id,
                        name: r.name,
                        href: `/roads?id=${r.id}`,
                        sub: r.code,
                      })),
                    ...data.defects
                      .filter((d) =>
                        `${d.code} ${d.roadName} ${d.type}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      )
                      .slice(0, 4)
                      .map((d) => ({
                        id: d.id,
                        name: `${d.code} · ${human(d.type)}`,
                        href: `/defects?id=${d.id}`,
                        sub: d.roadName,
                      })),
                  ].map((result) => (
                    <Link href={result.href} key={result.id} onClick={() => setQuery('')}>
                      <MapPin size={15} />
                      <span>
                        {result.name}
                        <small>{result.sub}</small>
                      </span>
                      <ArrowUpRight size={14} />
                    </Link>
                  ))}
                  {!data.roads.some((r) =>
                    `${r.name} ${r.code}`.toLowerCase().includes(query.toLowerCase()),
                  ) &&
                    !data.defects.some((d) =>
                      `${d.code} ${d.roadName} ${d.type}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    ) && <p>No matching road or defect.</p>}
                </div>
              )}
            </div>
            <button
              className="icon-button refresh-button"
              aria-label="Refresh workspace"
              disabled={refreshing}
              onClick={reload}
            >
              <RefreshCw size={18} className={refreshing ? 'spin' : ''} />
            </button>
            <button
              className="notification-link"
              onClick={() => setAlertsOpen(true)}
              aria-label="Open workspace alerts"
            >
              <Bell size={19} />
            </button>
          </div>
        </header>
        <main id="main-content" className={`main-content page-${section}`}>
          <div className="page-heading">
            <div>
              <div className="heading-context">
                <span className="context-line" />
                Road intelligence workspace
              </div>
              <h1>{section === 'overview' ? 'Every road. A clearer picture.' : labels[section]}</h1>
              <p>
                {
                  (
                    {
                      overview: 'Know what needs attention. Keep your road network moving.',
                      defects: 'Review the evidence. Turn observations into confident decisions.',
                      roads: 'A shared reference for road identity, ownership, and condition.',
                      fleet: 'Your eyes on the road, connected to one workspace.',
                      surveys: 'Capture road evidence and follow every processing step.',
                      maintenance: 'From confirmed defect to an independently verified repair.',
                      reports: 'Clear evidence for field teams, planners, and road owners.',
                      settings: 'Manage your organization and trace changes across the workspace.',
                    } as Record<string, string>
                  )[section]
                }
              </p>
            </div>
            <div className="heading-actions">
              {['overview', 'defects'].includes(section) && (
                <>
                  {canExport && (
                    <button
                      className="button secondary"
                      onClick={() =>
                        download('/reports/defects.csv', 'roadwatch-defects.csv').catch((e) =>
                          notify(e.message, 'error'),
                        )
                      }
                    >
                      <ArrowDownToLine size={16} />
                      Export
                    </button>
                  )}
                  {canReport && (
                    <button
                      className="button primary"
                      disabled={!data}
                      onClick={() => setModal('report')}
                    >
                      <Plus size={17} />
                      Report defect
                    </button>
                  )}
                </>
              )}
              {section === 'roads' && canPlan && (
                <button className="button primary" onClick={() => setModal('import')}>
                  <Upload size={17} />
                  Import roads
                </button>
              )}
              {section === 'fleet' && user?.role === 'admin' && (
                <button className="button primary" onClick={() => setModal('device')}>
                  <Plus size={17} />
                  Register device
                </button>
              )}
              {section === 'surveys' && canCapture && (
                <button
                  className="button primary"
                  disabled={!data}
                  onClick={() => setModal('survey')}
                >
                  <Plus size={17} />
                  Start survey
                </button>
              )}
              {section === 'maintenance' && canPlan && (
                <button className="button primary" onClick={() => setModal('work-order')}>
                  <Plus size={17} />
                  Create work order
                </button>
              )}
            </div>
          </div>
          {data?.isDemo && (
            <div className="demo-banner">
              <Layers size={15} />
              <span>
                <strong>Demonstration workspace.</strong> Roads, defects, and activity are
                illustrative. New uploads are processed only by a configured road model.
              </span>
            </div>
          )}
          {error && (
            <div className="load-error">
              <ErrorMessage>{error}</ErrorMessage>
              <button className="button secondary" onClick={reload}>
                Retry connection
              </button>
            </div>
          )}
          {!data && !error && (
            <div className="loading-workspace" role="status">
              <LoaderCircle size={30} className="spin" />
              <h2>Opening your road network…</h2>
              <p>Loading roads, evidence, and maintenance activity.</p>
            </div>
          )}
          {data && (
            <>
              {section === 'overview' && (
                <Overview
                  data={data}
                  selected={selected}
                  onSelect={select}
                  onReview={() => router.push(`/defects?id=${selected?.id ?? ''}`)}
                />
              )}
              {section === 'defects' && (
                <Defects
                  data={data}
                  selected={selected}
                  onSelect={select}
                  canReview={canReview}
                  changed={changed}
                />
              )}
              {section === 'roads' && <Roads data={data} />}
              {section === 'fleet' && <Fleet data={data} user={user} changed={changed} />}
              {section === 'surveys' && (
                <Surveys data={data} user={user} changed={changed} notify={notify} />
              )}
              {section === 'maintenance' && (
                <Maintenance data={data} user={user} changed={changed} />
              )}
              {section === 'reports' &&
                (canExport ? (
                  <Reports data={data} notify={notify} />
                ) : (
                  <section className="content-panel">
                    <Empty icon={<ShieldCheck size={27} />} title="Export access required">
                      Administrators, planners, and reviewers can export workspace reports.
                    </Empty>
                  </section>
                ))}
              {section === 'settings' &&
                (canExport ? (
                  <Administration user={user} changed={changed} />
                ) : (
                  <section className="content-panel">
                    <Empty icon={<ShieldCheck size={27} />} title="Administration access required">
                      Your current role can view operational records. Organization settings and
                      audit entries are available to authorized reviewers, planners, and
                      administrators.
                    </Empty>
                  </section>
                ))}
            </>
          )}
          <footer className="workspace-footer">
            <span>
              <ShieldCheck size={13} />
              Evidence-led road maintenance
            </span>
            <span>
              RoadWatch <span className="footer-divider">/</span> {data?.roads.length ?? 0} roads in
              your workspace
            </span>
          </footer>
        </main>
      </div>
      {notice && (
        <div role={notice.kind === 'error' ? 'alert' : 'status'} className={`toast ${notice.kind}`}>
          {notice.kind === 'success' ? <CheckCircle2 size={20} /> : <CircleAlert size={20} />}
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss notification">
            <X size={16} />
          </button>
        </div>
      )}
      {alertsOpen && <Alerts onClose={() => setAlertsOpen(false)} />}
      {modal && data && (
        <CreateDialog
          kind={modal}
          data={data}
          onClose={() => setModal(null)}
          onDone={async (message) => {
            setModal(null);
            await changed(message);
          }}
        />
      )}
    </div>
  );
}

function Overview({
  data,
  selected,
  onSelect,
  onReview,
}: {
  data: DashboardData;
  selected?: Defect;
  onSelect: (d: Defect) => void;
  onReview: () => void;
}) {
  const [priority, setPriority] = useState('all');
  const open = data.defects.filter(activeDefect);
  const filtered = open
    .filter((d) => priority === 'all' || d.priority === priority)
    .sort((a, b) => a.priority.localeCompare(b.priority));
  const inspected = data.segments.length
    ? Math.round(
        data.segments.reduce((sum, s) => sum + Number(s.coveragePct || 0), 0) /
          data.segments.length,
      )
    : 0;
  const work = data.workOrders.filter(
    (w) => !['closed', 'verified', 'completed'].includes(w.status),
  );
  const roadKm = data.roads.reduce((sum, r) => sum + r.lengthM, 0) / 1000;
  return (
    <>
      <div className="metrics-band">
        <Metric
          icon={<Route />}
          value={roadKm.toFixed(1)}
          unit="km"
          title="Road network"
          detail={`${data.roads.length} roads in the registry`}
        />
        <Metric
          icon={<CircleAlert />}
          value={String(open.length)}
          title="Open defects"
          detail={`${open.filter((d) => ['P0', 'P1'].includes(d.priority)).length} need priority attention`}
          urgent
        />
        <Metric
          icon={<Wrench />}
          value={String(work.length)}
          title="Active work orders"
          detail={`${data.workOrders.filter((w) => ['closed', 'verified', 'completed'].includes(w.status)).length} repairs verified`}
        />
        <Metric
          icon={<Radio />}
          value={String(data.devices.filter((d) => ['online', 'active'].includes(d.status)).length)}
          unit={`/ ${data.devices.length}`}
          title="Connected devices"
          detail="Based on latest device status"
        />
      </div>
      <section className="network-workspace">
        <div className="panel-heading">
          <div>
            <h2>Network overview</h2>
            <span>Road condition and inspection priorities</span>
          </div>
          <Link href="/roads" className="text-link">
            View road network
            <ArrowUpRight size={15} />
          </Link>
        </div>
        <div className="network-body">
          <RoadMap
            roads={data.roads}
            defects={filtered}
            selectedId={selected?.id}
            onSelect={onSelect}
            demo={data.isDemo}
          />
          <aside className="inspection-queue">
            <div className="queue-heading">
              <div>
                <h3>
                  Needs attention <span>{filtered.length}</span>
                </h3>
                <p>Select a marker or a defect to inspect.</p>
              </div>
              <select
                aria-label="Filter map by priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option value="all">All priorities</option>
                {['P0', 'P1', 'P2', 'P3'].map((p) => (
                  <option key={p} value={p}>
                    {p}{' '}
                    {
                      (
                        { P0: 'Immediate', P1: 'High', P2: 'Medium', P3: 'Routine' } as Record<
                          string,
                          string
                        >
                      )[p]
                    }
                  </option>
                ))}
              </select>
            </div>
            <div className="queue-list">
              {filtered.length ? (
                filtered.slice(0, 12).map((d) => (
                  <button
                    key={d.id}
                    className={`queue-row ${selected?.id === d.id ? 'selected' : ''}`}
                    onClick={() => onSelect(d)}
                  >
                    <span className={`priority-line ${d.priority.toLowerCase()}`} />
                    <div>
                      <div className="queue-top">
                        <strong>{d.roadName}</strong>
                        <Badge value={d.priority} />
                      </div>
                      <span>
                        {human(d.type)}
                        <span className="small-divider">·</span>
                        {chainage(d.chainageM)}
                      </span>
                      <div className="queue-meta">
                        <span>{d.code}</span>
                        <span>
                          {human(d.status)}
                          <ChevronRight size={13} />
                        </span>
                      </div>
                    </div>
                  </button>
                ))
              ) : (
                <Empty title="No defects in this view">
                  Change the priority filter or start a road survey.
                </Empty>
              )}
            </div>
            {selected ? (
              <div className="queue-selected">
                <div>
                  <span>Selected defect</span>
                  <strong>{selected.code}</strong>
                </div>
                <button className="button primary" onClick={onReview}>
                  Review evidence
                  <ArrowRight size={15} />
                </button>
              </div>
            ) : (
              <Link className="queue-footer" href="/defects">
                Open inspection queue
                <ArrowRight size={16} />
              </Link>
            )}
          </aside>
        </div>
      </section>
      <div className="overview-bottom">
        <section className="content-panel">
          <div className="panel-heading">
            <div>
              <h2>Road condition at a glance</h2>
              <span>Inspection coverage across your network</span>
            </div>
            <span className="coverage-total">
              {inspected}% <small>average coverage</small>
            </span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Road / asset</th>
                  <th>Survey coverage</th>
                  <th>Open defects</th>
                  <th>Attention</th>
                </tr>
              </thead>
              <tbody>
                {data.roads.slice(0, 5).map((r) => {
                  const defects = open.filter((d) => d.roadId === r.id);
                  const segments = data.segments.filter((s) => s.roadId === r.id);
                  const coverage = segments.length
                    ? Math.round(
                        segments.reduce((sum, s) => sum + Number(s.coveragePct || 0), 0) /
                          segments.length,
                      )
                    : 0;
                  return (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/roads?id=${r.id}`} className="table-title">
                          {r.name}
                        </Link>
                        <small>
                          {r.code} · {(r.lengthM / 1000).toFixed(1)} km
                        </small>
                      </td>
                      <td>
                        <div className="coverage-track">
                          <i style={{ width: `${coverage}%` }} />
                        </div>
                        <small>{coverage}% surveyed</small>
                      </td>
                      <td>{defects.length}</td>
                      <td>
                        {defects.length ? (
                          <Badge value={defects.map((d) => d.priority).sort()[0]} />
                        ) : (
                          <Badge value="clear">No open defects</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!data.roads.length && (
              <Empty title="Your road registry is empty">
                Import authorized road geometry to begin.
              </Empty>
            )}
          </div>
        </section>
        <section className="content-panel activity-panel">
          <div className="panel-heading">
            <div>
              <h2>Recent activity</h2>
              <span>An accountable trail of changes</span>
            </div>
            <Activity size={18} />
          </div>
          <ActivityList events={data.activity.slice(0, 5)} />
        </section>
      </div>
    </>
  );
}
function Metric({
  icon,
  value,
  unit,
  title,
  detail,
  urgent,
}: {
  icon: ReactNode;
  value: string;
  unit?: string;
  title: string;
  detail: string;
  urgent?: boolean;
}) {
  return (
    <div className={`metric ${urgent ? 'urgent' : ''}`}>
      <div className="metric-label">
        {title}
        <span>{icon}</span>
      </div>
      <div className="metric-value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      <p>{detail}</p>
    </div>
  );
}
function ActivityList({ events }: { events: AuditEvent[] }) {
  return events.length ? (
    <ol className="activity-list">
      {events.map((event, i) => (
        <li key={event.id}>
          <span className={`activity-dot ${i === 0 ? 'current' : ''}`} />
          <div>
            <strong>{human(event.action)}</strong>
            <p>
              {typeof event.actor === 'string' ? event.actor : 'Workspace user'}
              <span className="small-divider">·</span>
              {human(event.entityType)}
            </p>
            <time>{time(event.createdAt)}</time>
          </div>
        </li>
      ))}
    </ol>
  ) : (
    <Empty icon={<Activity size={25} />} title="No activity yet">
      Changes will appear here as your team works.
    </Empty>
  );
}

function MeasurementValue({
  title,
  measurement,
}: {
  title: string;
  measurement?: Measurement | null;
}) {
  const known = measurement && measurement.value != null;
  return (
    <div className="measurement">
      <span>{title}</span>
      <strong>
        {known
          ? `${Number(measurement.value).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${measurement.unit}`
          : 'Unknown'}
      </strong>
      <small>
        {known ? human(measurement.status) : measurement?.reason || 'No qualified measurement'}
      </small>
      {known && measurement.uncertainty95 != null && (
        <small>
          ± {measurement.uncertainty95} {measurement.unit} (95%)
        </small>
      )}
    </div>
  );
}

function Defects({
  data,
  selected,
  onSelect,
  canReview,
  changed,
}: {
  data: DashboardData;
  selected?: Defect;
  onSelect: (d: Defect) => void;
  canReview: boolean;
  changed: (message: string) => Promise<void>;
}) {
  const [status, setStatus] = useState('open');
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('confirm');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const visible = data.defects
    .filter((d) => status === 'all' || (status === 'open' ? activeDefect(d) : d.status === status))
    .filter((d) =>
      `${d.code} ${d.roadName} ${d.type}`.toLowerCase().includes(search.toLowerCase()),
    );
  const current = selected ?? visible[0];
  useEffect(() => {
    setError('');
    setAction(current && ['rejected', 'closed'].includes(current.status) ? 'reopen' : 'confirm');
  }, [current?.id, current?.status]);
  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await write(`/defects/${current.id}/reviews`, {
        action,
        reason: textField(form, 'reason'),
        expectedVersion: current.version,
      });
      await changed(
        `Defect ${current.code} ${action === 'confirm' ? 'confirmed' : action === 'reject' ? 'rejected' : 'reopened'}.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Review could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="review-layout">
      <section className="content-panel defect-browser">
        <div className="list-toolbar">
          <div className="input-search">
            <Search size={16} />
            <input
              placeholder="Find a defect…"
              aria-label="Filter defects"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            aria-label="Defect status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="open">All open</option>
            <option value="all">All statuses</option>
            {[
              'candidate',
              'confirmed',
              'assigned',
              'in_progress',
              'repair_reported',
              'closed',
              'rejected',
            ].map((s) => (
              <option key={s} value={s}>
                {human(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="list-count">
          {visible.length} defect{visible.length !== 1 ? 's' : ''}
          <span>Latest evidence first</span>
        </div>
        {visible.map((d) => (
          <button
            key={d.id}
            className={`defect-list-row ${current?.id === d.id ? 'selected' : ''}`}
            onClick={() => onSelect(d)}
          >
            <div>
              <Badge value={d.priority} />
              <small>{d.code}</small>
              <ChevronRight size={15} />
            </div>
            <h3>{human(d.type)}</h3>
            <p>
              <MapPin size={13} />
              {d.roadName}
            </p>
            <footer>
              <span>{chainage(d.chainageM)}</span>
              <Badge value={d.status} />
            </footer>
          </button>
        ))}
        {!visible.length && (
          <Empty title="No matching defects">Change the filter or report a new observation.</Empty>
        )}
      </section>
      {current ? (
        <section className="content-panel defect-detail">
          <div className="detail-heading">
            <div>
              <div className="detail-code">
                {current.code}
                <Badge value={current.status} />
              </div>
              <h2>{human(current.type)}</h2>
              <p>
                <MapPin size={15} />
                {current.roadName}
                <span className="small-divider">·</span>
                {chainage(current.chainageM)}
              </p>
            </div>
            <Badge value={current.priority} />
          </div>
          <div className="evidence-view">
            {current.evidence?.length ? (
              current.evidence.map((evidence) => (
                <EvidenceMedia key={evidence.id} evidence={evidence} code={current.code} />
              ))
            ) : (
              <div className="no-evidence">
                <Camera size={32} />
                <strong>No photographic evidence attached</strong>
                <p>
                  This record contains a reported observation. Confirm it through an authorized
                  field inspection.
                </p>
              </div>
            )}
          </div>
          <div className="detail-section">
            <h3>Measured condition</h3>
            <div className="measurement-grid">
              <MeasurementValue title="Length" measurement={current.length} />
              <MeasurementValue title="Width" measurement={current.width} />
              <MeasurementValue title="Depth" measurement={current.depth} />
              <MeasurementValue title="Area" measurement={current.area} />
            </div>
            <div className="measurement-note">
              <ShieldCheck size={15} />
              Measurement quality is independent of detection confidence.
            </div>
          </div>
          <div className="detail-section two-column">
            <div>
              <h3>Location & provenance</h3>
              <dl className="detail-list">
                <div>
                  <dt>Coordinates</dt>
                  <dd>
                    {current.latitude.toFixed(6)}, {current.longitude.toFixed(6)}
                  </dd>
                </div>
                <div>
                  <dt>Location accuracy</dt>
                  <dd>
                    {current.locationAccuracyM != null
                      ? `${current.locationAccuracyM} m`
                      : 'Unknown'}
                  </dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{human(current.source)}</dd>
                </div>
                <div>
                  <dt>Observed</dt>
                  <dd>{time(current.observedAt)}</dd>
                </div>
              </dl>
            </div>
            <div>
              <h3>Assessment</h3>
              <dl className="detail-list">
                <div>
                  <dt>Severity</dt>
                  <dd>
                    <Badge value={current.severity} />
                  </dd>
                </div>
                <div>
                  <dt>Detection confidence</dt>
                  <dd>
                    {current.confidence != null
                      ? `${Math.round(current.confidence * 100)}%`
                      : 'Not applicable'}
                  </dd>
                </div>
                <div>
                  <dt>Priority score</dt>
                  <dd>{current.assessment.score} / 100</dd>
                </div>
                <div>
                  <dt>Policy version</dt>
                  <dd>{current.assessment.policyVersion}</dd>
                </div>
                <div>
                  <dt>Record version</dt>
                  <dd>v{current.version}</dd>
                </div>
              </dl>
            </div>
          </div>
          <div className="detail-section priority-explanation">
            <h3>Why this priority?</h3>
            {current.assessment.inspectionRequired && (
              <p className="measurement-note">
                <ShieldCheck size={15} />
                Field inspection is required to resolve measurement uncertainty.
              </p>
            )}
            <ul>
              {current.assessment.reasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
            <details>
              <summary>View scoring factors</summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Factor</th>
                      <th>Value</th>
                      <th>Weight</th>
                      <th>Contribution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.assessment.components.map((item) => (
                      <tr key={item.key}>
                        <td>
                          {item.label}
                          {item.assumed && <small>Policy default assumed</small>}
                        </td>
                        <td>{item.value}</td>
                        <td>{Math.round(item.weight * 100)}%</td>
                        <td>{item.contribution.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
          <div className="detail-section">
            <h3>Observation notes</h3>
            <p className="body-copy">
              {current.description || 'No additional description recorded.'}
            </p>
          </div>
          {canReview &&
            ['candidate', 'confirmed', 'rejected', 'closed'].includes(current.status) && (
              <form className="review-form" onSubmit={review}>
                <h3>Record a review decision</h3>
                <p>Include the evidence supporting your decision. Every review is recorded.</p>
                <div className="form-grid">
                  <Field label="Decision">
                    <select value={action} onChange={(e) => setAction(e.target.value)}>
                      {['candidate', 'confirmed'].includes(current.status) ? (
                        <>
                          <option value="confirm">Confirm defect</option>
                          <option value="reject">Reject observation</option>
                        </>
                      ) : (
                        <option value="reopen">Reopen for review</option>
                      )}
                    </select>
                  </Field>
                  <Field label="Review reason" wide>
                    <textarea
                      name="reason"
                      placeholder="Explain your decision and the evidence reviewed…"
                      required
                      minLength={5}
                      rows={3}
                    />
                  </Field>
                </div>
                <ErrorMessage>{error}</ErrorMessage>
                <div className="form-actions">
                  <span>
                    <ShieldCheck size={14} />
                    Version checked on save
                  </span>
                  <Submit busy={busy}>Save review</Submit>
                </div>
              </form>
            )}
          {!canReview && (
            <p className="access-note">
              <ShieldCheck size={15} />
              Your role can view this record. A reviewer can confirm or reject it.
            </p>
          )}
        </section>
      ) : (
        <section className="content-panel">
          <Empty title="Select a defect to review">
            The record, measurements, and evidence will appear here.
          </Empty>
        </section>
      )}
    </div>
  );
}

function Roads({ data }: { data: DashboardData }) {
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const searchParams = useSearchParams();
  useEffect(() => {
    setSelectedId(searchParams.get('id') ?? '');
  }, [searchParams]);
  const roads = data.roads.filter((r) =>
    `${r.name} ${r.code} ${r.owner}`.toLowerCase().includes(search.toLowerCase()),
  );
  const selected = data.roads.find((r) => r.id === selectedId) ?? roads[0];
  const segments = data.segments.filter((s) => s.roadId === selected?.id);
  return (
    <>
      <section className="content-panel">
        <div className="panel-heading">
          <div>
            <h2>
              Registered roads <span className="count-pill">{data.roads.length}</span>
            </h2>
            <span>Authorized geometry and ownership records</span>
          </div>
          <div className="input-search">
            <Search size={16} />
            <input
              aria-label="Filter roads"
              placeholder="Search roads or owners…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Road</th>
                <th>Region / owner</th>
                <th>Length</th>
                <th>Surface</th>
                <th>Revision</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {roads.map((r) => (
                <tr key={r.id} className={selected?.id === r.id ? 'selected-row' : ''}>
                  <td>
                    <button className="table-title" onClick={() => setSelectedId(r.id)}>
                      {r.name}
                    </button>
                    <small>{r.code}</small>
                  </td>
                  <td>
                    {r.region}
                    <small>{r.owner}</small>
                  </td>
                  <td>{(r.lengthM / 1000).toFixed(2)} km</td>
                  <td>{human(r.surface)}</td>
                  <td>
                    v{r.version}
                    <small>{date(r.updatedAt)}</small>
                  </td>
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`Inspect ${r.name}`}
                      onClick={() => setSelectedId(r.id)}
                    >
                      <ArrowUpRight size={18} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!roads.length && (
          <Empty title="No roads found">
            Import an authorized GeoJSON road network or change your search.
          </Empty>
        )}
      </section>
      {selected && (
        <div className="road-details-grid">
          <section className="content-panel">
            <div className="panel-heading">
              <div>
                <h2>{selected.name}</h2>
                <span>
                  {selected.code} · Geometry revision {selected.version}
                </span>
              </div>
              <Route size={20} />
            </div>
            <RoadMap
              roads={[selected]}
              defects={data.defects.filter((d) => d.roadId === selected.id && activeDefect(d))}
              onSelect={(d) => window.location.assign(`/defects?id=${d.id}`)}
              demo={data.isDemo}
              compact
            />
          </section>
          <section className="content-panel">
            <div className="panel-heading">
              <div>
                <h2>Segments & coverage</h2>
                <span>Chainage measured along the road reference</span>
              </div>
            </div>
            <div className="segments-list">
              {segments.map((s) => (
                <div key={s.id}>
                  <div>
                    <strong>{s.name}</strong>
                    <Badge value={s.coveragePct > 0 ? 'clear' : 'unknown'}>
                      {s.coveragePct}% covered
                    </Badge>
                  </div>
                  <p>
                    {chainage(s.chainageStartM)} — {chainage(s.chainageEndM)}
                  </p>
                  <div className="coverage-track">
                    <i style={{ width: `${s.coveragePct}%` }} />
                  </div>
                  <small>Last survey: {date(s.lastSurveyAt)}</small>
                </div>
              ))}
              {!segments.length && (
                <Empty title="No segments available">
                  Segments are created from the imported road geometry.
                </Empty>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function Fleet({
  data,
  user,
  changed,
}: {
  data: DashboardData;
  user: User | null;
  changed: (message: string) => Promise<void>;
}) {
  const [kind, setKind] = useState('all');
  const devices = data.devices.filter((d) => kind === 'all' || d.kind === kind);
  return (
    <section className="content-panel">
      <div className="panel-heading">
        <div>
          <h2>Device registry</h2>
          <span>Connection, calibration, and upload health</span>
        </div>
        <select aria-label="Device type" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="all">All devices</option>
          <option value="vehicle">Vehicle cameras</option>
          <option value="cctv">Fixed CCTV</option>
          <option value="mobile">Mobile devices</option>
        </select>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Device</th>
              <th>Connection</th>
              <th>Camera / vehicle</th>
              <th>Calibration</th>
              <th>Upload backlog</th>
              <th>Last seen</th>
              {user?.role === 'admin' && <th>Manage</th>}
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <tr key={device.id}>
                <td>
                  <span className="device-name">
                    <span className="device-icon">
                      {device.kind === 'cctv' ? <Video size={20} /> : <Truck size={20} />}
                    </span>
                    <span>
                      <strong>{device.name}</strong>
                      <small>{human(device.kind)}</small>
                    </span>
                  </span>
                </td>
                <td>
                  <Badge value={device.status} />
                </td>
                <td>
                  {device.cameraModel || 'Not specified'}
                  <small>{device.vehiclePlate || 'No vehicle assigned'}</small>
                </td>
                <td>
                  <Badge value={device.calibrationStatus} />
                </td>
                <td>{device.uploadBacklog ?? 0} item(s)</td>
                <td>{time(device.lastSeenAt)}</td>
                {user?.role === 'admin' && (
                  <td>
                    <DeviceControls device={device} onChanged={changed} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!devices.length && (
        <Empty icon={<Truck size={28} />} title="No devices in this view">
          Register a capture device to connect your field operations.
        </Empty>
      )}
      <div className="panel-note">
        <ShieldCheck size={16} />
        Device credentials are revealed only once at registration. Calibration must be validated
        before recording verified measurements.
      </div>
    </section>
  );
}

function Surveys({
  data,
  user,
  changed,
  notify,
}: {
  data: DashboardData;
  user: User | null;
  changed: (message: string) => Promise<void>;
  notify: (text: string, kind?: 'success' | 'error') => void;
}) {
  const [surveyId, setSurveyId] = useState(
    data.surveys.find((s) => ['active', 'in_progress', 'recording'].includes(s.status))?.id || '',
  );
  const [inspecting, setInspecting] = useState<string | null>(null);
  const searchParams = useSearchParams();
  useEffect(() => {
    setInspecting(searchParams.get('id'));
  }, [searchParams]);
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);
  const [jobsError, setJobsError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [shot, setShot] = useState<File | null>(null);
  const [shotUrl, setShotUrl] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [captureCoords, setCaptureCoords] = useState<{
    latitude: number;
    longitude: number;
    accuracy: number;
  } | null>(null);
  const [locationError, setLocationError] = useState('');
  const [locationPending, setLocationPending] = useState(false);
  const loadJobs = useCallback(async () => {
    try {
      setJobs(await api<ProcessingJob[]>('/jobs'));
      setJobsError('');
    } catch (e) {
      setJobsError(e instanceof Error ? e.message : 'Processing history could not load.');
    }
  }, []);
  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);
  useEffect(() => {
    if (!data.surveys.some((s) => s.id === surveyId && s.status === 'active'))
      setSurveyId(data.surveys.find((s) => s.status === 'active')?.id ?? '');
  }, [data.surveys, surveyId]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadJobs();
    }, 10000);
    return () => clearInterval(timer);
  }, [loadJobs]);
  useEffect(
    () => () => {
      stream.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );
  useEffect(
    () => () => {
      if (shotUrl) URL.revokeObjectURL(shotUrl);
    },
    [shotUrl],
  );
  const stopCamera = () => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setCameraOpen(false);
  };
  async function startCamera() {
    setCameraError('');
    setCameraOpen(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('Camera access requires HTTPS or localhost in a supported browser.');
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      if (video.current) {
        video.current.srcObject = stream.current;
        await video.current.play();
      }
    } catch (e) {
      setCameraError(e instanceof Error ? e.message : 'Camera permission was denied.');
      setCameraOpen(false);
    }
  }
  function takePhoto() {
    const element = video.current;
    if (!element || !element.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = element.videoWidth;
    canvas.height = element.videoHeight;
    canvas.getContext('2d')?.drawImage(element, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) {
          const file = new File([blob], `roadwatch-capture-${Date.now()}.jpg`, {
            type: 'image/jpeg',
          });
          setShot(file);
          setShotUrl(URL.createObjectURL(file));
          stopCamera();
        }
      },
      'image/jpeg',
      0.92,
    );
  }
  function getLocation() {
    setLocationError('');
    setCaptureCoords(null);
    if (!navigator.geolocation) {
      setLocationError(
        'This browser cannot access device location. You can upload without it and place the observation during review.',
      );
      return;
    }
    setLocationPending(true);
    const acceptPosition = (position: GeolocationPosition) => {
      const { latitude, longitude, accuracy } = position.coords;
      if (
        ![latitude, longitude, accuracy].every(Number.isFinite) ||
        accuracy <= 0 ||
        accuracy > 10000
      ) {
        setLocationError(
          'The device location is too imprecise to use. You can upload without it and place the observation during review.',
        );
      } else {
        setCaptureCoords({ latitude, longitude, accuracy });
      }
      setLocationPending(false);
    };
    const showError = (error: GeolocationPositionError) => {
      setLocationError(
        error.code === 1
          ? 'Location permission is blocked. Allow location for this site in your browser and device settings, then try again.'
          : 'The device could not determine a position. Check Location Services and Wi-Fi, or upload without coordinates and place the observation during review.',
      );
      setLocationPending(false);
    };
    navigator.geolocation.getCurrentPosition(
      acceptPosition,
      (error) => {
        if (error.code === 1) return showError(error);
        navigator.geolocation.getCurrentPosition(acceptPosition, showError, {
          enableHighAccuracy: false,
          timeout: 20000,
          maximumAge: 0,
        });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    if (shot) form.set('file', shot);
    const file = form.get('file');
    if (!(file instanceof File) || !file.size) {
      setError('Choose a photo/video or capture a photo before uploading.');
      return;
    }
    if (file.size > 32 * 1024 * 1024) {
      setError('Evidence must be 32 MB or smaller. Keep the original and upload a shorter clip.');
      return;
    }
    if (!surveyId) {
      setError('Start a survey and select it before uploading.');
      return;
    }
    form.set('surveyId', surveyId);
    const captureTime = textField(form, 'capturedAt');
    form.set(
      'capturedAt',
      shot
        ? new Date(shot.lastModified).toISOString()
        : captureTime
          ? new Date(captureTime).toISOString()
          : new Date().toISOString(),
    );
    if (captureCoords) {
      form.set('latitude', String(captureCoords.latitude));
      form.set('longitude', String(captureCoords.longitude));
      form.set('locationAccuracyM', String(captureCoords.accuracy));
    }
    setBusy(true);
    setError('');
    try {
      await api('/uploads', { method: 'POST', body: form });
      setShot(null);
      setShotUrl('');
      setCaptureCoords(null);
      formElement.reset();
      await loadJobs();
      await changed('Evidence uploaded. Follow the processing job below.');
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Upload failed. Keep the original file and try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function finish(survey: Survey) {
    try {
      await write(`/surveys/${survey.id}/complete`, {});
      await changed(`Survey ${survey.name} completed.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Survey could not be completed.', 'error');
    }
  }
  return (
    <>
      <VisionStatus />
      <div className="capture-grid">
        <section className="content-panel">
          <div className="panel-heading">
            <div>
              <h2>Upload road evidence</h2>
              <span>Private media linked to a survey and capture time</span>
            </div>
            <Upload size={21} />
          </div>
          <form className="capture-form" onSubmit={upload}>
            <Field label="Survey">
              <select value={surveyId} onChange={(e) => setSurveyId(e.target.value)} required>
                <option value="">Select a survey</option>
                {data.surveys
                  .filter((s) => !['completed', 'closed'].includes(s.status))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </Field>
            <label className="upload-zone">
              <Upload size={28} />
              <strong>Choose a road photo or video</strong>
              <span>Original evidence with a known capture time · Up to 32 MB</span>
              <input
                name="file"
                type="file"
                accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"
                onChange={() => {
                  setShot(null);
                  setShotUrl('');
                }}
              />
            </label>
            {shot && (
              <div className="captured-preview">
                <Image
                  src={shotUrl}
                  width={220}
                  height={130}
                  alt="Photo captured for upload"
                  unoptimized
                />
                <span>{shot.name}</span>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => {
                    setShot(null);
                    setShotUrl('');
                  }}
                  aria-label="Remove captured photo"
                >
                  <Trash2 size={17} />
                </button>
              </div>
            )}
            <div className="form-grid">
              <Field label="Capture date and time">
                <input
                  type="datetime-local"
                  name="capturedAt"
                  required
                  defaultValue={new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
                    .toISOString()
                    .slice(0, 16)}
                />
              </Field>
              <Field
                label="Calibration ID (optional)"
                hint="Only use an approved calibration for this device."
              >
                <input name="calibrationId" placeholder="Leave blank if unavailable" />
              </Field>
            </div>
            <div className="capture-location">
              <button
                className="button secondary"
                type="button"
                onClick={getLocation}
                disabled={locationPending}
              >
                <Navigation size={15} />
                {locationPending ? 'Finding location…' : 'Use this device’s location'}
              </button>
              <span>
                {captureCoords
                  ? `${captureCoords.latitude.toFixed(5)}, ${captureCoords.longitude.toFixed(5)} · ±${Math.round(captureCoords.accuracy)} m`
                  : 'Only use if you are at the capture location.'}
              </span>
              {captureCoords && (
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Clear capture location"
                  onClick={() => setCaptureCoords(null)}
                >
                  <X size={15} />
                </button>
              )}
            </div>
            <ErrorMessage>{locationError || error}</ErrorMessage>
            <div className="form-actions">
              <span>Unknown measurements stay unknown.</span>
              <button
                className="button primary"
                disabled={
                  busy || !surveyId || !['admin', 'planner', 'crew'].includes(user?.role || '')
                }
              >
                {busy ? <LoaderCircle className="spin" size={17} /> : <Upload size={17} />}
                {busy ? 'Uploading…' : 'Upload evidence'}
              </button>
            </div>
          </form>
        </section>
        <section className="content-panel camera-panel">
          <div className="panel-heading">
            <div>
              <h2>Browser camera</h2>
              <span>Attended capture for field observations</span>
            </div>
            <Camera size={21} />
          </div>
          <div className={`camera-preview ${cameraOpen ? 'active' : ''}`}>
            <video ref={video} autoPlay playsInline muted hidden={!cameraOpen} />
            {!cameraOpen && (
              <>
                <div className="camera-reticle">
                  <Camera size={35} />
                </div>
                <h3>See it. Record it.</h3>
                <p>Connect your device camera to capture a road observation.</p>
              </>
            )}
          </div>
          <ErrorMessage>{cameraError}</ErrorMessage>
          <div className="camera-actions">
            {cameraOpen ? (
              <>
                <button className="button secondary" onClick={stopCamera}>
                  Stop camera
                </button>
                <button className="button primary" onClick={takePhoto}>
                  <Camera size={16} />
                  Capture photo
                </button>
              </>
            ) : (
              <button className="button primary" onClick={startCamera}>
                <Camera size={16} />
                Enable camera
              </button>
            )}
          </div>
          <p className="camera-note">
            Keep this page open while capturing. Vehicle and CCTV recording use their dedicated
            capture services.
          </p>
        </section>
      </div>
      <section className="content-panel">
        <div className="panel-heading">
          <div>
            <h2>Surveys</h2>
            <span>Capture sessions and observed coverage</span>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Survey</th>
                <th>Device</th>
                <th>Status</th>
                <th>Processed frames</th>
                <th>Detections</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.surveys.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.name}</strong>
                    <small>{time(s.startedAt)}</small>
                  </td>
                  <td>{data.devices.find((d) => d.id === s.deviceId)?.name || s.deviceId}</td>
                  <td>
                    <Badge value={s.status} />
                  </td>
                  <td>{s.framesProcessed}</td>
                  <td>{s.defectsDetected}</td>
                  <td>
                    {!['completed', 'closed'].includes(s.status) &&
                    ['admin', 'planner', 'crew'].includes(user?.role || '') ? (
                      <button className="button small secondary" onClick={() => finish(s)}>
                        Complete survey
                      </button>
                    ) : (
                      <span className="muted">{date(s.completedAt)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.surveys.length && (
          <Empty title="No surveys started">
            Start a survey using a registered capture device.
          </Empty>
        )}
      </section>
      <section className="content-panel">
        <div className="panel-heading">
          <div>
            <h2>Processing history</h2>
            <span>Failures retain the original evidence and an explicit reason</span>
          </div>
          <button className="button secondary small" onClick={loadJobs}>
            <RefreshCw size={15} />
            Refresh jobs
          </button>
        </div>
        <ErrorMessage>{jobsError}</ErrorMessage>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Result / reason</th>
                <th>Updated</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    <strong>{job.id.slice(0, 10)}</strong>
                    <small>{job.pipelineVersion || 'Pending pipeline'}</small>
                  </td>
                  <td>
                    <Badge value={job.status} />
                  </td>
                  <td>{job.attempts}</td>
                  <td className="job-error">
                    {job.error ||
                      (job.status === 'completed'
                        ? `${job.result?.detections?.length ?? 0} observations · ${job.result?.unlocatedDetections ?? 0} need location`
                        : 'Waiting for processing')}
                  </td>
                  <td>{time(job.updatedAt)}</td>
                  <td>
                    <div className="row-actions">
                      {job.result && (
                        <button
                          className="button small secondary"
                          onClick={() => setInspecting(job.id)}
                        >
                          Inspect result
                        </button>
                      )}
                      {['failed', 'dead_letter', 'blocked'].includes(job.status) &&
                        ['admin', 'planner'].includes(user?.role || '') && (
                          <button
                            className="button small secondary"
                            onClick={async () => {
                              try {
                                await write(`/jobs/${job.id}/retry`, {});
                                await loadJobs();
                                notify('Job queued for retry.');
                              } catch (e) {
                                notify(e instanceof Error ? e.message : 'Retry failed.', 'error');
                              }
                            }}
                          >
                            Retry job
                          </button>
                        )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!jobs.length && !jobsError && (
          <Empty icon={<Layers size={26} />} title="No processing jobs yet">
            Upload evidence to start a processing job.
          </Empty>
        )}
      </section>
      {inspecting && jobs.find((job) => job.id === inspecting) && (
        <JobObservations
          job={jobs.find((job) => job.id === inspecting)!}
          roads={data.roads}
          demo={data.isDemo}
          canLocate={['admin', 'reviewer'].includes(user?.role || '')}
          onClose={() => setInspecting(null)}
          onChanged={async () => {
            await loadJobs();
            await changed('Observation located and queued for defect review.');
          }}
        />
      )}
    </>
  );
}

function Maintenance({
  data,
  user,
  changed,
}: {
  data: DashboardData;
  user: User | null;
  changed: (message: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<WorkOrder | null>(null);
  const [action, setAction] = useState('start');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = data.workOrders.filter(
    (w) => !['closed', 'verified', 'completed'].includes(w.status),
  );
  const current = selected ? (data.workOrders.find((w) => w.id === selected.id) ?? selected) : null;
  const actions = (order: WorkOrder) =>
    ['open', 'planned', 'assigned', 'created'].includes(order.status)
      ? [{ key: 'start', title: 'Start work' }]
      : ['in_progress', 'started'].includes(order.status)
        ? [{ key: 'report_repair', title: 'Report repair' }]
        : order.status === 'repair_reported'
          ? [
              { key: 'verify', title: 'Verify repair' },
              { key: 'reopen', title: 'Return for rework' },
            ]
          : [{ key: 'reopen', title: 'Reopen work order' }];
  function choose(order: WorkOrder, value: string) {
    setSelected(order);
    setAction(value);
    setError('');
  }
  async function transition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current) return;
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await write(`/work-orders/${current.id}/transitions`, {
        action,
        notes: textField(form, 'notes'),
        expectedVersion: current.version,
      });
      setSelected(null);
      await changed(`${current.code}: ${human(action)} recorded.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transition could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="maintenance-summary">
        <div>
          <Wrench size={22} />
          <strong>{active.length}</strong>
          <span>active work orders</span>
        </div>
        <div>
          <Clock3 size={22} />
          <strong>{active.filter((w) => new Date(w.dueAt).getTime() < Date.now()).length}</strong>
          <span>past due date</span>
        </div>
        <div>
          <ClipboardCheck size={22} />
          <strong>{data.workOrders.filter((w) => w.status === 'repair_reported').length}</strong>
          <span>awaiting verification</span>
        </div>
        <div>
          <CheckCircle2 size={22} />
          <strong>{data.workOrders.length - active.length}</strong>
          <span>completed</span>
        </div>
      </div>
      <section className="content-panel">
        <div className="panel-heading">
          <div>
            <h2>Maintenance register</h2>
            <span>Confirmed defects, accountable assignments, verified outcomes</span>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Work order</th>
                <th>Crew</th>
                <th>Defects</th>
                <th>Status</th>
                <th>Due date</th>
                <th>Next step</th>
              </tr>
            </thead>
            <tbody>
              {data.workOrders.map((order) => (
                <tr key={order.id}>
                  <td>
                    <strong>{order.code}</strong>
                    <small className="truncate-cell">{order.description}</small>
                  </td>
                  <td>{order.crew}</td>
                  <td>
                    {order.defectIds.map((id) => (
                      <Link className="inline-defect-link" key={id} href={`/defects?id=${id}`}>
                        {data.defects.find((d) => d.id === id)?.code || id.slice(0, 8)}
                      </Link>
                    ))}
                  </td>
                  <td>
                    <Badge value={order.status} />
                  </td>
                  <td
                    className={
                      active.includes(order) && new Date(order.dueAt).getTime() < Date.now()
                        ? 'overdue'
                        : ''
                    }
                  >
                    {date(order.dueAt)}
                  </td>
                  <td>
                    <div className="row-actions">
                      {actions(order)
                        .filter((item) =>
                          ['start', 'report_repair'].includes(item.key)
                            ? ['admin', 'planner', 'crew'].includes(user?.role || '')
                            : ['admin', 'reviewer'].includes(user?.role || ''),
                        )
                        .map((item) => (
                          <button
                            className="button secondary small"
                            key={item.key}
                            disabled={item.key === 'verify' && order.repairReportedBy === user?.id}
                            title={
                              item.key === 'verify' && order.repairReportedBy === user?.id
                                ? 'A different authorized user must verify your repair.'
                                : undefined
                            }
                            onClick={() => choose(order, item.key)}
                          >
                            {item.title}
                          </button>
                        ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.workOrders.length && (
          <Empty icon={<Wrench size={28} />} title="No maintenance work orders">
            Confirm a defect, then assign it to a crew with a due date.
          </Empty>
        )}
        <div className="panel-note">
          <ShieldCheck size={16} />A repair must be verified by an authorized person other than the
          person who reported it complete.
        </div>
      </section>
      {current && (
        <Dialog
          title={`${human(action)} · ${current.code}`}
          subtitle="This change will be recorded with your identity and the work order version."
          onClose={() => setSelected(null)}
        >
          <form onSubmit={transition}>
            <Field label="Work notes">
              <textarea
                name="notes"
                rows={4}
                required
                minLength={5}
                placeholder="Describe the work, evidence, or verification outcome…"
              />
            </Field>
            <ErrorMessage>{error}</ErrorMessage>
            <div className="form-actions">
              <button className="button secondary" type="button" onClick={() => setSelected(null)}>
                Cancel
              </button>
              <Submit busy={busy}>Save {human(action).toLowerCase()}</Submit>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}

function Reports({
  data,
  notify,
}: {
  data: DashboardData;
  notify: (text: string, kind?: 'success' | 'error') => void;
}) {
  const [busy, setBusy] = useState('');
  const reports = [
    {
      id: 'csv',
      title: 'Defect register',
      description:
        'A formula-safe CSV for road owners and maintenance teams, with road identity, priority, condition and measurements.',
      path: '/reports/defects.csv',
      file: 'roadwatch-defects.csv',
      icon: FileText,
      format: 'CSV spreadsheet',
    },
    {
      id: 'summary',
      title: 'Operations snapshot',
      description:
        'A timestamped JSON summary of the road network, defects and maintenance activity for an accountable reporting record.',
      path: '/reports/summary',
      file: 'roadwatch-summary.json',
      icon: FileChartColumn,
      format: 'JSON report',
    },
    {
      id: 'geojson',
      title: 'Geospatial defect layer',
      description:
        'Authorized defect locations and attributes for your GIS workflow. Preserve measurement status when sharing.',
      path: '/reports/geojson',
      file: 'roadwatch-defects.geojson',
      icon: FileJson,
      format: 'GeoJSON dataset',
    },
  ];
  async function exportReport(report: (typeof reports)[number]) {
    setBusy(report.id);
    try {
      await download(report.path, report.file);
      notify(`${report.title} downloaded.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Download failed.', 'error');
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      <section className="report-intro">
        <div>
          <FileChartColumn size={34} />
          <h2>From observations to a shared record.</h2>
          <p>
            Export the current authorized workspace data. Reports keep unknown measurements explicit
            and follow your organization’s access permissions.
          </p>
        </div>
        <dl>
          <div>
            <dt>Roads</dt>
            <dd>{data.roads.length}</dd>
          </div>
          <div>
            <dt>Defect records</dt>
            <dd>{data.defects.length}</dd>
          </div>
          <div>
            <dt>Work orders</dt>
            <dd>{data.workOrders.length}</dd>
          </div>
        </dl>
      </section>
      <section className="content-panel report-list">
        {reports.map((report) => (
          <article key={report.id}>
            <div className="report-icon">
              <report.icon size={29} />
            </div>
            <div>
              <span className="report-format">{report.format}</span>
              <h3>{report.title}</h3>
              <p>{report.description}</p>
            </div>
            <button
              className="button secondary"
              disabled={!!busy}
              onClick={() => exportReport(report)}
            >
              {busy === report.id ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <ArrowDownToLine size={17} />
              )}
              Download
            </button>
          </article>
        ))}
      </section>
      <div className="panel-note">
        <ShieldCheck size={17} />
        Source licenses and permissions determine which geographic information may be redistributed.{' '}
        {data.isDemo && 'Exports from this workspace contain illustrative demonstration records.'}
      </div>
    </>
  );
}

function Administration({
  user,
  changed,
}: {
  user: User | null;
  changed: (message: string) => Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, events] = await Promise.all([
        api<Settings>('/settings'),
        api<AuditEvent[]>('/audit'),
      ]);
      setSettings(s);
      setAudit(events);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Administration could not load.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await write(
        '/settings',
        {
          organizationName: textField(form, 'organizationName'),
          defaultRegion: textField(form, 'defaultRegion'),
          retentionDays: numeric(form, 'retentionDays'),
        },
        'PATCH',
      );
      await refresh();
      await changed('Organization settings saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Settings could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ErrorMessage>{error}</ErrorMessage>
      {loading && (
        <div className="section-loading">
          <LoaderCircle className="spin" size={22} />
          Loading organization settings…
        </div>
      )}
      {settings && (
        <section className="content-panel settings-panel">
          <div className="panel-heading">
            <div>
              <h2>Organization settings</h2>
              <span>Shared across the road operations workspace</span>
            </div>
            <ShieldCheck size={20} />
          </div>
          <form onSubmit={save}>
            <div className="form-grid">
              <Field label="Organization name">
                <input
                  name="organizationName"
                  defaultValue={settings.organizationName}
                  required
                  disabled={user?.role !== 'admin'}
                />
              </Field>
              <Field label="Default region">
                <input
                  name="defaultRegion"
                  defaultValue={settings.defaultRegion}
                  required
                  disabled={user?.role !== 'admin'}
                />
              </Field>
              <Field
                label="Evidence retention policy (days)"
                hint="Policy setting only. Automatic evidence deletion is not enabled; retention changes are audited."
              >
                <input
                  name="retentionDays"
                  type="number"
                  min="1"
                  max="3650"
                  defaultValue={settings.retentionDays}
                  required
                  disabled={user?.role !== 'admin'}
                />
              </Field>
            </div>
            <div className="form-actions">
              <span>
                <ShieldCheck size={15} />
                Administrator access required to change settings.
              </span>
              {user?.role === 'admin' && <Submit busy={busy}>Save settings</Submit>}
            </div>
          </form>
        </section>
      )}
      {user?.role === 'admin' && <UserManagement currentUserId={user.id} />}
      <section className="content-panel">
        <div className="panel-heading">
          <div>
            <h2>Audit trail</h2>
            <span>Who changed what, and when</span>
          </div>
          <button className="button secondary small" onClick={refresh}>
            <RefreshCw size={15} />
            Refresh
          </button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Record type</th>
                <th>Record ID</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((event) => (
                <tr key={event.id}>
                  <td>{time(event.createdAt)}</td>
                  <td>{typeof event.actor === 'string' ? event.actor : 'Workspace user'}</td>
                  <td>{human(event.action)}</td>
                  <td>{human(event.entityType)}</td>
                  <td className="audit-id">{event.entityId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!audit.length && !loading && (
          <Empty icon={<ShieldCheck size={26} />} title="No audit entries available">
            Authorized changes will appear in this register.
          </Empty>
        )}
      </section>
    </>
  );
}

function CreateDialog({
  kind,
  data,
  onClose,
  onDone,
}: {
  kind: Exclude<Modal, null>;
  data: DashboardData;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [token, setToken] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const titles: Record<Exclude<Modal, null>, string> = {
    report: 'Report a road defect',
    device: 'Register a capture device',
    survey: 'Start a road survey',
    import: 'Import a road network',
    'work-order': 'Create a maintenance work order',
  };
  const confirmed = data.defects.filter((d) => d.status === 'confirmed');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      if (kind === 'report') {
        await write('/defects', {
          roadId: textField(form, 'roadId'),
          type: textField(form, 'type'),
          latitude: numeric(form, 'latitude'),
          longitude: numeric(form, 'longitude'),
          description: textField(form, 'description'),
          lengthM: numeric(form, 'lengthM'),
          widthM: numeric(form, 'widthM'),
          depthMm: numeric(form, 'depthMm'),
        });
        await onDone('Defect reported and queued for review.');
      }
      if (kind === 'device') {
        const result = await write<{
          token?: string;
          deviceToken?: string;
          provisioningToken?: string;
          id?: string;
          device?: { id: string };
        }>('/devices', {
          name: textField(form, 'name'),
          kind: textField(form, 'kind'),
          vehiclePlate: textField(form, 'vehiclePlate') || undefined,
          cameraModel: textField(form, 'cameraModel') || undefined,
        });
        setToken(result.token || result.deviceToken || result.provisioningToken || '');
        setDeviceId(result.id || result.device?.id || '');
        if (!(result.token || result.deviceToken || result.provisioningToken))
          await onDone(
            'Device registered. Use the provisioning response to configure the capture service.',
          );
      }
      if (kind === 'survey') {
        const roadIds = form.getAll('roadIds').map(String);
        if (!roadIds.length) throw new Error('Select at least one road for this survey.');
        await write('/surveys', {
          deviceId: textField(form, 'deviceId'),
          name: textField(form, 'name'),
          roadIds,
        });
        await onDone('Survey started. You can now upload evidence.');
      }
      if (kind === 'import') {
        const file = form.get('geojson');
        const raw =
          file instanceof File && file.size ? await file.text() : textField(form, 'geometry');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error('Enter a valid GeoJSON FeatureCollection or choose a .geojson file.');
        }
        await write('/roads/import', parsed);
        await onDone('Road geometry imported and segments created.');
      }
      if (kind === 'work-order') {
        const defectIds = form.getAll('defectIds').map(String);
        if (!defectIds.length) throw new Error('Select at least one confirmed defect.');
        await write('/work-orders', {
          defectIds,
          crew: textField(form, 'crew'),
          description: textField(form, 'description'),
          dueAt: new Date(textField(form, 'dueAt')).toISOString(),
        });
        await onDone('Work order created and defects assigned.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The record could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={titles[kind]}
      subtitle={
        kind === 'report'
          ? 'Record what you observed. Manually entered measurements remain estimated.'
          : undefined
      }
      onClose={onClose}
    >
      {token ? (
        <div className="provisioning">
          <ShieldCheck size={35} />
          <h3>Device registered</h3>
          <p>Copy this credential now. It is shown once and authenticates the capture device.</p>
          <Field label="Device ID">
            <input value={deviceId} readOnly />
          </Field>
          <Field label="One-time device token">
            <textarea value={token} readOnly rows={4} />
          </Field>
          <div className="form-actions">
            <button
              className="button secondary"
              onClick={() => {
                void navigator.clipboard
                  .writeText(token)
                  .catch(() =>
                    setError('Clipboard unavailable. Select and copy the token manually.'),
                  );
              }}
            >
              Copy token
            </button>
            <button
              className="button primary"
              onClick={() => onDone('Device registered. Store its credential securely.')}
            >
              I have saved the token
            </button>
          </div>
          <ErrorMessage>{error}</ErrorMessage>
        </div>
      ) : (
        <form onSubmit={submit}>
          <div className="form-grid">
            {kind === 'report' && (
              <>
                <Field label="Road">
                  <select name="roadId" required defaultValue="">
                    <option value="" disabled>
                      Select the road
                    </option>
                    {data.roads.map((r) => (
                      <option value={r.id} key={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Defect type">
                  <select name="type">
                    {defectTypes.map((type) => (
                      <option value={type} key={type}>
                        {human(type)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Latitude">
                  <input
                    name="latitude"
                    type="number"
                    step="any"
                    min="-90"
                    max="90"
                    required
                    placeholder="17.430000"
                  />
                </Field>
                <Field label="Longitude">
                  <input
                    name="longitude"
                    type="number"
                    step="any"
                    min="-180"
                    max="180"
                    required
                    placeholder="78.400000"
                  />
                </Field>
                <Field label="Estimated length (m)">
                  <input
                    name="lengthM"
                    type="number"
                    step="0.001"
                    min="0.001"
                    placeholder="Unknown"
                  />
                </Field>
                <Field label="Estimated width (m)">
                  <input
                    name="widthM"
                    type="number"
                    step="0.001"
                    min="0.001"
                    placeholder="Unknown"
                  />
                </Field>
                <Field
                  label="Estimated depth (mm)"
                  hint="Leave blank when depth cannot be measured."
                >
                  <input name="depthMm" type="number" step="0.1" min="0.1" placeholder="Unknown" />
                </Field>
                <Field label="Observation notes" wide>
                  <textarea
                    name="description"
                    rows={3}
                    placeholder="Describe the road condition and nearby reference points…"
                    required
                    minLength={5}
                  />
                </Field>
              </>
            )}
            {kind === 'device' && (
              <>
                <Field label="Device name">
                  <input name="name" placeholder="Survey vehicle 04" required />
                </Field>
                <Field label="Device type">
                  <select name="kind">
                    <option value="vehicle">Vehicle camera</option>
                    <option value="cctv">Fixed CCTV camera</option>
                    <option value="mobile">Mobile device</option>
                  </select>
                </Field>
                <Field label="Vehicle registration (optional)">
                  <input name="vehiclePlate" placeholder="Vehicle plate" />
                </Field>
                <Field label="Camera model (optional)">
                  <input name="cameraModel" placeholder="Manufacturer and model" />
                </Field>
              </>
            )}
            {kind === 'survey' && (
              <>
                <Field label="Survey name" wide>
                  <input name="name" placeholder="Morning road condition survey" required />
                </Field>
                <Field label="Capture device" wide>
                  <select name="deviceId" required defaultValue="">
                    <option value="" disabled>
                      Select a registered device
                    </option>
                    {data.devices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <fieldset className="checkbox-list wide">
                  <legend>Roads to survey</legend>
                  {data.roads.map((r) => (
                    <label key={r.id}>
                      <input type="checkbox" name="roadIds" value={r.id} />
                      <span>
                        {r.name}
                        <small>{r.code}</small>
                      </span>
                    </label>
                  ))}
                  {!data.roads.length && <p>Import roads before starting a survey.</p>}
                </fieldset>
              </>
            )}
            {kind === 'import' && (
              <>
                <div className="form-explainer wide">
                  <Route size={22} />
                  <p>
                    Upload an authorized GeoJSON FeatureCollection. Each road must contain a
                    LineString geometry and name, code, owner, and region properties. Coordinates
                    use longitude, then latitude.
                  </p>
                </div>
                <Field label="GeoJSON file" wide>
                  <input
                    name="geojson"
                    type="file"
                    accept=".geojson,.json,application/geo+json,application/json"
                  />
                </Field>
                <Field label="Or paste GeoJSON" wide>
                  <textarea
                    name="geometry"
                    rows={8}
                    spellCheck={false}
                    placeholder={'{ "type": "FeatureCollection", "features": […] }'}
                  />
                </Field>
                <div className="wide panel-note">
                  Only import data your organization is authorized to store, process, and display.
                </div>
              </>
            )}
            {kind === 'work-order' && (
              <>
                <Field label="Assigned crew">
                  <input name="crew" placeholder="Road maintenance team" required />
                </Field>
                <Field label="Due date">
                  <input name="dueAt" type="date" required />
                </Field>
                <Field label="Work description" wide>
                  <textarea
                    name="description"
                    required
                    rows={3}
                    placeholder="Describe the maintenance scope and instructions…"
                  />
                </Field>
                <fieldset className="checkbox-list wide">
                  <legend>Confirmed defects to repair</legend>
                  {confirmed.map((d) => (
                    <label key={d.id}>
                      <input type="checkbox" name="defectIds" value={d.id} />
                      <span>
                        {d.code} · {human(d.type)}
                        <small>{d.roadName}</small>
                      </span>
                      <Badge value={d.priority} />
                    </label>
                  ))}
                  {!confirmed.length && (
                    <p>
                      No unassigned confirmed defects. Confirm a defect in the review queue first.
                    </p>
                  )}
                </fieldset>
              </>
            )}
          </div>
          <ErrorMessage>{error}</ErrorMessage>
          <div className="form-actions">
            <button type="button" className="button secondary" onClick={onClose}>
              Cancel
            </button>
            <Submit busy={busy}>
              {
                (
                  {
                    report: 'Save observation',
                    device: 'Register device',
                    survey: 'Start survey',
                    import: 'Import road network',
                    'work-order': 'Create work order',
                  } as Record<string, string>
                )[kind]
              }
            </Submit>
          </div>
        </form>
      )}
    </Dialog>
  );
}
