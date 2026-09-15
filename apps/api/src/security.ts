import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { checkPassword, digest } from './credentials';
export { checkPassword, digest, hashPassword } from './credentials';
import { Request } from 'express';
import { Database } from './database';

export const SESSION_COOKIE = 'roadwatch_session';
export interface Principal {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  role: string;
  deviceId?: string;
}
export type AuthedRequest = Request & { actor: Principal };
export function requireRole(actor: Principal, ...roles: string[]) {
  if (!roles.includes(actor.role))
    throw new ForbiddenException({
      message: 'Your role cannot perform this action.',
      code: 'forbidden',
    });
}
export function validateOrigin(req: Request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const allowed = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((s) => s.trim());
  const origin = req.get('origin');
  if ((origin && !allowed.includes(origin)) || (!origin && req.cookies?.[SESSION_COOKIE])) {
    throw new ForbiddenException({
      message: 'A trusted Origin header is required for browser writes.',
      code: 'invalid_origin',
    });
  }
}
@Injectable()
export class AuthService {
  constructor(@Inject(Database) readonly db: Database) {}
  async login(email: string, password: string, ip: string) {
    // Persistent per-address and per-account limits; failed attempts survive process restarts.
    for (const key of [`ip:${digest(ip)}`, `email:${digest(email.toLowerCase())}`]) {
      const result = await this.db.query(
        `INSERT INTO login_limits(key,attempts) VALUES($1,1)
        ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_limits.started_at<now()-interval '15 minutes' THEN 1 ELSE login_limits.attempts+1 END,
        started_at=CASE WHEN login_limits.started_at<now()-interval '15 minutes' THEN now() ELSE login_limits.started_at END RETURNING attempts`,
        [key],
      );
      const limit = key.startsWith('ip:') ? 200 : 20;
      if (result.rows[0].attempts > limit)
        throw new HttpException(
          { message: 'Too many login attempts. Try again in 15 minutes.', code: 'rate_limited' },
          429,
        );
    }
    const u = (
      await this.db.query('SELECT * FROM users WHERE email=$1 AND active=true', [
        email.toLowerCase(),
      ])
    ).rows[0];
    const valid = await checkPassword(
      password,
      u?.password_hash || `scrypt:missing:${'0'.repeat(128)}`,
    );
    if (!u || !valid)
      throw new UnauthorizedException({
        message: 'Email or password is incorrect.',
        code: 'invalid_credentials',
      });
    // Successful authentication resets only that account's failure counter. The broader IP abuse budget remains intact.
    await this.db.query('DELETE FROM login_limits WHERE key=$1', [
      `email:${digest(email.toLowerCase())}`,
    ]);
    const token = randomBytes(32).toString('base64url');
    await this.db.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')",
      [digest(token), u.id],
    );
    return { token, user: this.principal(u) };
  }
  principal(row: any): Principal {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      email: row.email,
      name: row.name,
      role: row.role,
    };
  }
  async authenticate(req: Request): Promise<Principal> {
    const bearer = req.get('authorization');
    if (bearer?.startsWith('Bearer ')) {
      const allowed =
        (req.method === 'POST' &&
          ['/v1/uploads', '/v1/surveys', '/v1/devices/heartbeat'].includes(req.path)) ||
        (req.method === 'POST' && /^\/v1\/surveys\/[a-f0-9-]+\/complete$/.test(req.path));
      if (!allowed)
        throw new ForbiddenException({
          message: 'Device credentials cannot access this endpoint.',
          code: 'device_scope',
        });
      const d = (
        await this.db.query('SELECT id,tenant_id,data FROM devices WHERE token_hash=$1', [
          digest(bearer.slice(7)),
        ])
      ).rows[0];
      if (!d || d.data.status === 'revoked')
        throw new UnauthorizedException('Invalid device credential.');
      return {
        id: d.id,
        deviceId: d.id,
        tenantId: d.tenant_id,
        email: '',
        name: d.data.name,
        role: 'device',
      };
    }
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token || typeof token !== 'string')
      throw new UnauthorizedException({ message: 'Please sign in.', code: 'unauthenticated' });
    const row = (
      await this.db.query(
        `SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true`,
        [digest(token)],
      )
    ).rows[0];
    if (!row)
      throw new UnauthorizedException({
        message: 'Your session expired. Please sign in.',
        code: 'unauthenticated',
      });
    return this.principal(row);
  }
}
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    validateOrigin(req);
    req.actor = await this.auth.authenticate(req);
    return true;
  }
}
