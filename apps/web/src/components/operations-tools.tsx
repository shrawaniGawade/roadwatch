'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { Device, Evidence, Job, Measurement, Road } from '@roadwatch/domain';
import {
  Bell,
  Check,
  CircleAlert,
  Eye,
  LoaderCircle,
  MapPin,
  Plus,
  RefreshCw,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { api, write } from '@/lib/api';
import { Badge, Dialog, Empty, ErrorMessage, Field, Submit } from './ui';
import RoadMap from './road-map';

const human = (value?: string) =>
  (value || 'Unknown').replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase());
const date = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
const text = (form: FormData, key: string) => String(form.get(key) || '').trim();
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The request could not be completed.';

interface Notification {
  id: string;
  title: string;
  body: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  acknowledgedAt: string | null;
}
export function Alerts({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api<Notification[]>('/notifications'));
      setError('');
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function acknowledge(id: string) {
    setBusy(id);
    try {
      await write(`/notifications/${id}/acknowledge`, {});
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy('');
    }
  }
  return (
    <Dialog
      title="Workspace alerts"
      subtitle="Internal operational alerts generated from this workspace."
      onClose={onClose}
    >
      <ErrorMessage>{error}</ErrorMessage>
      <div className="alerts-toolbar">
        <span>{items.filter((item) => !item.acknowledgedAt).length} unread</span>
        <button className="button secondary small" disabled={loading} onClick={refresh}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>
      {loading && !items.length ? (
        <div className="section-loading">
          <LoaderCircle className="spin" size={20} />
          Loading alerts…
        </div>
      ) : (
        <div className="alerts-list">
          {items.map((item) => (
            <article key={item.id} className={item.acknowledgedAt ? 'acknowledged' : ''}>
              <span className="alert-icon">
                <Bell size={18} />
              </span>
              <div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
                <small>{date(item.createdAt)}</small>
                <div className="row-actions">
                  {['defect', 'work_order', 'device', 'survey', 'job'].includes(
                    item.entityType,
                  ) && (
                    <Link
                      className="text-link"
                      onClick={onClose}
                      href={`/${({ defect: 'defects', work_order: 'maintenance', device: 'fleet', survey: 'surveys', job: 'surveys' } as Record<string, string>)[item.entityType]}?id=${item.entityId}`}
                    >
                      View record
                    </Link>
                  )}
                  {!item.acknowledgedAt && (
                    <button
                      className="button small secondary"
                      disabled={!!busy}
                      onClick={() => acknowledge(item.id)}
                    >
                      {busy === item.id ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <Check size={14} />
                      )}
                      Mark read
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
          {!items.length && (
            <Empty icon={<Bell size={27} />} title="You're up to date">
              New operational alerts will appear here.
            </Empty>
          )}
        </div>
      )}
      <p className="panel-note">
        Email, SMS, and external messaging are not configured in this workspace.
      </p>
    </Dialog>
  );
}

interface Account {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  createdAt: string;
}
export function UserManagement({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const refresh = useCallback(async () => {
    try {
      setUsers(await api<Account[]>('/users'));
      setError('');
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  function edit(account: Account | 'new') {
    setEditing(account);
    setSaveError('');
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setSaveError('');
    try {
      const fields = {
        name: text(form, 'name'),
        role: text(form, 'role'),
        active: form.get('active') === 'on',
      };
      const password = String(form.get('password') || '');
      if (editing === 'new')
        await write('/users', {
          name: fields.name,
          role: fields.role,
          email: text(form, 'email'),
          password,
        });
      else {
        const changes: Record<string, unknown> = {};
        if (fields.name !== editing.name) changes.name = fields.name;
        if (fields.role !== editing.role) changes.role = fields.role;
        if (fields.active !== editing.active) changes.active = fields.active;
        if (password) changes.password = password;
        if (!Object.keys(changes).length) {
          setEditing(null);
          return;
        }
        await write(`/users/${editing.id}`, changes, 'PATCH');
        if (
          editing.id === currentUserId &&
          ('role' in changes || 'active' in changes || 'password' in changes)
        ) {
          window.location.assign('/login');
          return;
        }
      }
      setEditing(null);
      await refresh();
    } catch (e) {
      setSaveError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const account = editing && editing !== 'new' ? editing : null;
  return (
    <section className="content-panel">
      <div className="panel-heading">
        <div>
          <h2>Workspace users</h2>
          <span>Roles determine access to review, planning, and field work</span>
        </div>
        <button className="button secondary small" onClick={() => edit('new')}>
          <Plus size={16} />
          Add user
        </button>
      </div>
      <ErrorMessage>{error}</ErrorMessage>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Role</th>
              <th>Access</th>
              <th>Created</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <strong>
                    {user.name}
                    {user.id === currentUserId && <small className="inline-label">You</small>}
                  </strong>
                  <small>{user.email}</small>
                </td>
                <td>{human(user.role)}</td>
                <td>
                  <Badge value={user.active ? 'active' : 'offline'}>
                    {user.active ? 'Active' : 'Deactivated'}
                  </Badge>
                </td>
                <td>{date(user.createdAt)}</td>
                <td>
                  <button className="button secondary small" onClick={() => edit(user)}>
                    Edit access
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && (
        <div className="section-loading">
          <LoaderCircle size={20} className="spin" />
          Loading users…
        </div>
      )}
      {!loading && !users.length && !error && (
        <Empty icon={<Users size={27} />} title="No accounts available" />
      )}
      {editing && (
        <Dialog
          title={account ? `Edit ${account.name}` : 'Add a workspace user'}
          subtitle="Account changes are audited. Passwords must contain at least 12 characters."
          onClose={() => setEditing(null)}
        >
          <form onSubmit={save}>
            <div className="form-grid">
              <Field label="Full name">
                <input
                  name="name"
                  autoComplete="off"
                  minLength={2}
                  maxLength={120}
                  defaultValue={account?.name || ''}
                  required
                />
              </Field>
              <Field label="Email address">
                <input
                  name="email"
                  type="email"
                  autoComplete="off"
                  defaultValue={account?.email || ''}
                  disabled={!!account}
                  required
                />
              </Field>
              <Field label="Role">
                <select name="role" defaultValue={account?.role || 'viewer'}>
                  {['viewer', 'crew', 'reviewer', 'planner', 'admin'].map((role) => (
                    <option key={role} value={role}>
                      {human(role)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label={account ? 'New password (optional)' : 'Initial password'}
                hint={
                  account
                    ? 'Leave blank to keep the existing password.'
                    : 'Provide this credential through your approved account provisioning process.'
                }
              >
                <input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={1024}
                  required={!account}
                />
              </Field>
              {account && (
                <label className="checkbox-inline wide">
                  <input name="active" type="checkbox" defaultChecked={account.active} />
                  <span>Account has workspace access</span>
                </label>
              )}
            </div>
            <div className="panel-note">
              <ShieldCheck size={16} />
              Changes to access, role, or password end the affected user’s existing sessions.
            </div>
            <ErrorMessage>{saveError}</ErrorMessage>
            <div className="form-actions">
              <button type="button" className="button secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <Submit busy={busy}>{account ? 'Save account' : 'Create account'}</Submit>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}

export function DeviceControls({
  device,
  onChanged,
}: {
  device: Device;
  onChanged: (message: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState('calibration');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [token, setToken] = useState('');
  const [calibrationId, setCalibrationId] = useState('');
  const [copied, setCopied] = useState(false);
  function close() {
    setOpen(false);
    setToken('');
    setCalibrationId('');
    setError('');
    setCopied(false);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      if (action === 'rotate') {
        const result = await write<{ token: string }>(`/devices/${device.id}/rotate-token`, {});
        setToken(result.token);
        await onChanged(
          'Device credential rotated. Configure the replacement token on the device.',
        );
      } else if (action === 'revoke') {
        await write(`/devices/${device.id}/revoke`, { reason: text(form, 'reason') });
        close();
        await onChanged('Device access revoked.');
      } else {
        let projection: unknown;
        if (text(form, 'projection')) {
          try {
            projection = JSON.parse(text(form, 'projection'));
          } catch {
            throw new Error('Projection parameters must be valid JSON.');
          }
        }
        const response = await write<{ id: string }>('/calibrations', {
          deviceId: device.id,
          name: text(form, 'name') || undefined,
          method: text(form, 'method'),
          cameraHeightM: text(form, 'cameraHeightM')
            ? Number(text(form, 'cameraHeightM'))
            : undefined,
          validUntil: text(form, 'validUntil')
            ? new Date(text(form, 'validUntil')).toISOString()
            : undefined,
          notes: text(form, 'notes') || undefined,
          projection,
        });
        setCalibrationId(response.id);
        await onChanged('Calibration metadata recorded. Field validation remains required.');
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="button secondary small" onClick={() => setOpen(true)}>
        Manage device
      </button>
      {open && (
        <Dialog
          title={device.name}
          subtitle="Manage credentials and declared calibration records."
          onClose={close}
        >
          {token ? (
            <div className="provisioning">
              <ShieldCheck size={28} />
              <h3>Replacement device credential</h3>
              <p>
                The previous token is invalid. Save this replacement now; it is shown only once.
              </p>
              <Field label="Device ID">
                <input value={device.id} readOnly />
              </Field>
              <Field label="One-time device token">
                <textarea readOnly value={token} rows={3} />
              </Field>
              <div className="form-actions">
                <button
                  className="button secondary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(token);
                      setCopied(true);
                    } catch {
                      setError(
                        'Select and copy the token manually; clipboard access is unavailable.',
                      );
                    }
                  }}
                >
                  {copied ? 'Copied' : 'Copy token'}
                </button>
                <button className="button primary" onClick={close}>
                  I have saved the token
                </button>
              </div>
            </div>
          ) : calibrationId ? (
            <div className="provisioning">
              <ShieldCheck size={28} />
              <h3>Calibration metadata recorded</h3>
              <p>
                Use this ID with uploads from this device. Recording metadata does not verify
                physical calibration or authorize sensor measurements.
              </p>
              <Field label="Calibration ID">
                <input value={calibrationId} readOnly />
              </Field>
              <div className="form-actions">
                <button className="button primary" onClick={close}>
                  Done
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={submit}>
              <Field label="Device action">
                <select
                  value={action}
                  onChange={(event) => {
                    setAction(event.target.value);
                    setError('');
                  }}
                >
                  <option value="calibration">Record calibration metadata</option>
                  <option value="rotate">Rotate access credential</option>
                  <option value="revoke">Revoke device access</option>
                </select>
              </Field>
              {action === 'calibration' ? (
                <>
                  <div className="form-grid">
                    <Field label="Calibration name">
                      <input
                        name="name"
                        maxLength={120}
                        placeholder="Front camera · September inspection"
                      />
                    </Field>
                    <Field label="Calibration method">
                      <input
                        name="method"
                        minLength={2}
                        maxLength={100}
                        required
                        placeholder="Describe the calibration procedure"
                      />
                    </Field>
                    <Field label="Camera height (m)">
                      <input name="cameraHeightM" type="number" step="any" min="0.001" max="10" />
                    </Field>
                    <Field label="Declared valid until">
                      <input name="validUntil" type="datetime-local" />
                    </Field>
                  </div>
                  <Field label="Calibration notes">
                    <textarea
                      name="notes"
                      rows={3}
                      maxLength={4000}
                      placeholder="Record target measurements, equipment, and the calibration evidence reference."
                    />
                  </Field>
                  <Field
                    label="Planar projection parameters (optional JSON)"
                    hint="Supply tested image dimensions, a 3 × 3 imageToGround matrix, validRoi, uncertainty95M, and validUntil from the calibration process."
                  >
                    <textarea
                      name="projection"
                      rows={5}
                      spellCheck={false}
                      placeholder="Leave blank if no qualified projection is available"
                    />
                  </Field>
                  <div className="panel-note">
                    Declared parameters yield estimates. Independent field validation is required
                    for operational acceptance.
                  </div>
                </>
              ) : action === 'rotate' ? (
                <div className="form-explainer">
                  <ShieldCheck size={24} />
                  <p>
                    Rotating the credential immediately invalidates the old token. The camera or
                    capture service must be configured with the new token to resume uploads.
                  </p>
                </div>
              ) : (
                <>
                  <div className="form-explainer">
                    <ShieldCheck size={24} />
                    <p>
                      Revocation prevents this device from authenticating. Existing survey evidence
                      remains available. An administrator can later rotate the credential to restore
                      access.
                    </p>
                  </div>
                  <Field label="Revocation reason">
                    <textarea name="reason" rows={3} minLength={3} maxLength={1000} required />
                  </Field>
                </>
              )}
              <ErrorMessage>{error}</ErrorMessage>
              <div className="form-actions">
                <button className="button secondary" type="button" onClick={close}>
                  Cancel
                </button>
                <Submit busy={busy}>
                  {action === 'calibration'
                    ? 'Record calibration'
                    : action === 'rotate'
                      ? 'Rotate credential'
                      : 'Revoke access'}
                </Submit>
              </div>
            </form>
          )}
          {(token || calibrationId) && <ErrorMessage>{error}</ErrorMessage>}
        </Dialog>
      )}
    </>
  );
}

export function EvidenceMedia({ evidence, code }: { evidence: Evidence; code: string }) {
  const item = evidence as Evidence & { timeOffsetMs?: number };
  const video = useRef<HTMLVideoElement>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [failed, setFailed] = useState(false);
  const [dimensions, setDimensions] = useState({
    width: evidence.width || 1280,
    height: evidence.height || 720,
  });
  const isVideo = evidence.mimeType?.startsWith('video/');
  const source = evidence.url?.startsWith('/v1/')
    ? `/api${evidence.url}`
    : evidence.url || `/api/v1/media/${evidence.mediaId}`;
  const showMask = !isVideo || Math.abs(currentMs - (item.timeOffsetMs || 0)) < 150;
  return (
    <figure>
      <div
        className="observation-media defect-evidence-media"
        style={{ aspectRatio: `${dimensions.width} / ${dimensions.height}` }}
      >
        {failed ? (
          <ErrorMessage>
            Evidence could not load. Refresh the record or check your workspace connection.
          </ErrorMessage>
        ) : isVideo ? (
          <video
            ref={video}
            src={source}
            controls
            preload="metadata"
            onError={() => setFailed(true)}
            onTimeUpdate={(event) => setCurrentMs(event.currentTarget.currentTime * 1000)}
            onLoadedMetadata={(event) => {
              const element = event.currentTarget;
              setDimensions({ width: element.videoWidth, height: element.videoHeight });
              element.currentTime = (item.timeOffsetMs || 0) / 1000;
            }}
          />
        ) : (
          <img
            src={source}
            alt={`Road evidence for ${code}`}
            onError={() => setFailed(true)}
            onLoad={(event) =>
              setDimensions({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
          />
        )}
        {!failed && showMask && evidence.mask && evidence.mask.length >= 3 && (
          <svg
            className="observation-overlay"
            viewBox={`0 0 ${evidence.width || dimensions.width} ${evidence.height || dimensions.height}`}
            aria-label="Retained model observation outline"
          >
            <polygon
              points={evidence.mask.map((pair) => pair.join(',')).join(' ')}
              fill="#ed792d33"
              stroke="#ff852f"
              strokeWidth={Math.max(dimensions.width / 350, 2)}
            />
          </svg>
        )}
      </div>
      <figcaption>
        {evidence.filename}
        <span>{date(evidence.capturedAt)}</span>
      </figcaption>
    </figure>
  );
}

type Detection = {
  type: string;
  confidence: number;
  mask?: number[][];
  bbox?: number[];
  widthPx?: number;
  heightPx?: number;
  timeOffsetMs?: number;
  frameIndex?: number;
  length?: Measurement;
  width?: Measurement;
  depth?: Measurement;
  area?: Measurement;
};
export type ProcessingJob = Job & {
  result?: {
    detections?: Detection[];
    model?: { name: string; version: string; validationStatus?: string };
    quality?: { eligible: boolean; reasons: string[] };
    createdDefects?: number;
    unlocatedDetections?: number;
    observationDefectIds?: Record<string, string>;
    defectIds?: string[];
    note?: string;
    frameCount?: number;
  } | null;
};

export function VisionStatus() {
  const [status, setStatus] = useState<{
    ready?: boolean;
    reason?: string;
    model?: { name: string; version: string; validationStatus?: string };
  } | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const result = await api<{ vision: NonNullable<typeof status> }>('/ready');
      setStatus(result.vision);
      setError('');
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <div
      className={`vision-status ${status?.model?.validationStatus === 'experimental' || !status?.ready ? 'caution' : ''}`}
    >
      <ShieldCheck size={22} />
      <div>
        <strong>
          {status?.ready
            ? `Connected model · ${status.model?.name || 'Road detection'}`
            : status
              ? 'Road model is not ready'
              : 'Checking model availability…'}
        </strong>
        <p>
          {error ||
            (status?.ready
              ? status.model?.validationStatus === 'experimental'
                ? 'Experimental model. Review every observation and complete field validation before operational use. Dimensions and location require qualified evidence.'
                : `Version ${status.model?.version || 'unavailable'} · All observations require review before maintenance planning.`
              : status?.reason
                ? `${human(status.reason)}. Uploads retain their evidence and processing status.`
                : 'Loading the configured processing service.')}
        </p>
      </div>
      <button className="icon-button" aria-label="Refresh model status" onClick={refresh}>
        <RefreshCw size={17} />
      </button>
    </div>
  );
}

export function JobObservations({
  job,
  roads,
  canLocate,
  demo,
  onClose,
  onChanged,
}: {
  job: ProcessingJob;
  roads: Road[];
  canLocate: boolean;
  demo: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [index, setIndex] = useState(0);
  const [source, setSource] = useState('');
  const [videoMedia, setVideoMedia] = useState(false);
  const [size, setSize] = useState({ width: 1280, height: 720 });
  const [timeOffset, setTimeOffset] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [roadId, setRoadId] = useState('');
  const [point, setPoint] = useState<{ latitude: number; longitude: number } | null>(null);
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const result = job.result;
  const detections = result?.detections || [];
  const detection = detections[index];
  const defectId = result?.observationDefectIds?.[String(index)];
  useEffect(() => {
    let live = true;
    let url = '';
    const controller = new AbortController();
    void fetch(`/api/v1/media/${job.mediaId}`, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Original evidence could not load.');
        return response.blob();
      })
      .then((blob) => {
        if (!live) return;
        url = URL.createObjectURL(blob);
        setSource(url);
        setVideoMedia(blob.type.startsWith('video/'));
      })
      .catch((e) => {
        if (live) setError(message(e));
      });
    return () => {
      live = false;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [job.mediaId]);
  useEffect(() => {
    setPoint(null);
    setError('');
    if (video.current && detection) {
      video.current.pause();
      video.current.currentTime = (detection.timeOffsetMs || 0) / 1000;
    }
  }, [index, job.id]);
  useEffect(() => {
    setLatitude(point ? String(point.latitude) : '');
    setLongitude(point ? String(point.longitude) : '');
  }, [point]);
  const width = detection?.widthPx || size.width;
  const height = detection?.heightPx || size.height;
  const showOverlay = !videoMedia || Math.abs(timeOffset - (detection?.timeOffsetMs || 0)) < 150;
  async function locate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await write(`/jobs/${job.id}/observations/${index}/locate`, {
        roadId,
        latitude: Number(text(form, 'latitude')),
        longitude: Number(text(form, 'longitude')),
        description: text(form, 'description'),
      });
      await onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      wide
      title="Inspect processing evidence"
      subtitle={`Job ${job.id.slice(0, 10)} · ${result?.model?.name || job.pipelineVersion} · ${detections.length} observation(s)`}
      onClose={onClose}
    >
      {result?.model?.validationStatus === 'experimental' && (
        <div className="demo-banner">
          <CircleAlert size={17} />
          <span>
            <strong>Experimental model.</strong> Its output is an observation for review. Field
            validation is required.
          </span>
        </div>
      )}
      <ErrorMessage>{error}</ErrorMessage>
      <div className="observation-layout">
        <div>
          <div className="observation-media" style={{ aspectRatio: `${width} / ${height}` }}>
            {source ? (
              videoMedia ? (
                <video
                  ref={video}
                  src={source}
                  controls
                  preload="metadata"
                  onTimeUpdate={(event) => setTimeOffset(event.currentTarget.currentTime * 1000)}
                  onLoadedMetadata={(event) => {
                    const element = event.currentTarget;
                    setSize({ width: element.videoWidth, height: element.videoHeight });
                    element.currentTime = (detection?.timeOffsetMs || 0) / 1000;
                  }}
                />
              ) : (
                <img
                  src={source}
                  alt="Original road survey evidence with selected model observation"
                  onLoad={(event) =>
                    setSize({
                      width: event.currentTarget.naturalWidth,
                      height: event.currentTarget.naturalHeight,
                    })
                  }
                />
              )
            ) : (
              <div className="section-loading">
                <LoaderCircle className="spin" size={23} />
                Loading original evidence…
              </div>
            )}
            {detection && showOverlay && (
              <svg
                className="observation-overlay"
                viewBox={`0 0 ${width} ${height}`}
                aria-label="Selected model observation outline"
              >
                {detection.mask && detection.mask.length >= 3 ? (
                  <polygon
                    points={detection.mask.map((pair) => pair.join(',')).join(' ')}
                    fill="#ed792d33"
                    stroke="#ff852f"
                    strokeWidth={Math.max(width / 350, 2)}
                  />
                ) : detection.bbox?.length === 4 ? (
                  <rect
                    x={detection.bbox[0]}
                    y={detection.bbox[1]}
                    width={detection.bbox[2] - detection.bbox[0]}
                    height={detection.bbox[3] - detection.bbox[1]}
                    fill="#ed792d22"
                    stroke="#ff852f"
                    strokeWidth={Math.max(width / 350, 2)}
                  />
                ) : null}
              </svg>
            )}
          </div>
          <p className="media-caption">
            Original retained evidence · Outline shows the selected model observation
            {videoMedia ? ' at its sampled video frame.' : '.'}
          </p>
          {result?.quality && (
            <div className="quality-result">
              <Badge value={result.quality.eligible ? 'clear' : 'unknown'}>
                {result.quality.eligible
                  ? 'Passed image quality checks'
                  : 'Image quality needs attention'}
              </Badge>
              {result.quality.reasons.map((reason, i) => (
                <p key={`${reason}-${i}`}>{human(reason)}</p>
              ))}
            </div>
          )}
          {result?.note && <p className="body-copy">{result.note}</p>}
          <div className="observation-list">
            {detections.map((item, i) => (
              <button key={i} onClick={() => setIndex(i)} className={index === i ? 'selected' : ''}>
                <span className="observation-index">{i + 1}</span>
                <span>
                  <strong>{human(item.type)}</strong>
                  <small>
                    {Math.round(item.confidence * 100)}% detection confidence
                    {item.timeOffsetMs != null
                      ? ` · ${(item.timeOffsetMs / 1000).toFixed(1)} s`
                      : ''}
                  </small>
                </span>
                {result?.observationDefectIds?.[String(i)] ? (
                  <Badge value="candidate">Located</Badge>
                ) : (
                  <Eye size={17} />
                )}
              </button>
            ))}
          </div>
          {!detections.length && (
            <Empty icon={<Eye size={27} />} title="No model observations returned">
              This evidence remains in the survey. A result with no detections does not certify a
              road as defect-free.
            </Empty>
          )}
        </div>
        <aside className="observation-location">
          {detection ? (
            <>
              <h3>{human(detection.type)}</h3>
              <div className="measurement-grid compact-measurements">
                {(['length', 'width', 'depth', 'area'] as const).map((key) => (
                  <div className="measurement" key={key}>
                    <span>{human(key)}</span>
                    <strong>
                      {detection[key]?.value != null
                        ? `${detection[key]?.value} ${detection[key]?.unit}`
                        : 'Unknown'}
                    </strong>
                    <small>{human(detection[key]?.status)}</small>
                  </div>
                ))}
              </div>
              <p className="body-copy">
                Physical dimensions remain unknown without a scale or field measurement. A reviewer
                can add documented estimates on the defect review page.
              </p>
              {defectId ? (
                <div className="located-success">
                  <ShieldCheck size={25} />
                  <h3>Observation linked to a defect</h3>
                  <p>The original model evidence is retained on its review record.</p>
                  <Link
                    className="button primary"
                    href={`/defects?id=${defectId}`}
                    onClick={onClose}
                  >
                    Open defect review
                  </Link>
                </div>
              ) : canLocate ? (
                <form onSubmit={locate}>
                  <h3>Place observation for review</h3>
                  <p className="body-copy">
                    Select the road and mark the observed defect location. Camera or vehicle GPS
                    alone does not identify the defect position. Location accuracy remains unknown.
                  </p>
                  <Field label="Observed road">
                    <select
                      value={roadId}
                      onChange={(event) => {
                        setRoadId(event.target.value);
                        setPoint(null);
                      }}
                      required
                    >
                      <option value="">Select the road</option>
                      {roads.map((road) => (
                        <option key={road.id} value={road.id}>
                          {road.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {roadId && (
                    <>
                      <p className="map-pick-hint">
                        <MapPin size={15} />
                        Click the road map to place the observation, or enter coordinates.
                      </p>
                      <RoadMap
                        roads={roads.filter((road) => road.id === roadId)}
                        defects={[]}
                        onSelect={() => {}}
                        demo={demo}
                        compact
                        onPick={setPoint}
                        pickedPoint={point}
                      />
                    </>
                  )}
                  <div className="form-grid">
                    <Field label="Defect latitude">
                      <input
                        name="latitude"
                        type="number"
                        step="any"
                        min={-90}
                        max={90}
                        value={latitude}
                        onChange={(event) => setLatitude(event.target.value)}
                        required
                      />
                    </Field>
                    <Field label="Defect longitude">
                      <input
                        name="longitude"
                        type="number"
                        step="any"
                        min={-180}
                        max={180}
                        value={longitude}
                        onChange={(event) => setLongitude(event.target.value)}
                        required
                      />
                    </Field>
                  </div>
                  <Field label="Location evidence and observation notes">
                    <textarea
                      name="description"
                      rows={3}
                      minLength={5}
                      maxLength={4000}
                      placeholder="Describe how you identified this location and the visible damage…"
                      required
                    />
                  </Field>
                  <div className="form-actions">
                    <Submit busy={busy}>Create review candidate</Submit>
                  </div>
                </form>
              ) : (
                <p className="access-note">
                  An administrator or reviewer can locate this observation and create a defect
                  candidate.
                </p>
              )}
            </>
          ) : (
            <div className="processing-summary">
              <ShieldCheck size={27} />
              <h3>Processing record</h3>
              <p>{result?.frameCount || 0} sampled frames</p>
              <p>{result?.createdDefects || 0} created defects</p>
              <p>{result?.unlocatedDetections || 0} unlocated observations</p>
            </div>
          )}
        </aside>
      </div>
    </Dialog>
  );
}
