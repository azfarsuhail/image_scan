type Tier = "High" | "Medium" | "Low";

// Current CardSight plan: usage is hard-capped at 750 calls/month. Change this if the plan changes.
export const CARDSIGHT_MONTHLY_LIMIT = 750;

// Real CardSight shapes (https://api.cardsight.ai/documentation/json) — only the fields we use.
export type CsIdentify = {
  success: boolean;
  detections?: {
    confidence: Tier;
    card?: {
      id?: string;
      year?: string;
      manufacturer?: string;
      releaseName?: string;
      setName?: string;
      name?: string;
      number?: string;
      numberedTo?: number;
      parallelSuggestions?: { id: string; name: string; confidence?: Tier }[];
    };
    grading?: {
      company: { name: string };
      grade?: { value?: string; condition?: string };
      certNumber?: string;
    };
  }[];
  messages?: { type: string; message: string }[];
};

export type CsPricing = { raw?: { records?: { price: number; date?: string | null }[] } };

// What /api/cardsight returns to the browser.
export type CardSightResult = {
  confidence: Tier;
  card: {
    id: string | null;
    name: string;
    year: string | null;
    manufacturer: string | null;
    release: string | null;
    set: string | null;
    number: string | null;
    parallel: string | null;
    parallel_id: string | null;
    numbered_to: number | null;
  };
  grading: { company: string; grade: string | null; cert: string | null } | null;
  pricing: { median: number | null; sales: number; last_sale: string | null } | null;
};

export type CardSightResponse = {
  result?: CardSightResult;
  error?: string;
  calls_this_month?: number | null;
  calls_remaining?: number | null;
  raw?: Record<string, unknown>; // complete identify (+ pricing) payload, shown untruncated in the UI
};

/** Maps the first identified card in CardSight's payload, or returns a user-facing error string. */
export function toCardSight(body: CsIdentify): CardSightResult | string {
  const d = body.detections?.find((x) => x.card?.name);
  const c = d?.card;
  if (!d || !c?.name) {
    return (
      body.messages?.find((m) => m.type === "warning")?.message ??
      "Card not recognized. Fill the frame with the card and try again."
    );
  }
  const parallel = c.parallelSuggestions?.[0];
  const g = d.grading;
  return {
    confidence: d.confidence,
    card: {
      id: c.id ?? null,
      name: c.name,
      year: c.year ?? null,
      manufacturer: c.manufacturer ?? null,
      release: c.releaseName ?? null,
      set: c.setName ?? null,
      number: c.number ?? null,
      parallel: parallel?.name ?? null,
      parallel_id: parallel?.id ?? null,
      numbered_to: c.numberedTo ?? null,
    },
    grading: g
      ? {
          company: g.company.name,
          grade: [g.grade?.value, g.grade?.condition].filter(Boolean).join(" ") || null,
          cert: g.certNumber ?? null,
        }
      : null,
    pricing: null,
  };
}

/** Median of completed sales, so one outlier auction doesn't skew the price. */
export function summarizePricing(body: CsPricing): NonNullable<CardSightResult["pricing"]> {
  const records = (body.raw?.records ?? []).filter((r) => typeof r.price === "number");
  if (!records.length) return { median: null, sales: 0, last_sale: null };
  const prices = records.map((r) => r.price).sort((a, b) => a - b);
  const mid = prices.length >> 1;
  const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
  const last_sale =
    records
      .map((r) => r.date)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1) ?? null;
  return { median: Math.round(median * 100) / 100, sales: records.length, last_sale };
}
