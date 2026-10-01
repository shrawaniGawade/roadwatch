import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { z } from 'zod';
import { dashboardMetrics } from '@roadwatch/domain';
import { AssetsService } from './assets.service';
import { FindingsService } from './findings.service';
import { MediaService } from './media.service';
import { Database } from './database';
import {
  AuthService,
  AuthedRequest,
  SESSION_COOKIE,
  SessionGuard,
  requireRole,
  validateOrigin,
} from './security';
import { digest } from './credentials';
import { UsersService } from './users.service';
import { audit, csvCell, identifier, now, parse } from './utils';

@Controller('v1')
export class HealthController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get('health') health() {
    return { status: 'ok', service: 'roadwatch-api', time: now() };
  }
  @Get('ready') async ready() {
    await this.db.query('SELECT 1');
    let vision: any = { ready: false, reason: 'Vision service is unavailable.' };
    try {
      const r = await fetch(`${process.env.VISION_URL || 'http://127.0.0.1:8001'}/ready`, {
        signal: AbortSignal.timeout(3000),
      });
      vision = await r.json();
    } catch {}
    let automation: any = {
      fresh: false,
      reason: 'Automation worker has not reported a successful cycle.',
    };
    if ((await this.db.query("SELECT to_regclass('public.automation_status') AS t")).rows[0].t) {
      const row = (
        await this.db.query('SELECT max(last_success_at) AS latest FROM automation_status')
      ).rows[0];
      if (row.latest) {
        const ageSeconds = Math.max(0, (Date.now() - new Date(row.latest).getTime()) / 1000);
        automation = {
          fresh: ageSeconds < 120,
          lastSuccessAt: row.latest,
          ageSeconds: Math.round(ageSeconds),
        };
      }
    }
    return {
      status: 'ready',
      database: 'connected',
      spatialMode: this.db.spatialMode,
      storageDriver: process.env.STORAGE_DRIVER || 'local',
      vision,
      automation,
    };
  }
}
@Controller('v1/auth')
export class AuthController {
  constructor(
    @Inject(AuthService) readonly auth: AuthService,
    @Inject(Database) readonly db: Database,
  ) {}
  private options() {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure:
        process.env.COOKIE_SECURE !== undefined
          ? process.env.COOKIE_SECURE === 'true'
          : process.env.NODE_ENV === 'production',
      path: '/',
    };
  }
  @Post('login') @HttpCode(200) async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    validateOrigin(req);
    const input = parse(
      z
        .object({ email: z.string().email().max(320), password: z.string().min(1).max(1024) })
        .strict(),
      body,
    );
    const result = await this.auth.login(input.email, input.password, req.ip || 'unknown');
    res.cookie(SESSION_COOKIE, result.token, { ...this.options(), maxAge: 12 * 3600 * 1000 });
    return result.user;
  }
  @Get('me') @UseGuards(SessionGuard) me(@Req() req: AuthedRequest) {
    return req.actor;
  }
  @Post('logout') @HttpCode(200) @UseGuards(SessionGuard) async logout(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.db.query('DELETE FROM sessions WHERE token_hash=$1', [
      digest(req.cookies[SESSION_COOKIE]),
    ]);
    res.clearCookie(SESSION_COOKIE, this.options());
    return { ok: true };
  }
}
@Controller('v1')
@UseGuards(SessionGuard)
export class AssetsController {
  constructor(
    @Inject(AssetsService) readonly assets: AssetsService,
    @Inject(Database) readonly db: Database,
  ) {}
  @Get('dashboard') dashboard(@Req() r: AuthedRequest) {
    return this.assets.dashboard(r.actor);
  }
  @Get('roads') roads(@Req() r: AuthedRequest) {
    return this.assets.list(r.actor, 'roads');
  }
  @Get('roads/:id') road(@Req() r: AuthedRequest, @Param('id') id: string) {
    return this.assets.get(r.actor, 'roads', id);
  }
  @Get('segments') segments(@Req() r: AuthedRequest) {
    return this.assets.list(r.actor, 'segments');
  }
  @Get('devices') devices(@Req() r: AuthedRequest) {
    return this.assets.list(r.actor, 'devices');
  }
  @Post('devices') createDevice(@Req() r: AuthedRequest, @Body() b: unknown) {
    return this.assets.createDevice(r.actor, b);
  }
  @Post('devices/heartbeat') heartbeat(@Req() r: AuthedRequest, @Body() b: unknown) {
    return this.assets.heartbeat(r.actor, b);
  }
  @Post('devices/:id/rotate-token') rotate(@Req() r: AuthedRequest, @Param('id') id: string) {
    return this.assets.rotateDeviceToken(r.actor, id);
  }
  @Post('devices/:id/revoke') revoke(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.assets.revokeDevice(r.actor, id, b);
  }
  @Get('surveys') surveys(@Req() r: AuthedRequest) {
    return this.assets.list(r.actor, 'surveys');
  }
  @Post('surveys') createSurvey(@Req() r: AuthedRequest, @Body() b: unknown) {
    return this.assets.createSurvey(r.actor, b);
  }
  @Post('surveys/:id/complete') completeSurvey(@Req() r: AuthedRequest, @Param('id') id: string) {
    return this.assets.completeSurvey(r.actor, id);
  }
  @Post('roads/import') importRoads(@Req() r: AuthedRequest, @Body() b: unknown) {
    return this.assets.importRoads(r.actor, b);
  }
  @Get('calibrations') calibrations(@Req() r: AuthedRequest) {
    return this.assets.list(r.actor, 'calibrations');
  }
  @Post('calibrations') createCalibration(@Req() r: AuthedRequest, @Body() b: unknown) {
    return this.assets.createCalibration(r.actor, b);
  }
  @Get('audit') activity(@Req() r: AuthedRequest) {
    requireRole(r.actor, 'admin', 'planner', 'reviewer');
    return this.assets.activity(r.actor);
  }
  @Get('settings') settings(@Req() r: AuthedRequest) {
    return this.assets.settings(r.actor);
  }
  @Get('notifications') async notifications(@Req() r: AuthedRequest) {
    if (!(await this.db.query("SELECT to_regclass('public.notifications') AS t")).rows[0].t)
      return [];
    return (
      await this.db.query(
        'SELECT id,title,body,entity_type AS "entityType",entity_id AS "entityId",created_at AS "createdAt",acknowledged_at AS "acknowledgedAt" FROM notifications WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 250',
        [r.actor.tenantId],
      )
    ).rows;
  }
  @Post('notifications/:id/acknowledge') async acknowledge(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
  ) {
    identifier(id);
    return this.db.tx(async (c) => {
      if (!(await c.query("SELECT to_regclass('public.notifications') AS t")).rows[0].t)
        throw new BadRequestException('Notifications are not initialized.');
      const row = (
        await c.query(
          'UPDATE notifications SET acknowledged_at=COALESCE(acknowledged_at,now()),acknowledged_by=COALESCE(acknowledged_by,$3) WHERE tenant_id=$1 AND id=$2 RETURNING id,acknowledged_at AS "acknowledgedAt"',
          [r.actor.tenantId, id, r.actor.id],
        )
      ).rows[0];
      if (!row) throw new BadRequestException('Notification was not found.');
      await audit(c, r.actor, 'notification.acknowledged', 'notification', id);
      return row;
    });
  }
}
@Controller('v1')
@UseGuards(SessionGuard)
export class FindingsController {
  constructor(
    @Inject(FindingsService) readonly findings: FindingsService,
    @Inject(AssetsService) readonly assets: AssetsService,
  ) {}
  @Get('defects') defects(@Req() r: AuthedRequest) {
    return this.assets.list(r.actor, 'defects');
  }
  @Get('defects/:id') defect(@Req() r: AuthedRequest, @Param('id') id: string) {
    return this.assets.get(r.actor, 'defects', id);
  }
  @Post('defects') create(@Req() r: AuthedRequest, @Body() b: unknown) {
    return this.findings.create(r.actor, b);
  }
  @Post('defects/:id/measurements') measurements(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.findings.recordMeasurements(r.actor, id, b);
  }
  @Post('defects/:id/reviews') review(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.findings.review(r.actor, id, b);
  }
  @Get('work-orders') orders(@Req() r: AuthedRequest) {
    return this.assets.list(r.actor, 'work_orders');
  }
  @Post('work-orders') createOrder(@Req() r: AuthedRequest, @Body() b: unknown) {
    return this.findings.createOrder(r.actor, b);
  }
  @Post('work-orders/:id/transitions') transition(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.findings.transition(r.actor, id, b);
  }
  @Patch('settings') settings(@Req() r: AuthedRequest, @Body() b: unknown) {
    return this.findings.updateSettings(r.actor, b);
  }
}
@Controller('v1')
@UseGuards(SessionGuard)
export class MediaController {
  constructor(@Inject(MediaService) readonly mediaService: MediaService) {}
  @Post('uploads')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 32 * 1024 * 1024, files: 1, fields: 10, fieldSize: 262144 },
    }),
  )
  upload(
    @Req() r: AuthedRequest,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
    @Headers('x-content-sha256') checksum?: string,
  ) {
    return this.mediaService.upload(r.actor, file, body, key, checksum);
  }
  @Get('jobs') jobs(@Req() r: AuthedRequest) {
    return this.mediaService.jobs(r.actor);
  }
  @Post('jobs/:id/retry') retry(@Req() r: AuthedRequest, @Param('id') id: string) {
    return this.mediaService.retry(r.actor, id);
  }
  @Post('jobs/:id/observations/:index/locate') locate(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @Param('index') index: string,
    @Body() body: unknown,
  ) {
    return this.mediaService.locateObservation(r.actor, id, index, body);
  }
  @Get('media/:id') async media(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const m = await this.mediaService.readMedia(r.actor, id),
      size = Number(m.size_bytes);
    let start = 0,
      end = size - 1;
    const range = r.get('range');
    res.set({
      'Content-Type': m.mime_type,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(m.filename)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
    });
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        res.status(416).set('Content-Range', `bytes */${size}`).end();
        return;
      }
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (start >= size || end < start) {
        res.status(416).set('Content-Range', `bytes */${size}`).end();
        return;
      }
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.set('Content-Length', String(end - start + 1));
    res.send(m.bytes.subarray(start, end + 1));
  }
}
@Controller('v1/reports')
@UseGuards(SessionGuard)
export class ReportsController {
  constructor(
    @Inject(AssetsService) readonly assets: AssetsService,
    @Inject(Database) readonly db: Database,
  ) {}
  private async snapshot(r: AuthedRequest, format: string) {
    requireRole(r.actor, 'admin', 'planner', 'reviewer');
    return this.db.tx(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const data = await this.assets.dashboard(r.actor, c);
      await audit(c, r.actor, 'report.exported', 'organization', r.actor.tenantId, {
        format,
        defectCount: data.defects.length,
      });
      return data;
    });
  }
  @Get('summary') async summary(@Req() r: AuthedRequest) {
    const data = await this.snapshot(r, 'json');
    return {
      generatedAt: now(),
      metrics: dashboardMetrics(data),
      ...data,
      disclaimer: data.isDemo
        ? 'Illustrative fixture data; not real hazard claims.'
        : 'Measurements retain provenance and uncertainty; report requires authorized engineering review.',
    };
  }
  @Get('defects.csv') async csv(@Req() r: AuthedRequest, @Res() res: Response) {
    const data = await this.snapshot(r, 'csv');
    const rows = [
      [
        'Code',
        'Road',
        'Type',
        'Status',
        'Priority',
        'Severity',
        'Latitude',
        'Longitude',
        'Location accuracy m',
        'Chainage m',
        'Length m',
        'Length status',
        'Width m',
        'Width status',
        'Depth mm',
        'Depth status',
        'Observed at',
        'Description',
        'Data mode',
      ],
      ...data.defects.map((d) => [
        d.code,
        d.roadName,
        d.type,
        d.status,
        d.priority,
        d.severity,
        d.latitude,
        d.longitude,
        d.locationAccuracyM,
        d.chainageM,
        d.length.value,
        d.length.status,
        d.width.value,
        d.width.status,
        d.depth.value,
        d.depth.status,
        d.observedAt,
        d.description,
        data.isDemo ? 'Illustrative demo' : 'Operational',
      ]),
    ];
    res
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="roadwatch-defects.csv"',
        'Cache-Control': 'no-store',
      })
      .send(rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
  }
  @Get('geojson') async geojson(@Req() r: AuthedRequest) {
    const data = await this.snapshot(r, 'geojson');
    return {
      type: 'FeatureCollection',
      generatedAt: now(),
      isDemo: data.isDemo,
      features: [
        ...data.roads.map((road) => ({
          type: 'Feature',
          id: road.id,
          geometry: road.geometry,
          properties: {
            name: road.name,
            code: road.code,
            kind: 'road',
            region: road.region,
            owner: road.owner,
          },
        })),
        ...data.defects.map((d) => ({
          type: 'Feature',
          id: d.id,
          geometry: { type: 'Point', coordinates: [d.longitude, d.latitude] },
          properties: {
            code: d.code,
            roadId: d.roadId,
            type: d.type,
            status: d.status,
            priority: d.priority,
            locationAccuracyM: d.locationAccuracyM,
            source: d.source,
            depth: d.depth,
          },
        })),
      ],
    };
  }
}
@Controller('v1/users')
@UseGuards(SessionGuard)
export class UsersController {
  constructor(@Inject(UsersService) readonly users: UsersService) {}
  @Get() list(@Req() r: AuthedRequest) {
    return this.users.list(r.actor);
  }
  @Post() create(@Req() r: AuthedRequest, @Body() b: unknown) {
    return this.users.create(r.actor, b);
  }
  @Patch(':id') update(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) {
    return this.users.update(r.actor, id, b);
  }
}
