import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { z } from 'zod';
import {
  assessPriority,
  assertWorkOrderTransition,
  defectTypes,
  estimatedMeasurement,
  nearestPointOnRoad,
  unknownMeasurement,
  type Defect,
  type PriorityInput,
  type Role,
  type WorkOrder,
} from '@roadwatch/domain';
import { Database, DbClient } from './database';
import { AssetsService } from './assets.service';
import { Principal, requireRole } from './security';
import { audit, conflict, identifier, now, parse, uuid } from './utils';

export const priorityPolicySchema = z
  .object({
    defaultTrafficExposure: z.number().min(0).max(100).optional(),
    defaultVulnerableContext: z.number().min(0).max(100).optional(),
    defaultGrowthScore: z.number().min(0).max(100).optional(),
  })
  .strict();
const manualSchema = z
  .object({
    roadId: z.string().uuid(),
    segmentId: z.string().uuid().optional(),
    type: z.enum(defectTypes),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    description: z.string().trim().min(5).max(4000),
    depthMm: z.number().finite().positive().max(3000).optional(),
    lengthM: z.number().finite().positive().max(1000).optional(),
    widthM: z.number().finite().positive().max(100).optional(),
    trafficExposure: z.number().min(0).max(100).optional(),
    vulnerableContext: z.number().min(0).max(100).optional(),
  })
  .strict();
export function assessmentFor(input: PriorityInput, settings: any) {
  const policy = settings.priorityPolicy || {};
  const assessment = assessPriority({
    ...input,
    trafficExposure: input.trafficExposure ?? policy.defaultTrafficExposure,
    vulnerableContext: input.vulnerableContext ?? policy.defaultVulnerableContext,
    growthScore: input.growthScore ?? policy.defaultGrowthScore,
  });
  if (Object.keys(policy).length) {
    assessment.policyVersion = `reference-1.0/org-${settings.version || 1}`;
    assessment.reasons.push(
      'Organization policy defaults applied where survey exposure inputs are absent.',
    );
    for (const c of assessment.components) {
      if (
        (c.key === 'exposure' && input.trafficExposure == null) ||
        (c.key === 'vulnerable' && input.vulnerableContext == null) ||
        (c.key === 'deterioration' && input.growthScore == null)
      )
        c.assumed = true;
    }
  }
  return assessment;
}
@Injectable()
export class FindingsService {
  constructor(
    @Inject(Database) readonly db: Database,
    @Inject(AssetsService) readonly assets: AssetsService,
  ) {}
  async create(actor: Principal, body: unknown) {
    requireRole(actor, 'admin', 'reviewer', 'planner', 'crew');
    const input = parse(manualSchema, body);
    return this.db.tx(async (c) => {
      const road = await this.assets.get(actor, 'roads', input.roadId, c),
        location = (
          await this.assets.nearbyRoads(actor, [input.longitude, input.latitude], 100, [road.id], c)
        )[0];
      if (!location)
        throw new BadRequestException(
          'The reported point is more than 100 m from the selected road. Select the correct road.',
        );
      const segments = (await this.assets.list(actor, 'segments', c)).filter(
        (s) => s.roadId === road.id,
      );
      if (input.segmentId && !segments.some((s) => s.id === input.segmentId))
        throw new BadRequestException('The segment does not belong to the selected road.');
      const segmentId =
        input.segmentId ||
        segments.find(
          (s) => s.chainageStartM <= location.chainageM && s.chainageEndM >= location.chainageM,
        )?.id ||
        null;
      const settings = await this.assets.settings(actor, c),
        priorityInputs: PriorityInput = {
          type: input.type,
          depthMm: input.depthMm,
          trafficExposure: input.trafficExposure,
          vulnerableContext: input.vulnerableContext,
          ageDays: 0,
        };
      const assessment = assessmentFor(priorityInputs, settings),
        id = uuid();
      const defect: Defect & { priorityInputs: PriorityInput } = {
        id,
        code: `RW-${id.slice(0, 8).toUpperCase()}`,
        roadId: road.id,
        roadName: road.name,
        segmentId,
        type: input.type,
        status: 'candidate',
        priority: assessment.priority,
        severity: assessment.severity,
        latitude: input.latitude,
        longitude: input.longitude,
        locationAccuracyM: null,
        chainageM: Math.round(location.chainageM * 10) / 10,
        description: input.description,
        length: estimatedMeasurement(input.lengthM, 'm'),
        width: estimatedMeasurement(input.widthM, 'm'),
        depth: estimatedMeasurement(input.depthMm, 'mm'),
        area:
          input.lengthM && input.widthM
            ? estimatedMeasurement(
                input.lengthM * input.widthM,
                'm2',
                'manual_bounding_rectangle_estimate',
              )
            : unknownMeasurement('m2'),
        confidence: null,
        source: 'manual_report',
        observedAt: now(),
        updatedAt: now(),
        version: 1,
        evidence: [],
        assessment,
        priorityInputs,
      };
      await c.query(
        'INSERT INTO defects(id,tenant_id,road_id,segment_id,data) VALUES($1,$2,$3,$4,$5)',
        [id, actor.tenantId, road.id, segmentId, JSON.stringify(defect)],
      );
      await audit(c, actor, 'defect.reported', 'defect', id, {
        source: 'manual_report',
        measurements: 'unverified',
      });
      return defect;
    });
  }
  async recordMeasurements(actor: Principal, id: string, body: unknown) {
    requireRole(actor, 'admin', 'reviewer');
    identifier(id);
    const input = parse(
      z
        .object({
          expectedVersion: z.number().int().positive(),
          lengthM: z.number().finite().positive().max(1000).optional(),
          widthM: z.number().finite().positive().max(100).optional(),
          depthMm: z.number().finite().positive().max(3000).optional(),
          note: z.string().trim().min(5).max(2000),
        })
        .strict()
        .refine(
          (v) => v.lengthM !== undefined || v.widthM !== undefined || v.depthMm !== undefined,
          {
            message: 'Enter at least one field estimate.',
          },
        ),
      body,
    );
    return this.db.tx(async (c) => {
      const d = await this.assets.get(actor, 'defects', id, c, true);
      if (d.version !== input.expectedVersion) conflict();
      if (d.status === 'closed' || d.status === 'rejected')
        throw new ConflictException('Reopen this defect before recording field estimates.');
      if (input.lengthM !== undefined)
        d.length = estimatedMeasurement(input.lengthM, 'm', 'reviewer_field_estimate');
      if (input.widthM !== undefined)
        d.width = estimatedMeasurement(input.widthM, 'm', 'reviewer_field_estimate');
      if (input.depthMm !== undefined)
        d.depth = estimatedMeasurement(input.depthMm, 'mm', 'reviewer_field_estimate');
      d.area =
        d.length.value != null && d.width.value != null
          ? estimatedMeasurement(
              d.length.value * d.width.value,
              'm2',
              'manual_bounding_rectangle_estimate',
            )
          : unknownMeasurement('m2');
      const settings = await this.assets.settings(actor, c);
      const priorityInputs = (d as typeof d & { priorityInputs?: PriorityInput }).priorityInputs;
      d.assessment = assessmentFor(
        { ...priorityInputs, type: d.type, depthMm: d.depth.value ?? undefined },
        settings,
      );
      d.priority = d.assessment.priority;
      d.severity = d.assessment.severity;
      d.version++;
      d.updatedAt = now();
      await c.query('UPDATE defects SET version=$3,data=$4 WHERE tenant_id=$1 AND id=$2', [
        actor.tenantId,
        id,
        d.version,
        JSON.stringify(d),
      ]);
      await audit(c, actor, 'defect.measurements_estimated', 'defect', id, {
        note: input.note,
        version: d.version,
        values: { lengthM: input.lengthM, widthM: input.widthM, depthMm: input.depthMm },
        method: 'reviewer_field_estimate',
        verified: false,
      });
      return d;
    });
  }
  async review(actor: Principal, id: string, body: unknown) {
    requireRole(actor, 'admin', 'reviewer');
    identifier(id);
    const input = parse(
      z
        .object({
          action: z.enum(['confirm', 'reject', 'reopen']),
          reason: z.string().trim().min(3).max(2000),
          expectedVersion: z.number().int().positive(),
        })
        .strict(),
      body,
    );
    return this.db.tx(async (c) => {
      const d = await this.assets.get(actor, 'defects', id, c, true);
      if (d.version !== input.expectedVersion) conflict();
      if (input.action === 'reopen') {
        if (!['rejected', 'closed'].includes(d.status))
          throw new ConflictException('Only rejected or closed defects can be reopened.');
        if (
          (
            await c.query(
              'SELECT defect_id FROM work_order_defects WHERE tenant_id=$1 AND defect_id=$2',
              [actor.tenantId, id],
            )
          ).rowCount
        )
          throw new ConflictException(
            'Reopen the related work order to keep repair status consistent.',
          );
        d.status = 'candidate';
      } else {
        if (d.status !== 'candidate')
          throw new ConflictException('Only candidate defects can be confirmed or rejected.');
        d.status = input.action === 'confirm' ? 'confirmed' : 'rejected';
      }
      d.version++;
      d.updatedAt = now();
      await c.query('UPDATE defects SET version=$3,data=$4 WHERE tenant_id=$1 AND id=$2', [
        actor.tenantId,
        id,
        d.version,
        JSON.stringify(d),
      ]);
      await audit(c, actor, `defect.${input.action}`, 'defect', id, {
        reason: input.reason,
        version: d.version,
        measurementVerification: false,
      });
      return d;
    });
  }
  async createOrder(actor: Principal, body: unknown) {
    requireRole(actor, 'admin', 'planner');
    const input = parse(
      z
        .object({
          defectIds: z.array(z.string().uuid()).min(1).max(100),
          crew: z.string().trim().min(2).max(200),
          description: z.string().trim().min(3).max(4000),
          dueAt: z.string().datetime({ offset: true }),
        })
        .strict(),
      body,
    );
    if (new Set(input.defectIds).size !== input.defectIds.length)
      throw new BadRequestException('Defect IDs must be unique.');
    return this.db.tx(async (c) => {
      const defects = [];
      for (const id of [...input.defectIds].sort()) {
        const d = await this.assets.get(actor, 'defects', id, c, true);
        if (d.status !== 'confirmed')
          throw new ConflictException(`${d.code} must be confirmed and unassigned.`);
        defects.push(d);
      }
      const id = uuid(),
        order: WorkOrder = {
          id,
          code: `WO-${id.slice(0, 8).toUpperCase()}`,
          ...input,
          status: 'assigned',
          createdAt: now(),
          updatedAt: now(),
          version: 1,
          repairReportedBy: null,
        };
      await c.query('INSERT INTO work_orders(id,tenant_id,data) VALUES($1,$2,$3)', [
        id,
        actor.tenantId,
        JSON.stringify(order),
      ]);
      for (const d of defects) {
        d.status = 'assigned';
        d.version++;
        d.updatedAt = now();
        await c.query('UPDATE defects SET version=$3,data=$4 WHERE tenant_id=$1 AND id=$2', [
          actor.tenantId,
          d.id,
          d.version,
          JSON.stringify(d),
        ]);
        await c.query(
          'INSERT INTO work_order_defects(tenant_id,work_order_id,defect_id) VALUES($1,$2,$3)',
          [actor.tenantId, id, d.id],
        );
      }
      await audit(c, actor, 'work_order.created', 'work_order', id, {
        defectIds: input.defectIds,
        crew: input.crew,
      });
      return order;
    });
  }
  async transition(actor: Principal, id: string, body: unknown) {
    const input = parse(
      z
        .object({
          action: z.enum(['start', 'report_repair', 'verify', 'reopen']),
          notes: z.string().trim().min(3).max(4000),
          expectedVersion: z.number().int().positive(),
        })
        .strict(),
      body,
    );
    if (['verify', 'reopen'].includes(input.action)) requireRole(actor, 'admin', 'reviewer');
    else requireRole(actor, 'admin', 'planner', 'crew');
    return this.db.tx(async (c) => {
      const order = await this.assets.get(actor, 'work_orders', id, c, true);
      if (order.version !== input.expectedVersion) conflict();
      if (input.action === 'verify' && actor.id === order.repairReportedBy)
        throw new ForbiddenException('Repair must be verified by another authorized person.');
      let status;
      try {
        status = assertWorkOrderTransition(
          order.status,
          input.action,
          actor.role as Role,
          actor.id,
          order.repairReportedBy,
        );
      } catch (e) {
        throw new ConflictException((e as Error).message);
      }
      const defects = [];
      for (const defectId of [...order.defectIds].sort())
        defects.push(await this.assets.get(actor, 'defects', defectId, c, true));
      order.status = status;
      order.version++;
      order.updatedAt = now();
      order.notes = input.notes;
      if (input.action === 'report_repair') order.repairReportedBy = actor.id;
      if (input.action === 'reopen') order.repairReportedBy = null;
      await c.query('UPDATE work_orders SET version=$3,data=$4 WHERE tenant_id=$1 AND id=$2', [
        actor.tenantId,
        id,
        order.version,
        JSON.stringify(order),
      ]);
      for (const d of defects) {
        d.status = status;
        d.version++;
        d.updatedAt = now();
        await c.query('UPDATE defects SET version=$3,data=$4 WHERE tenant_id=$1 AND id=$2', [
          actor.tenantId,
          d.id,
          d.version,
          JSON.stringify(d),
        ]);
      }
      await audit(c, actor, `work_order.${input.action}`, 'work_order', id, {
        notes: input.notes,
        version: order.version,
      });
      return order;
    });
  }
  async updateSettings(actor: Principal, body: unknown) {
    requireRole(actor, 'admin');
    const input = parse(
      z
        .object({
          organizationName: z.string().trim().min(2).max(200),
          defaultRegion: z.string().trim().min(1).max(120),
          retentionDays: z.number().int().min(1).max(3650),
          priorityPolicy: priorityPolicySchema.optional(),
        })
        .strict(),
      body,
    );
    return this.db.tx(async (c) => {
      const row = (
        await c.query('SELECT settings,version FROM tenants WHERE id=$1 FOR UPDATE', [
          actor.tenantId,
        ])
      ).rows[0];
      const settings = { ...row.settings, ...input, version: row.version + 1 };
      await c.query('UPDATE tenants SET name=$2,settings=$3,version=$4 WHERE id=$1', [
        actor.tenantId,
        input.organizationName,
        JSON.stringify(settings),
        settings.version,
      ]);
      let recalculated = 0;
      if (input.priorityPolicy) {
        const rows = (
          await c.query(
            "SELECT id,data FROM defects WHERE tenant_id=$1 AND data->>'status' NOT IN ('closed','rejected') ORDER BY id FOR UPDATE",
            [actor.tenantId],
          )
        ).rows;
        for (const row of rows) {
          const d = row.data,
            ageDays = Math.max(0, (Date.now() - Date.parse(d.observedAt)) / 86400000),
            inputs = { type: d.type, depthMm: d.depth.value, ...d.priorityInputs, ageDays };
          d.assessment = assessmentFor(inputs, settings);
          d.priority = d.assessment.priority;
          d.severity = d.assessment.severity;
          d.version++;
          d.updatedAt = now();
          await c.query('UPDATE defects SET version=$3,data=$4 WHERE tenant_id=$1 AND id=$2', [
            actor.tenantId,
            d.id,
            d.version,
            JSON.stringify(d),
          ]);
          recalculated++;
        }
      }
      await audit(c, actor, 'settings.updated', 'organization', actor.tenantId, {
        version: settings.version,
        recalculatedDefects: recalculated,
        retentionDays: settings.retentionDays,
      });
      return settings;
    });
  }
}
