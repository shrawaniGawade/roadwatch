import type { Pool } from 'pg';
export async function initializeSpatial(pool: Pool): Promise<'postgis' | 'local_approximation'> {
  let installed = (await pool.query("SELECT 1 FROM pg_extension WHERE extname='postgis'")).rowCount;
  if (
    !installed &&
    (await pool.query("SELECT 1 FROM pg_available_extensions WHERE name='postgis'")).rowCount
  ) {
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
      installed = 1;
    } catch (error) {
      if (process.env.POSTGIS_REQUIRED === 'true') throw error;
    }
  }
  if (!installed) {
    if (process.env.POSTGIS_REQUIRED === 'true')
      throw new Error(
        'POSTGIS_REQUIRED=true but PostGIS is unavailable. Install/enable PostGIS before deployment.',
      );
    return 'local_approximation';
  }
  await pool.query(`
    ALTER TABLE roads ADD COLUMN IF NOT EXISTS geom geometry(LineString,4326);
    ALTER TABLE segments ADD COLUMN IF NOT EXISTS geom geometry(LineString,4326);
    ALTER TABLE defects ADD COLUMN IF NOT EXISTS location geometry(Point,4326);
    CREATE OR REPLACE FUNCTION roadwatch_line_geometry() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.geom:=ST_SetSRID(ST_GeomFromGeoJSON(NEW.data->'geometry'),4326);RETURN NEW;END;$$;
    CREATE OR REPLACE FUNCTION roadwatch_defect_geometry() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.location:=ST_SetSRID(ST_MakePoint((NEW.data->>'longitude')::double precision,(NEW.data->>'latitude')::double precision),4326);RETURN NEW;END;$$;
    DROP TRIGGER IF EXISTS roads_geometry ON roads;
    CREATE TRIGGER roads_geometry BEFORE INSERT OR UPDATE OF data ON roads FOR EACH ROW EXECUTE FUNCTION roadwatch_line_geometry();
    DROP TRIGGER IF EXISTS segments_geometry ON segments;
    CREATE TRIGGER segments_geometry BEFORE INSERT OR UPDATE OF data ON segments FOR EACH ROW EXECUTE FUNCTION roadwatch_line_geometry();
    DROP TRIGGER IF EXISTS defects_geometry ON defects;
    CREATE TRIGGER defects_geometry BEFORE INSERT OR UPDATE OF data ON defects FOR EACH ROW EXECUTE FUNCTION roadwatch_defect_geometry();
    UPDATE roads SET data=data WHERE geom IS NULL;
    UPDATE segments SET data=data WHERE geom IS NULL;
    UPDATE defects SET data=data WHERE location IS NULL;
    CREATE INDEX IF NOT EXISTS roads_geometry_gist ON roads USING gist(geom);
    CREATE INDEX IF NOT EXISTS roads_geography_gist ON roads USING gist((geom::geography));
    CREATE INDEX IF NOT EXISTS segments_geometry_gist ON segments USING gist(geom);
    CREATE INDEX IF NOT EXISTS defects_location_gist ON defects USING gist(location);
  `);
  return 'postgis';
}
