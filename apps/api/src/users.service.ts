import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Database } from './database';
import { hashPassword } from './credentials';
import { Principal, requireRole } from './security';
import { audit, identifier, missing, parse, uuid } from './utils';
const role = z.enum(['admin', 'planner', 'reviewer', 'crew', 'viewer']);
const userInput = z
  .object({
    email: z
      .string()
      .email()
      .max(320)
      .transform((s) => s.toLowerCase()),
    name: z.string().trim().min(2).max(120),
    role,
    password: z.string().min(12).max(1024),
  })
  .strict();
const userView = (r: any) => ({
  id: r.id,
  tenantId: r.tenant_id,
  name: r.name,
  email: r.email,
  role: r.role,
  active: r.active,
  createdAt: r.created_at,
});
@Injectable()
export class UsersService {
  constructor(@Inject(Database) readonly db: Database) {}
  async list(actor: Principal) {
    requireRole(actor, 'admin');
    return (
      await this.db.query(
        'SELECT id,tenant_id,name,email,role,active,created_at FROM users WHERE tenant_id=$1 ORDER BY name',
        [actor.tenantId],
      )
    ).rows.map(userView);
  }
  async create(actor: Principal, body: unknown) {
    requireRole(actor, 'admin');
    const input = parse(userInput, body),
      hash = await hashPassword(input.password);
    return this.db.tx(async (c) => {
      const id = uuid();
      const row = (
        await c.query(
          'INSERT INTO users(id,tenant_id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,tenant_id,name,email,role,active,created_at',
          [id, actor.tenantId, input.email, input.name, input.role, hash],
        )
      ).rows[0];
      await audit(c, actor, 'user.created', 'user', id, { role: input.role });
      return userView(row);
    });
  }
  async update(actor: Principal, id: string, body: unknown) {
    requireRole(actor, 'admin');
    identifier(id);
    const input = parse(
        z
          .object({
            name: z.string().trim().min(2).max(120).optional(),
            role: role.optional(),
            active: z.boolean().optional(),
            password: z.string().min(12).max(1024).optional(),
          })
          .strict()
          .refine((v) => Object.keys(v).length > 0, 'Provide a change.'),
        body,
      ),
      hash = input.password ? await hashPassword(input.password) : undefined;
    return this.db.tx(async (c) => {
      // Serialize all role changes in a tenant so two concurrent demotions cannot remove both administrators.
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [actor.tenantId]);
      const old = (
        await c.query('SELECT * FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
          actor.tenantId,
          id,
        ])
      ).rows[0];
      if (!old) missing('User');
      const next = {
        ...old,
        name: input.name ?? old.name,
        role: input.role ?? old.role,
        active: input.active ?? old.active,
        password_hash: hash ?? old.password_hash,
      };
      if (old.role === 'admin' && old.active && (!next.active || next.role !== 'admin')) {
        const count = (
          await c.query(
            "SELECT count(*)::int AS n FROM users WHERE tenant_id=$1 AND role='admin' AND active=true",
            [actor.tenantId],
          )
        ).rows[0].n;
        if (count <= 1)
          throw new ConflictException(
            'The last active administrator cannot be demoted or deactivated.',
          );
      }
      await c.query(
        'UPDATE users SET name=$3,role=$4,active=$5,password_hash=$6 WHERE tenant_id=$1 AND id=$2',
        [actor.tenantId, id, next.name, next.role, next.active, next.password_hash],
      );
      if (hash || input.role !== undefined || input.active !== undefined)
        await c.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await audit(c, actor, 'user.updated', 'user', id, {
        fields: Object.keys(input).filter((k) => k !== 'password'),
        passwordChanged: !!hash,
      });
      return userView(next);
    });
  }
}
