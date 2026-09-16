import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import {
  lineGeometrySchema,
  lineLengthM,
  nearestPointOnRoad,
  splitRoadSegments,
  type Position,
  type Road,
} from '@roadwatch/domain';
import { Database, DbClient } from './database';
import { Principal, requireRole } from './security';
import { digest } from './credentials';
import { audit, identifier, missing, now, parse, uuid } from './utils';

export type RecordTable =
  'roads' | 'segments' | 'defects' | 'devices' | 'surveys' | 'work_orders' | 'calibrations';
const deviceSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    kind: z.enum(['vehicle', 'cctv', 'mobile']),
    vehiclePlate: z.string().max(50).optional(),
    cameraModel: z.string().max(200).optional(),
  })
  .strict();
const matrix = z.array(z.array(z.number().finite()).length(3)).length(3);
const projectionSchema = z
  .object({
    kind: z.literal('planar'),
    imageWidth: z.number().int().positive().max(16384),
    imageHeight: z.number().int().positive().max(16384),
    imageToGround: matrix,
    cameraMatrix: matrix.optional(),
    distortion: z.array(z.number().finite()).max(14).default([]),
    validRoi: z
      .array(z.tuple([z.number().finite(), z.number().finite()]))
      .min(3)
      .max(1000),
    uncertainty95M: z.number().positive().max(10),
    cameraOffsetForwardM: z.number().min(-30).max(30).default(0),
    cameraOffsetRightM: z.number().min(-30).max(30).default(0),
    headingAccuracy95Deg: z.number().positive().max(180).default(5),
    validUntil: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((p) => !p.distortion.length || !!p.cameraMatrix, 'Distortion needs a camera matrix.')
  .refine(
    (p) => [0, 4, 5, 8, 12, 14].includes(p.distortion.length),
    'Unsupported distortion coefficient count.',
  );
const featureCollection = z
  .object({
    type: z.literal('FeatureCollection'),
    features: z
      .array(
        z.object({
          type: z.literal('Feature'),
          geometry: lineGeometrySchema,
          properties: z
            .object({
              name: z.string().trim().min(1).max(200),
              code: z.string().trim().min(1).max(100),
              owner: z.string().max(200).default('Unassigned'),
              region: z.string().max(100).default('Unassigned'),
              surface: z.string().max(100).default('Unknown'),
            })
            .passthrough(),
        }),
      )
      .min(1)
      .max(1000),
  })
  .strict();
@Injectable()
export class AssetsService {
  constructor(@Inject(Database) readonly db: Database) {}
  async list(actor: Principal, table: RecordTable, c: DbClient = this.db.pool) {
    return (
      await c.query(`SELECT data FROM ${table} WHERE tenant_id=$1 ORDER BY id`, [actor.tenantId])
    ).rows.map((r) => r.data);
  }
  async get(
    actor: Principal,
    table: RecordTable,
    id: string,
    c: DbClient = this.db.pool,
    lock = false,
  ) {
    identifier(id);
    const row = (
      await c.query(
        `SELECT data FROM ${table} WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
        [actor.tenantId, id],
      )
    ).rows[0];
    return row?.data || missing(table.replaceAll('_', ' '));
  }
  async nearbyRoads(
    actor: Principal,
    point: Position,
    radiusM: number,
    roadIds: string[] | null = null,
    c: DbClient = this.db.pool,
  ) {
    if (this.db.spatialMode === 'postgis') {
      const rows = (
        await c.query(
          `SELECT data,ST_Distance(geom::geography,ST_SetSRID(ST_MakePoint($2,$3),4326)::geography) AS distance_m
        FROM roads WHERE tenant_id=$1 AND ($5::uuid[] IS NULL OR id=ANY($5::uuid[]))
        AND ST_DWithin(geom::geography,ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,$4)
        ORDER BY distance_m,id LIMIT 50`,
          [actor.tenantId, point[0], point[1], radiusM, roadIds],
        )
      ).rows;
      // Radius eligibility and ranking use PostGIS spheroidal metres. The display chainage remains an explicitly approximate local projection.
      return rows.map((row) => ({
        road: row.data,
        ...nearestPointOnRoad(point, row.data),
        distanceM: Number(row.distance_m),
      }));
    }
    return (await this.list(actor, 'roads', c))
      .filter((road) => roadIds === null || roadIds.includes(road.id))
      .map((road) => ({ road, ...nearestPointOnRoad(point, road) }))
      .filter((candidate) => candidate.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, 50);
  }
  async activity(actor: Principal, c: DbClient = this.db.pool) {
    const rows = (
      await c.query('SELECT * FROM audit WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 250', [
        actor.tenantId,
      ])
    ).rows;
    return rows.map((r) => ({
      id: r.id,
      actor: r.actor,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      createdAt: r.created_at.toISOString(),
      details: r.details,
    }));
  }
  async settings(actor: Principal, c: DbClient = this.db.pool) {
    const row = (
      await c.query('SELECT name,settings,version FROM tenants WHERE id=$1', [actor.tenantId])
    ).rows[0];
    return { ...row.settings, organizationName: row.name, version: row.version };
  }
  async dashboard(actor: Principal, c: DbClient = this.db.pool) {
    const [roads, segments, defects, devices, surveys, workOrders, activity, tenant] =
      await Promise.all([
        this.list(actor, 'roads', c),
        this.list(actor, 'segments', c),
        this.list(actor, 'defects', c),
        this.list(actor, 'devices', c),
        this.list(actor, 'surveys', c),
        this.list(actor, 'work_orders', c),
        this.activity(actor, c),
        c.query('SELECT name,is_demo FROM tenants WHERE id=$1', [actor.tenantId]),
      ]);
    return {
      roads,
      segments,
      defects,
      devices,
      surveys,
      workOrders,
      activity,
      isDemo: tenant.rows[0].is_demo,
      organizationName: tenant.rows[0].name,
    };
  }
  async createDevice(actor: Principal, body: unknown) {
    requireRole(actor, 'admin');
    const input = parse(deviceSchema, body),
      id = uuid(),
      token = randomBytes(32).toString('base64url');
    const device = {
      id,
      ...input,
      vehiclePlate: input.vehiclePlate || null,
      cameraModel: input.cameraModel || null,
      status: 'offline',
      lastSeenAt: null,
      latitude: null,
      longitude: null,
      calibrationStatus: 'missing',
      uploadBacklog: 0,
    };
    await this.db.tx(async (c) => {
      await c.query('INSERT INTO devices(id,tenant_id,token_hash,data) VALUES($1,$2,$3,$4)', [
        id,
        actor.tenantId,
        digest(token),
        JSON.stringify(device),
      ]);
      await audit(c, actor, 'device.provisioned', 'device', id);
    });
    return { ...device, device, token, deviceToken: token };
  }
  async heartbeat(actor: Principal, body: unknown) {
    if (!actor.deviceId) throw new ForbiddenException('Device credentials are required.');
    const input = parse(
      z
        .object({
          latitude: z.number().min(-90).max(90).optional(),
          longitude: z.number().min(-180).max(180).optional(),
          uploadBacklog: z.number().int().min(0).max(1000000).optional(),
          status: z.enum(['online', 'degraded']).optional(),
        })
        .strict(),
      body,
    );
    return this.db.tx(async (c) => {
      const d = await this.get(actor, 'devices', actor.deviceId!, c, true);
      Object.assign(d, input, { lastSeenAt: now(), status: input.status || 'online' });
      await c.query('UPDATE devices SET data=$3 WHERE tenant_id=$1 AND id=$2', [
        actor.tenantId,
        d.id,
        JSON.stringify(d),
      ]);
      return d;
    });
  }
  async rotateDeviceToken(actor: Principal, id: string) {
    requireRole(actor, 'admin');
    identifier(id);
    const token = randomBytes(32).toString('base64url');
    return this.db.tx(async (c) => {
      const device = await this.get(actor, 'devices', id, c, true);
      device.credentialStatus = 'active';
      device.credentialRotatedAt = now();
      delete device.revokedReason;
      device.status = 'offline';
      await c.query('UPDATE devices SET token_hash=$3,data=$4 WHERE tenant_id=$1 AND id=$2', [
        actor.tenantId,
        id,
        digest(token),
        JSON.stringify(device),
      ]);
      await audit(c, actor, 'device.token_rotated', 'device', id);
      return { ...device, device, token, deviceToken: token };
    });
  }
  async revokeDevice(actor: Principal, id: string, body: unknown) {
    requireRole(actor, 'admin');
    identifier(id);
    const input = parse(
      z
        .object({
          reason: z
            .string()
            .trim()
            .min(3)
            .max(1000)
            .default('Device credential revoked by an administrator.'),
        })
        .strict(),
      body || {},
    );
    return this.db.tx(async (c) => {
      const device = await this.get(actor, 'devices', id, c, true);
      device.status = 'offline';
      device.credentialStatus = 'revoked';
      device.revokedReason = input.reason;
      device.revokedAt = now();
      await c.query('UPDATE devices SET token_hash=NULL,data=$3 WHERE tenant_id=$1 AND id=$2', [
        actor.tenantId,
        id,
        JSON.stringify(device),
      ]);
      await audit(c, actor, 'device.revoked', 'device', id, { reason: input.reason });
      return device;
    });
  }
  async createSurvey(actor: Principal, body: unknown) {
    requireRole(actor, 'admin', 'planner', 'crew', 'device');
    const input = parse(
      z
        .object({
          deviceId: z.string().uuid(),
          name: z.string().trim().min(2).max(200),
          roadIds: z.array(z.string().uuid()).max(1000).default([]),
        })
        .strict(),
      body,
    );
    if (actor.deviceId && input.deviceId !== actor.deviceId)
      throw new ForbiddenException('A device can create only its own surveys.');
    return this.db.tx(async (c) => {
      await this.get(actor, 'devices', input.deviceId, c);
      for (const roadId of input.roadIds) await this.get(actor, 'roads', roadId, c);
      const survey = {
        id: uuid(),
        ...input,
        roadIds: [...new Set(input.roadIds)],
        status: 'active',
        startedAt: now(),
        completedAt: null,
        framesProcessed: 0,
        defectsDetected: 0,
        distanceKm: 0,
      };
      await c.query('INSERT INTO surveys(id,tenant_id,device_id,data) VALUES($1,$2,$3,$4)', [
        survey.id,
        actor.tenantId,
        input.deviceId,
        JSON.stringify(survey),
      ]);
      await audit(c, actor, 'survey.started', 'survey', survey.id);
      return survey;
    });
  }
  async completeSurvey(actor: Principal, id: string) {
    requireRole(actor, 'admin', 'planner', 'crew', 'device');
    return this.db.tx(async (c) => {
      const s = await this.get(actor, 'surveys', id, c, true);
      if (actor.deviceId && s.deviceId !== actor.deviceId) throw new ForbiddenException();
      if (s.status === 'completed') return s;
      const pending = await c.query(
        "SELECT id FROM jobs WHERE tenant_id=$1 AND survey_id=$2 AND status IN ('queued','processing') LIMIT 1",
        [actor.tenantId, id],
      );
      if (pending.rowCount)
        throw new ConflictException(
          'Wait for queued media processing before completing this survey.',
        );
      s.status = 'completed';
      s.completedAt = now();
      await c.query('UPDATE surveys SET data=$3 WHERE tenant_id=$1 AND id=$2', [
        actor.tenantId,
        id,
        JSON.stringify(s),
      ]);
      await audit(c, actor, 'survey.completed', 'survey', id);
      return s;
    });
  }
  async importRoads(actor: Principal, body: unknown) {
    requireRole(actor, 'admin', 'planner');
    const input = parse(featureCollection, body);
    return this.db.tx(async (c) => {
      const created = [];
      for (const feature of input.features) {
        if (
          (
            await c.query("SELECT id FROM roads WHERE tenant_id=$1 AND data->>'code'=$2", [
              actor.tenantId,
              feature.properties.code,
            ])
          ).rowCount
        )
          throw new ConflictException(
            `Road code ${feature.properties.code} already exists; import uses unique codes.`,
          );
        const road: Road = {
          id: uuid(),
          name: feature.properties.name,
          code: feature.properties.code,
          owner: feature.properties.owner,
          region: feature.properties.region,
          surface: feature.properties.surface,
          geometry: feature.geometry,
          lengthM: lineLengthM(feature.geometry),
          version: 1,
          updatedAt: now(),
        };
        if (road.lengthM < 1 || road.lengthM > 100000)
          throw new BadRequestException('Each imported road link must be between 1 m and 100 km.');
        await c.query('INSERT INTO roads(id,tenant_id,data) VALUES($1,$2,$3)', [
          road.id,
          actor.tenantId,
          JSON.stringify(road),
        ]);
        for (const segment of splitRoadSegments(road, 100)) {
          segment.id = uuid();
          await c.query('INSERT INTO segments(id,tenant_id,road_id,data) VALUES($1,$2,$3,$4)', [
            segment.id,
            actor.tenantId,
            road.id,
            JSON.stringify(segment),
          ]);
        }
        await audit(c, actor, 'road.imported', 'road', road.id, {
          source: 'user_geojson',
          code: road.code,
          authorityVerified: false,
        });
        created.push(road);
      }
      return created;
    });
  }
  async createCalibration(actor: Principal, body: unknown) {
    requireRole(actor, 'admin', 'reviewer');
    const input = parse(
      z
        .object({
          deviceId: z.string().uuid(),
          name: z.string().max(120).optional(),
          method: z.string().trim().min(2).max(100),
          cameraHeightM: z.number().positive().max(10).optional(),
          intrinsics: z.array(z.array(z.number().finite()).length(3)).length(3).optional(),
          distortion: z.array(z.number().finite()).max(14).optional(),
          validUntil: z.string().datetime({ offset: true }).optional(),
          notes: z.string().max(4000).optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
          projection: projectionSchema.optional(),
        })
        .strict(),
      body,
    );
    return this.db.tx(async (c) => {
      const d = await this.get(actor, 'devices', input.deviceId, c, true),
        id = uuid(),
        calibration = {
          ...input,
          id,
          projection: input.projection ? { ...input.projection, id } : undefined,
          createdAt: now(),
          createdBy: actor.id,
          status: 'recorded',
          verified: false,
          reason:
            'Declared calibration parameters yield estimates only. Operational acceptance requires independent field validation.',
        };
      await c.query('INSERT INTO calibrations(id,tenant_id,device_id,data) VALUES($1,$2,$3,$4)', [
        calibration.id,
        actor.tenantId,
        d.id,
        JSON.stringify(calibration),
      ]);
      // Metadata entry alone must not advertise a physically validated camera.
      d.calibrationStatus =
        input.validUntil && new Date(input.validUntil) < new Date() ? 'expired' : 'missing';
      await c.query('UPDATE devices SET data=$3 WHERE tenant_id=$1 AND id=$2', [
        actor.tenantId,
        d.id,
        JSON.stringify(d),
      ]);
      await audit(c, actor, 'calibration.recorded', 'calibration', calibration.id, {
        deviceId: d.id,
      });
      return calibration;
    });
  }
}
