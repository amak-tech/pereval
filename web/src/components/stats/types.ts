/** Формы JSON, которые отдаёт GET /api/stats (см. src/stats_collector.py, healthcheck.py, pro_dns.py). */

export type StatsLive = {
  active_connections: number;
  online_users_5m: number;
  unique_users_1h: number;
  unique_users_24h: number;
  requests_current_min: number;
  peak_requests_1m: number;
  requests_1h: number;
  peak_requests_1h: number;
  requests_24h: number;
  bytes_1h: number;
  bytes_24h: number;
  bytes_sent_24h: number;
  bytes_recv_24h: number;
};

export type SeriesPoint = { ts: number; requests: number; unique_users: number; bytes: number };

export type TopService = { service: string; category: string; requests: number; unique_users: number; bytes: number };

export type FreeStats = {
  generated_at: number;
  window_seconds: number;
  live: Partial<StatsLive>;
  per_minute?: SeriesPoint[];
  per_hour?: SeriesPoint[];
  top_services_24h?: TopService[];
  top_services_1h?: TopService[];
};

export type WorkerHealth = {
  ip: string;
  name: string;
  weight?: number;
  pools?: string[];
  status?: "up" | "down";
  healthy?: boolean;
  tls_443_ok?: boolean;
  http_80_ok?: boolean;
  latency_ms?: number | null;
  consecutive_failures?: number;
  last_transition_ts?: number;
  last_error?: string | null;
};

export type ClusterHealth = {
  updated_at: number;
  primary?: string;
  domain?: string;
  mode?: string;
  fail_open_active?: boolean;
  active_dns_ips?: string[];
  active_worker_ips?: string[];
  pools?: Record<string, string[]>;
  workers?: WorkerHealth[];
};

export type ProHealth = {
  updated_at: number;
  domain?: string;
  policy_version?: number;
  qps?: number;
  fail_open?: boolean;
  pools?: Record<string, string[]>;
  workers?: WorkerHealth[];
};

export type StatsResponse = {
  ok: boolean;
  fetchedAt: string;
  stats: FreeStats | null;
  cluster: ClusterHealth | null;
  pro: ProHealth | null;
};
