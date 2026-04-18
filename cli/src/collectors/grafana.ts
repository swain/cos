import { createHash } from "node:crypto";
import type { CollectedSignal } from "./github.js";

const DEFAULT_GRAFANA_URL = "https://goodparty.grafana.net";

type GrafanaAlert = {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  state?: string;
  activeAt?: string;
  value?: string;
};

type GrafanaAlertsResponse = {
  status?: string;
  data?: { alerts?: GrafanaAlert[] };
};

// Stable fingerprint over an alert's labels so the same firing incident
// produces the same external_id across ticks. We include activeAt so a
// resolve → re-fire is treated as a new signal rather than a duplicate.
const fingerprint = (labels: Record<string, string>): string => {
  const sorted = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join("\u0000");
  return createHash("sha1").update(sorted).digest("hex").slice(0, 16);
};

const fetchJson = async <T>(url: string, token: string): Promise<T> => {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`${url} -> ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
};

export const collectGrafanaSignals = async (): Promise<CollectedSignal[]> => {
  const token = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN;
  if (!token) {
    console.error(
      "[grafana] GRAFANA_SERVICE_ACCOUNT_TOKEN not set; skipping collection",
    );
    return [];
  }
  const base = (process.env.GRAFANA_URL || DEFAULT_GRAFANA_URL).replace(
    /\/$/,
    "",
  );

  const out: CollectedSignal[] = [];

  // Firing alerts via the Grafana-managed Prometheus-compatible alerts API.
  // Returns all configured alerts with their current evaluation state; we
  // filter to `Alerting`. `Pending` is deliberately excluded — it flips to
  // `Alerting` on the next eval and we don't want flappy signals.
  let payload: GrafanaAlertsResponse;
  try {
    payload = await fetchJson<GrafanaAlertsResponse>(
      `${base}/api/prometheus/grafana/api/v1/alerts`,
      token,
    );
  } catch (e: any) {
    console.error(`[grafana] alerts fetch failed: ${e.message}`);
    return out;
  }

  const alerts = payload.data?.alerts ?? [];
  for (const a of alerts) {
    if (a.state !== "Alerting") continue;
    const labels = a.labels ?? {};
    const annotations = a.annotations ?? {};
    const fp = fingerprint(labels);
    const activeAt = a.activeAt ?? "";
    out.push({
      source: "grafana",
      kind: "grafana-alert",
      external_id: `grafana-alert:${fp}:${activeAt}`,
      payload: {
        alertname: labels.alertname ?? annotations.summary ?? "(unnamed)",
        labels,
        summary: annotations.summary,
        description: annotations.description,
        state: a.state,
        active_at: activeAt,
        value: a.value,
        fingerprint: fp,
        grafana_url: `${base}/alerting/list`,
      },
    });
  }

  return out;
};
