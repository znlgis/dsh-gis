-- T3.2 fixture (plan row F7): the shapes the catalogue must handle.
--
-- Recreated by scripts/t3-postgis-live-check.mjs on every run, so it is written to
-- be idempotent and to leave the statistics in KNOWN states:
--
--   cities      -- geometry(Point,4326) with a primary key, ANALYZEd (stats exist)
--   roads       -- geometry(LineString,4326), ANALYZEd
--   parcels_nopk-- NO PRIMARY KEY: the plan calls this out, and a viewer that
--                  assumes one cannot browse it
--   areas_geog  -- a GEOGRAPHY column, which lives in geography_columns, NOT in
--                  geometry_columns -- a catalogue that reads only the latter
--                  silently omits these layers
--   fresh       -- created and deliberately NOT analyzed: reltuples = -1 and no
--                  statistics, which is exactly the graceful-degradation case
DROP SCHEMA IF EXISTS dsh_gis_fixture CASCADE;
CREATE SCHEMA dsh_gis_fixture;

CREATE TABLE dsh_gis_fixture.cities (
  id serial PRIMARY KEY,
  name text NOT NULL,
  population integer,
  geom geometry(Point, 4326)
);
INSERT INTO dsh_gis_fixture.cities (name, population, geom)
SELECT 'city-' || g, 1000 * g, ST_SetSRID(ST_MakePoint(100 + g * 0.1, 30 + g * 0.05), 4326)
FROM generate_series(1, 40) AS g;
CREATE INDEX cities_geom_idx ON dsh_gis_fixture.cities USING GIST (geom);
ANALYZE dsh_gis_fixture.cities;

CREATE TABLE dsh_gis_fixture.roads (
  id serial PRIMARY KEY,
  name text,
  geom geometry(LineString, 4326)
);
INSERT INTO dsh_gis_fixture.roads (name, geom)
SELECT 'road-' || g, ST_SetSRID(ST_MakeLine(ST_MakePoint(100 + g * 0.1, 30), ST_MakePoint(100 + g * 0.1, 31)), 4326)
FROM generate_series(1, 25) AS g;
CREATE INDEX roads_geom_idx ON dsh_gis_fixture.roads USING GIST (geom);
ANALYZE dsh_gis_fixture.roads;

-- No primary key, and no geometry TYPE constraint (generic geometry column).
CREATE TABLE dsh_gis_fixture.parcels_nopk (
  label text,
  geom geometry
);
INSERT INTO dsh_gis_fixture.parcels_nopk (label, geom)
SELECT 'parcel-' || g, ST_SetSRID(ST_MakePoint(101 + g * 0.01, 31 + g * 0.01), 4326)
FROM generate_series(1, 12) AS g;
ANALYZE dsh_gis_fixture.parcels_nopk;

-- Geography: present in geography_columns only.
CREATE TABLE dsh_gis_fixture.areas_geog (
  id serial PRIMARY KEY,
  name text,
  geog geography(Polygon, 4326)
);
INSERT INTO dsh_gis_fixture.areas_geog (name, geog)
SELECT 'area-' || g, ST_SetSRID(ST_MakeEnvelope(100 + g * 0.1, 30, 100.05 + g * 0.1, 30.05), 4326)::geography
FROM generate_series(1, 8) AS g;
ANALYZE dsh_gis_fixture.areas_geog;

-- PURPOSE: stats-free. Do NOT ANALYZE this one.
CREATE TABLE dsh_gis_fixture.fresh (
  id serial PRIMARY KEY,
  geom geometry(Point, 4326)
);
INSERT INTO dsh_gis_fixture.fresh (geom)
SELECT ST_SetSRID(ST_MakePoint(100 + g * 0.01, 30 + g * 0.01), 4326)
FROM generate_series(1, 5) AS g;
