// components/zones/market-record.ts — TypeScript shapes for the /api/market record
// the detail view consumes. The record is produced by the verified core/ pipeline
// (untyped .mjs), so these interfaces type the boundary the detail reads — all fields
// optional where the detail must degrade gracefully on a thin record (no `any`).

export interface LadderRow {
  label: string;
  threshold: number;
  prob: number;
  adjusted_prob: number;
  bucket_prob: number;
  raw_prob?: number;
  volume?: number;
  volume_tier?: string;
}

export interface Confidence {
  tier?: 'high' | 'medium' | 'low';
  score?: number;
  reasons?: string[];
}

export interface Range {
  central?: number;
  low?: number;
  high?: number;
  tail_insensitive?: boolean;
}

export interface Analytics {
  shape?: { skew_bowley?: number; entropy?: number; fat_tail?: number; dominant_bucket?: { label?: string } };
  dispersion?: { trend?: string; iqr_width?: number };
  velocity?: { acceleration?: string; drift_30d_annualized?: number };
  descriptor?: string;
}

export interface Derived {
  implied_median?: number;
  implied_mean?: number;
  median?: Range;
  mean?: Range;
  iqr?: { p25?: number; p75?: number };
  total_volume?: number;
  confidence?: Confidence;
  markets?: LadderRow[];
  market?: { analytics?: Analytics };
  freshness?: { as_of?: string; stale_after?: string; final?: boolean };
  narrative?: string;
}

export interface ResolvedLeg {
  threshold: number;
  outcome: string;
}

export interface Snapshot {
  fetched_at?: string;
  source?: { raw_sha256?: string };
  raw_inputs?: unknown[];
  derived?: Derived;
  lifecycle?: { state?: string; resolved_outcome?: ResolvedLeg[] };
}

export interface MarketRecord {
  schema_version?: string;
  methodology_version?: string;
  asset?: { id?: string; name?: string; platform?: string; market_url?: string; resolves?: string };
  snapshot?: Snapshot;
}

export interface ServeBody {
  market_id?: string;
  cached?: boolean;
  age_seconds?: number;
  lifecycle_state?: string;
  record?: MarketRecord;
  error?: string;
}
