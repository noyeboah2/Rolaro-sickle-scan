-- SickleScan D1 schema. The Worker also creates this automatically on first use,
-- so running it by hand (npm run db:migrate) is optional.
CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  total_cells INTEGER NOT NULL,
  normal_count INTEGER NOT NULL,
  borderline_count INTEGER NOT NULL,
  sickled_count INTEGER NOT NULL,
  clump_count INTEGER NOT NULL,
  percent_sickled REAL NOT NULL,
  thresholds TEXT NOT NULL DEFAULT '{}',
  image_width INTEGER,
  image_height INTEGER,
  engine TEXT NOT NULL DEFAULT 'rules-v1'
);
CREATE INDEX IF NOT EXISTS idx_analyses_created ON analyses (created_at DESC);
