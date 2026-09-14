import type { Database } from './database';
import { hashPassword } from './credentials';
import {
  assessPriority,
  estimatedMeasurement,
  unknownMeasurement,
  lineLengthM,
  splitRoadSegments,
  pointAtChainage,
  type Road,
  type Defect,
  type Device,
  type Survey,
  type WorkOrder,
} from '@roadwatch/domain';

export const DEMO_TENANT = '00000000-0000-4000-8000-000000000001';
const fixed = (kind: number, index: number) =>
  `${String(kind).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`;
export async function seed(db: Database) {
  const email = (process.env.SEED_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;
  if (
    !(await db.query('SELECT id FROM users LIMIT 1')).rowCount &&
    (!email || !password || password.length < 12)
  ) {
    throw new Error(
      'Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters) to initialize the administrator. No default password is provided.',
    );
  }
  if (!email || !password) return;
  const passwordHash = await hashPassword(password);
  const teamHash = process.env.SEED_TEAM_PASSWORD
    ? await hashPassword(process.env.SEED_TEAM_PASSWORD)
    : null;
  const demo = process.env.DEMO_SEED === 'true';
  await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(71836212)');
    if ((await c.query('SELECT id FROM users WHERE email=$1', [email])).rowCount) return;
    await c.query(
      'INSERT INTO tenants(id,name,is_demo,settings) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',
      [
        DEMO_TENANT,
        demo ? 'Hyderabad RoadWatch · Demo' : 'RoadWatch',
        demo,
        JSON.stringify({
          organizationName: demo ? 'Hyderabad RoadWatch · Demo' : 'RoadWatch',
          defaultRegion: 'Central zone',
          retentionDays: 30,
          version: 1,
        }),
      ],
    );
    await c.query(
      'INSERT INTO users(id,tenant_id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)',
      [fixed(1, 1), DEMO_TENANT, email, 'RoadWatch Administrator', passwordHash, 'admin'],
    );
    if (teamHash)
      for (const [i, role] of ['reviewer', 'planner', 'crew', 'viewer'].entries()) {
        await c.query(
          'INSERT INTO users(id,tenant_id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(email) DO NOTHING',
          [fixed(1, i + 2), DEMO_TENANT, `${role}@roadwatch.local`, `Demo ${role}`, teamHash, role],
        );
      }
    if (!demo) return;
    const stamp = '2026-09-08T06:30:00.000Z';
    const specifications = [
      [
        'Lake View Road',
        'RW-101',
        'Central zone',
        'Municipal roads division',
        [
          [78.458, 17.419],
          [78.465, 17.422],
          [78.472, 17.425],
          [78.479, 17.427],
        ],
      ],
      [
        'University Link',
        'RW-102',
        'West zone',
        'Municipal roads division',
        [
          [78.452, 17.415],
          [78.456, 17.407],
          [78.462, 17.401],
          [78.47, 17.397],
        ],
      ],
      [
        'Market Street',
        'RW-103',
        'Central zone',
        'Municipal roads division',
        [
          [78.466, 17.411],
          [78.474, 17.414],
          [78.482, 17.416],
          [78.489, 17.42],
        ],
      ],
      [
        'Eastern Connector',
        'RW-104',
        'East zone',
        'Municipal roads division',
        [
          [78.484, 17.403],
          [78.49, 17.408],
          [78.496, 17.414],
          [78.502, 17.421],
        ],
      ],
      [
        'Hospital Approach',
        'RW-105',
        'South zone',
        'Municipal roads division',
        [
          [78.465, 17.392],
          [78.474, 17.395],
          [78.481, 17.399],
        ],
      ],
      [
        'Garden Avenue',
        'RW-106',
        'North zone',
        'Municipal roads division',
        [
          [78.46, 17.433],
          [78.47, 17.436],
          [78.481, 17.439],
        ],
      ],
    ];
    const roads: Road[] = [];
    const segments: any[] = [];
    for (const [i, s] of specifications.entries()) {
      const road: Road = {
        id: fixed(2, i + 1),
        name: s[0] as string,
        code: s[1] as string,
        region: s[2] as string,
        owner: s[3] as string,
        surface: 'Asphalt',
        geometry: { type: 'LineString', coordinates: s[4] as [number, number][] },
        lengthM: 0,
        version: 1,
        updatedAt: stamp,
      };
      road.lengthM = lineLengthM(road.geometry);
      roads.push(road);
      await c.query('INSERT INTO roads(id,tenant_id,data) VALUES($1,$2,$3)', [
        road.id,
        DEMO_TENANT,
        JSON.stringify(road),
      ]);
      for (const [j, part] of splitRoadSegments(road, 200).entries()) {
        const segment = {
          ...part,
          id: fixed(3, (i + 1) * 100 + j),
          coveragePct: j % 5 === 0 ? 0 : j % 3 === 0 ? 65 : 100,
          lastSurveyAt: j % 5 === 0 ? null : stamp,
        };
        segments.push(segment);
        await c.query('INSERT INTO segments(id,tenant_id,road_id,data) VALUES($1,$2,$3,$4)', [
          segment.id,
          DEMO_TENANT,
          road.id,
          JSON.stringify(segment),
        ]);
      }
    }
    const devices: Device[] = [
      {
        id: fixed(4, 1),
        name: 'Survey vehicle 01',
        kind: 'vehicle',
        status: 'offline',
        vehiclePlate: 'DEMO-01',
        cameraModel: 'Calibrated stereo rig (illustrative)',
        lastSeenAt: stamp,
        latitude: 17.422,
        longitude: 78.465,
        calibrationStatus: 'missing',
        uploadBacklog: 0,
      },
      {
        id: fixed(4, 2),
        name: 'Survey vehicle 02',
        kind: 'vehicle',
        status: 'offline',
        vehiclePlate: 'DEMO-02',
        cameraModel: 'Forward RGB camera (illustrative)',
        lastSeenAt: stamp,
        latitude: 17.408,
        longitude: 78.456,
        calibrationStatus: 'missing',
        uploadBacklog: 0,
      },
      {
        id: fixed(4, 3),
        name: 'Market junction CCTV',
        kind: 'cctv',
        status: 'offline',
        vehiclePlate: null,
        cameraModel: 'ONVIF camera (illustrative)',
        lastSeenAt: null,
        latitude: 17.416,
        longitude: 78.482,
        calibrationStatus: 'missing',
        uploadBacklog: 0,
      },
    ];
    for (const d of devices)
      await c.query('INSERT INTO devices(id,tenant_id,data) VALUES($1,$2,$3)', [
        d.id,
        DEMO_TENANT,
        JSON.stringify(d),
      ]);
    const survey: Survey = {
      id: fixed(5, 1),
      name: 'Illustrative central-zone survey',
      deviceId: devices[0].id,
      status: 'completed',
      startedAt: '2026-09-08T03:30:00Z',
      completedAt: stamp,
      roadIds: roads.map((r) => r.id),
      framesProcessed: 0,
      defectsDetected: 18,
      distanceKm: 12.4,
    };
    await c.query('INSERT INTO surveys(id,tenant_id,device_id,data) VALUES($1,$2,$3,$4)', [
      survey.id,
      DEMO_TENANT,
      survey.deviceId,
      JSON.stringify(survey),
    ]);
    const types = [
      'pothole',
      'longitudinal_crack',
      'alligator_crack',
      'pothole',
      'edge_break',
      'patch_deterioration',
      'transverse_crack',
      'raveling',
      'surface_deformation',
    ] as const;
    const defects: Defect[] = [];
    for (let i = 0; i < 18; i++) {
      const road = roads[i % roads.length],
        type = types[i % types.length],
        distance = road.lengthM * (0.12 + Math.floor(i / 6) * 0.3),
        position = pointAtChainage(road.geometry, distance),
        depth = type === 'pothole' ? [68, 35, 18][Math.floor(i / 6)] : undefined;
      const assessment = assessPriority({
        type,
        depthMm: depth,
        trafficExposure: i % 4 === 0 ? 95 : 60,
        vulnerableContext: i % 5 === 0 ? 100 : 40,
        growthScore: 50,
        ageDays: 3 + i,
      });
      const status = i < 5 ? 'candidate' : i < 13 ? 'confirmed' : i < 16 ? 'assigned' : 'closed';
      const defect: Defect = {
        id: fixed(6, i + 1),
        code: `RW-${String(2401 + i)}`,
        roadId: road.id,
        roadName: road.name,
        segmentId:
          segments.find(
            (s) =>
              s.roadId === road.id && s.chainageStartM <= distance && s.chainageEndM >= distance,
          )?.id || null,
        type,
        status,
        priority: assessment.priority,
        severity: assessment.severity,
        latitude: position[1],
        longitude: position[0],
        locationAccuracyM: null,
        chainageM: distance,
        description:
          'Illustrative planning fixture. This is not an observed hazard or an official road inventory.',
        length: estimatedMeasurement(type === 'pothole' ? 0.75 : 2.3, 'm', 'demo_fixture'),
        width: estimatedMeasurement(type === 'pothole' ? 0.52 : 0.12, 'm', 'demo_fixture'),
        depth: estimatedMeasurement(depth, 'mm', 'demo_fixture'),
        area: unknownMeasurement('m2', 'Illustrative fixture; no surveyed area'),
        confidence: null,
        source: 'demo_fixture',
        observedAt: `2026-09-${String(1 + (i % 8)).padStart(2, '0')}T04:20:00Z`,
        updatedAt: stamp,
        version: 1,
        evidence: [],
        assessment,
      };
      defects.push(defect);
      await c.query(
        'INSERT INTO defects(id,tenant_id,road_id,segment_id,data) VALUES($1,$2,$3,$4,$5)',
        [defect.id, DEMO_TENANT, road.id, defect.segmentId, JSON.stringify(defect)],
      );
    }
    const order: WorkOrder = {
      id: fixed(7, 1),
      code: 'WO-1001',
      defectIds: defects.slice(13, 16).map((d) => d.id),
      crew: 'Central maintenance crew',
      description: 'Illustrative assignment for coordinated patch repairs.',
      status: 'assigned',
      dueAt: '2026-09-10T12:00:00Z',
      createdAt: stamp,
      updatedAt: stamp,
      version: 1,
      notes: 'Demo workflow; no dispatch sent.',
    };
    await c.query('INSERT INTO work_orders(id,tenant_id,data) VALUES($1,$2,$3)', [
      order.id,
      DEMO_TENANT,
      JSON.stringify(order),
    ]);
    for (const id of order.defectIds)
      await c.query(
        'INSERT INTO work_order_defects(tenant_id,work_order_id,defect_id) VALUES($1,$2,$3)',
        [DEMO_TENANT, order.id, id],
      );
    await c.query(
      'INSERT INTO audit(id,tenant_id,actor,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        fixed(8, 1),
        DEMO_TENANT,
        'System',
        'demo.seeded',
        'organization',
        DEMO_TENANT,
        JSON.stringify({
          message:
            'Illustrative Hyderabad-area fixtures, not official roads or real hazard claims.',
        }),
      ],
    );
  });
}
