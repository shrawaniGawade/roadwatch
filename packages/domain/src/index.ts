import { z } from 'zod';

export const defectTypes = [
  'pothole',
  'longitudinal_crack',
  'transverse_crack',
  'alligator_crack',
  'patch_deterioration',
  'raveling',
  'edge_break',
  'surface_deformation',
] as const;
export type DefectType = (typeof defectTypes)[number];
export const defectLabels: Record<DefectType, string> = {
  pothole: 'Pothole',
  longitudinal_crack: 'Longitudinal crack',
  transverse_crack: 'Transverse crack',
  alligator_crack: 'Alligator cracking',
  patch_deterioration: 'Patch deterioration',
  raveling: 'Raveling',
  edge_break: 'Edge break',
  surface_deformation: 'Surface deformation',
};
export type Role = 'admin' | 'reviewer' | 'planner' | 'crew' | 'viewer';
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  tenantId: string;
}
export type Position = [number, number];
export interface LineGeometry {
  type: 'LineString';
  coordinates: Position[];
}
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type Severity = 'unknown' | 'low' | 'moderate' | 'high';
export type DefectStatus =
  | 'candidate'
  | 'confirmed'
  | 'rejected'
  | 'assigned'
  | 'in_progress'
  | 'repair_reported'
  | 'closed';
export type MeasurementStatus = 'unknown' | 'estimated' | 'sensor_measured' | 'field_verified';
export interface Measurement {
  value: number | null;
  unit: 'm' | 'mm' | 'm2';
  status: MeasurementStatus;
  method: string;
  uncertainty95: number | null;
  reason?: string;
}
export interface Road {
  id: string;
  name: string;
  code: string;
  region: string;
  owner: string;
  surface: string;
  lengthM: number;
  geometry: LineGeometry;
  version: number;
  updatedAt: string;
}
export interface Segment {
  id: string;
  roadId: string;
  name: string;
  chainageStartM: number;
  chainageEndM: number;
  coveragePct: number;
  lastSurveyAt: string | null;
  geometry: LineGeometry;
}
export interface Evidence {
  id: string;
  mediaId: string;
  url: string;
  filename: string;
  mimeType: string;
  capturedAt: string;
  sha256: string;
  mask?: number[][];
  width?: number;
  height?: number;
}
export interface PriorityComponent {
  key: string;
  label: string;
  value: number;
  weight: number;
  contribution: number;
  assumed: boolean;
}
export interface PriorityAssessment {
  score: number;
  priority: Priority;
  severity: Severity;
  reasons: string[];
  components: PriorityComponent[];
  inspectionRequired: boolean;
  policyVersion: string;
}
export interface Defect {
  id: string;
  code: string;
  roadId: string;
  roadName: string;
  segmentId: string | null;
  type: DefectType;
  status: DefectStatus;
  priority: Priority;
  severity: Severity;
  latitude: number;
  longitude: number;
  locationAccuracyM: number | null;
  chainageM: number | null;
  description: string;
  length: Measurement;
  width: Measurement;
  depth: Measurement;
  area: Measurement;
  confidence: number | null;
  source: string;
  observedAt: string;
  updatedAt: string;
  version: number;
  evidence: Evidence[];
  assessment: PriorityAssessment;
}
export interface Device {
  id: string;
  name: string;
  kind: 'vehicle' | 'cctv' | 'mobile';
  status: 'online' | 'offline' | 'degraded';
  vehiclePlate: string | null;
  cameraModel: string | null;
  lastSeenAt: string | null;
  latitude: number | null;
  longitude: number | null;
  calibrationStatus: 'valid' | 'expired' | 'missing';
  uploadBacklog: number;
}
export interface Survey {
  id: string;
  name: string;
  deviceId: string;
  status: 'active' | 'completed' | 'interrupted';
  startedAt: string;
  completedAt: string | null;
  roadIds: string[];
  framesProcessed: number;
  defectsDetected: number;
  distanceKm: number;
}
export type WorkOrderStatus = 'assigned' | 'in_progress' | 'repair_reported' | 'closed';
export interface WorkOrder {
  id: string;
  code: string;
  defectIds: string[];
  crew: string;
  description: string;
  status: WorkOrderStatus;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  repairReportedBy?: string | null;
  notes?: string;
}
export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  details: Record<string, unknown>;
}
export interface Job {
  id: string;
  surveyId: string;
  mediaId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  pipelineVersion: string;
}
export interface Settings {
  organizationName: string;
  defaultRegion: string;
  retentionDays: number;
  priorityPolicy?: Record<string, unknown>;
  version?: number;
}
export interface DashboardData {
  roads: Road[];
  segments: Segment[];
  defects: Defect[];
  devices: Device[];
  surveys: Survey[];
  workOrders: WorkOrder[];
  activity: AuditEvent[];
  isDemo: boolean;
  organizationName: string;
}

export const coordinateSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
export const lineGeometrySchema = z.object({
  type: z.literal('LineString'),
  coordinates: z.array(coordinateSchema).min(2).max(10000),
});
export const measurementSchema = z
  .object({
    value: z.number().finite().nonnegative().nullable(),
    unit: z.enum(['m', 'mm', 'm2']),
    status: z.enum(['unknown', 'estimated', 'sensor_measured', 'field_verified']),
    method: z.string().min(1),
    uncertainty95: z.number().finite().nonnegative().nullable(),
    reason: z.string().optional(),
  })
  .superRefine((m, ctx) => {
    if ((m.status === 'unknown') !== (m.value === null))
      ctx.addIssue({
        code: 'custom',
        message: 'Unknown measurements must be null; known measurements need a value',
      });
    if (m.status === 'unknown' && !m.reason)
      ctx.addIssue({ code: 'custom', message: 'Unknown measurements require a reason' });
  });

export function unknownMeasurement(
  unit: Measurement['unit'],
  reason = 'No calibrated measurement available',
): Measurement {
  return {
    value: null,
    unit,
    status: 'unknown',
    method: 'unavailable',
    uncertainty95: null,
    reason,
  };
}
export function estimatedMeasurement(
  value: number | null | undefined,
  unit: Measurement['unit'],
  method = 'manual_report',
): Measurement {
  if (value === null || value === undefined) return unknownMeasurement(unit);
  if (!Number.isFinite(value) || value < 0)
    throw new Error('Measurement must be finite and nonnegative');
  return {
    value,
    unit,
    status: 'estimated',
    method,
    uncertainty95: null,
    reason: 'Requires independent survey verification',
  };
}

export interface PriorityInput {
  type?: DefectType;
  depthMm?: number | null;
  areaM2?: number | null;
  trafficExposure?: number | null;
  vulnerableContext?: number | null;
  growthScore?: number | null;
  ageDays?: number;
  emergency?: boolean;
}
const bounded = (v: number) => Math.max(0, Math.min(100, v));
export function assessPriority(input: PriorityInput): PriorityAssessment {
  for (const v of [
    input.depthMm,
    input.areaM2,
    input.trafficExposure,
    input.vulnerableContext,
    input.growthScore,
    input.ageDays,
  ])
    if (v != null && (!Number.isFinite(v) || v < 0))
      throw new Error('Priority inputs must be finite and nonnegative');
  // The depth reference applies to potholes only. Other class severity requires an approved assessment.
  const isPothole = !input.type || input.type === 'pothole';
  const depth = isPothole ? input.depthMm : null;
  const severity: Severity =
    depth == null ? 'unknown' : depth < 25 ? 'low' : depth <= 50 ? 'moderate' : 'high';
  const physical =
    severity === 'high' ? 100 : severity === 'moderate' ? 65 : severity === 'low' ? 30 : 70;
  const components: PriorityComponent[] = [
    {
      key: 'severity',
      label: 'Physical severity',
      value: physical,
      weight: 0.35,
      contribution: 0,
      assumed: severity === 'unknown',
    },
    {
      key: 'exposure',
      label: 'Traffic and speed',
      value: bounded(input.trafficExposure ?? 50),
      weight: 0.25,
      contribution: 0,
      assumed: input.trafficExposure == null,
    },
    {
      key: 'vulnerable',
      label: 'Vulnerable road users',
      value: bounded(input.vulnerableContext ?? 40),
      weight: 0.15,
      contribution: 0,
      assumed: input.vulnerableContext == null,
    },
    {
      key: 'deterioration',
      label: 'Deterioration and recurrence',
      value: bounded(input.growthScore ?? 40),
      weight: 0.15,
      contribution: 0,
      assumed: input.growthScore == null,
    },
    {
      key: 'age',
      label: 'Time unresolved',
      value: bounded(((input.ageDays ?? 0) / 30) * 100),
      weight: 0.1,
      contribution: 0,
      assumed: false,
    },
  ].map((c) => ({ ...c, contribution: Math.round(c.value * c.weight * 100) / 100 }));
  const score = Math.round(components.reduce((sum, c) => sum + c.contribution, 0));
  const priority: Priority = input.emergency
    ? 'P0'
    : score >= 75
      ? 'P1'
      : score >= 45
        ? 'P2'
        : 'P3';
  const reasons = [
    ...(severity === 'unknown'
      ? ['Severity needs inspection; conservative scheduling assumptions applied']
      : [`${severity} pothole depth by reference policy`]),
    ...components
      .filter((c) => c.assumed && c.key !== 'severity')
      .map((c) => `${c.label}: provisional assumption`),
    ...(input.emergency ? ['Emergency override requires immediate operator review'] : []),
  ];
  return {
    score,
    priority,
    severity,
    reasons,
    components,
    inspectionRequired: severity === 'unknown',
    policyVersion: 'reference-1.0',
  };
}
export const calculatePriority = assessPriority;

const RAD = Math.PI / 180;
const EARTH = 6371008.8;
export function haversineM(a: Position, b: Position): number {
  const p1 = a[1] * RAD,
    p2 = b[1] * RAD,
    dp = (b[1] - a[1]) * RAD,
    dl = (b[0] - a[0]) * RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return EARTH * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
export function lineLengthM(line: LineGeometry): number {
  return line.coordinates
    .slice(1)
    .reduce((sum, p, i) => sum + haversineM(line.coordinates[i]!, p), 0);
}
export function pointAtChainage(line: LineGeometry, distanceM: number): Position {
  if (!Number.isFinite(distanceM)) throw new Error('Invalid chainage');
  let remaining = Math.max(0, distanceM);
  for (let i = 1; i < line.coordinates.length; i++) {
    const a = line.coordinates[i - 1]!,
      b = line.coordinates[i]!,
      length = haversineM(a, b);
    if (length === 0) continue;
    if (remaining <= length) {
      const t = remaining / length;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remaining -= length;
  }
  return [...line.coordinates[line.coordinates.length - 1]!] as Position;
}
export function splitRoadSegments(road: Road, targetM = 100): Segment[] {
  lineGeometrySchema.parse(road.geometry);
  if (!Number.isFinite(targetM) || targetM < 10)
    throw new Error('Segment length must be at least 10 m');
  const length = lineLengthM(road.geometry),
    result: Segment[] = [];
  let cumulative = 0;
  const vertices = road.geometry.coordinates.map((point, i) => {
    if (i > 0) cumulative += haversineM(road.geometry.coordinates[i - 1]!, point);
    return { point, distance: cumulative };
  });
  for (let start = 0, index = 0; start < length; start += targetM, index++) {
    const end = Math.min(length, start + targetM);
    const coordinates: Position[] = [
      pointAtChainage(road.geometry, start),
      ...vertices.filter((v) => v.distance > start && v.distance < end).map((v) => v.point),
      pointAtChainage(road.geometry, end),
    ];
    result.push({
      id: `${road.id}-v${road.version}-s${index + 1}`,
      roadId: road.id,
      name: `${road.code} / ${formatChainage(start)}–${formatChainage(end)}`,
      chainageStartM: start,
      chainageEndM: end,
      coveragePct: 0,
      lastSurveyAt: null,
      geometry: { type: 'LineString', coordinates },
    });
  }
  return result;
}
export function nearestPointOnRoad(
  point: Position,
  road: Road,
): { point: Position; distanceM: number; chainageM: number } {
  coordinateSchema.parse(point);
  lineGeometrySchema.parse(road.geometry);
  // Local tangent approximation for short urban links; distance is recalculated on the sphere.
  const cos = Math.cos(point[1] * RAD);
  let best = { point: road.geometry.coordinates[0]!, distanceM: Infinity, chainageM: 0 };
  let cumulative = 0;
  for (let i = 1; i < road.geometry.coordinates.length; i++) {
    const a = road.geometry.coordinates[i - 1]!,
      b = road.geometry.coordinates[i]!;
    const ax = (a[0] - point[0]) * cos,
      ay = a[1] - point[1],
      bx = (b[0] - point[0]) * cos,
      by = b[1] - point[1];
    const dx = bx - ax,
      dy = by - ay;
    const denominator = dx * dx + dy * dy;
    const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denominator));
    const candidate: Position = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    const distanceM = haversineM(point, candidate),
      length = haversineM(a, b);
    if (distanceM < best.distanceM)
      best = { point: candidate, distanceM, chainageM: cumulative + t * length };
    cumulative += length;
  }
  return best;
}
export function formatChainage(m: number): string {
  const rounded = Math.max(0, Math.round(m));
  return `${Math.floor(rounded / 1000)}+${String(rounded % 1000).padStart(3, '0')}`;
}
export function escapeCsv(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\r\n') + '\r\n';
}

export function canReview(role: Role): boolean {
  return role === 'admin' || role === 'reviewer';
}
export function canPlan(role: Role): boolean {
  return role === 'admin' || role === 'planner';
}
export function assertWorkOrderTransition(
  status: WorkOrderStatus,
  action: 'start' | 'report_repair' | 'verify' | 'reopen',
  role: Role,
  actorId: string,
  repairReportedBy?: string | null,
): WorkOrderStatus {
  if (action === 'start' && status === 'assigned' && ['admin', 'planner', 'crew'].includes(role))
    return 'in_progress';
  if (
    action === 'report_repair' &&
    status === 'in_progress' &&
    ['admin', 'planner', 'crew'].includes(role)
  )
    return 'repair_reported';
  if (
    action === 'verify' &&
    status === 'repair_reported' &&
    canReview(role) &&
    actorId !== repairReportedBy
  )
    return 'closed';
  if (action === 'reopen' && ['repair_reported', 'closed'].includes(status) && canReview(role))
    return 'assigned';
  throw new Error(
    action === 'verify' && actorId === repairReportedBy
      ? 'Repair must be verified by another authorized person'
      : 'Transition is not permitted',
  );
}

export function dashboardMetrics(data: DashboardData) {
  const active = data.defects.filter((d) => !['closed', 'rejected'].includes(d.status));
  const observed = data.segments.reduce(
    (sum, s) => sum + ((s.chainageEndM - s.chainageStartM) * s.coveragePct) / 100,
    0,
  );
  const total = data.segments.reduce((sum, s) => sum + s.chainageEndM - s.chainageStartM, 0);
  return {
    activeDefects: active.length,
    urgentDefects: active.filter((d) => d.priority === 'P0' || d.priority === 'P1').length,
    reviewQueue: active.filter((d) => d.status === 'candidate').length,
    coveragePct: total ? (observed / total) * 100 : 0,
    roadKm: data.roads.reduce((sum, r) => sum + r.lengthM, 0) / 1000,
    onlineDevices: data.devices.filter((d) => d.status === 'online').length,
    openWorkOrders: data.workOrders.filter((w) => w.status !== 'closed').length,
  };
}
