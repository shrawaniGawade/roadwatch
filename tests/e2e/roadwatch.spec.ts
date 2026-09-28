import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { Pool } from 'pg';

const createdDefects: string[] = [];
const observationNote = 'Browser test: field inspection needed at road approach';
test.beforeAll(() => {
  expect(process.env.NODE_ENV).not.toBe('production');
  expect(process.env.DEMO_SEED).toBe('true');
  expect(['localhost', '127.0.0.1']).toContain(
    new URL(process.env.WEB_URL || 'http://localhost:3000').hostname,
  );
});
test.afterAll(async () => {
  if (!createdDefects.length) return;
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const id of createdDefects) {
      const row = (
        await client.query('SELECT tenant_id,data FROM defects WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      expect(row?.data.description).toBe(observationNote);
      expect(row?.data.status).toBe('candidate');
      expect(row?.data.version).toBe(1);
      await client.query(
        'SELECT id FROM outbox WHERE tenant_id=$1 AND aggregate_id=$2 FOR UPDATE',
        [row.tenant_id, id],
      );
      await client.query('DELETE FROM notifications WHERE tenant_id=$1 AND entity_id=$2', [
        row.tenant_id,
        id,
      ]);
      await client.query('DELETE FROM outbox WHERE tenant_id=$1 AND aggregate_id=$2', [
        row.tenant_id,
        id,
      ]);
      await client.query('DELETE FROM audit WHERE tenant_id=$1 AND entity_id=$2', [
        row.tenant_id,
        id,
      ]);
      await client.query('DELETE FROM defects WHERE tenant_id=$1 AND id=$2', [row.tenant_id, id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await db.end();
  }
});

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(process.env.ADMIN_EMAIL!);
  await page.getByLabel('Password', { exact: true }).fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Every road. A clearer picture.' })).toBeVisible();
  await expect(page.getByText('Workspace connected')).toBeVisible();
}

test('operator signs in, loads the real road map and can navigate every workspace', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await expect(page.getByRole('heading', { name: 'Network overview' })).toBeVisible();
  await expect(page.locator('.map-defect').first()).toBeVisible();
  await mkdir('.artifacts/screenshots', { recursive: true });
  await page.screenshot({ path: '.artifacts/screenshots/overview-desktop.png', fullPage: true });
  for (const [route, title] of [
    ['defects', 'Defect review'],
    ['roads', 'Road network'],
    ['fleet', 'Fleet & devices'],
    ['surveys', 'Surveys & capture'],
    ['maintenance', 'Maintenance'],
    ['reports', 'Reports'],
    ['settings', 'Administration'],
  ]) {
    await page.goto('/' + route);
    await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible();
    await expect(page.getByText('Workspace connected')).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('browser report persists and is reviewable after reloading', async ({ page }) => {
  await login(page);
  const roads = await (await page.request.get('/api/v1/roads')).json();
  const road = roads[0];
  const [longitude, latitude] = road.geometry.coordinates[0];
  await page.getByRole('button', { name: 'Report defect' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Road', exact: true }).selectOption(road.id);
  await dialog.getByLabel('Latitude', { exact: true }).fill(String(latitude));
  await dialog.getByLabel('Longitude', { exact: true }).fill(String(longitude));
  await dialog.getByLabel('Observation notes').fill(observationNote);
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/defects') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Save observation' }).click();
  const response = await saved;
  expect(response.ok()).toBeTruthy();
  const defect = await response.json();
  createdDefects.push(defect.id);
  await expect(dialog).not.toBeVisible();
  await page.goto(`/defects?id=${defect.id}`);
  await expect(page.locator('.detail-code')).toContainText(defect.code);
  await expect(page.locator('.measurement-grid')).toContainText('Unknown');
  await page.reload();
  await expect(page.locator('.detail-code')).toContainText(defect.code);
  await page.screenshot({ path: '.artifacts/screenshots/defect-review.png', fullPage: true });
});

test('CSV report download comes from the authenticated API', async ({ page }) => {
  await login(page);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe('roadwatch-defects.csv');
  expect(await file.failure()).toBeNull();
});

test('mobile navigation is usable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Road network' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Road network' })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBeTruthy();
  await page.screenshot({ path: '.artifacts/screenshots/roads-mobile.png', fullPage: true });
});
