// Real TCGAPI response shape (https://tcgapi.dev/api/identify/) — only the fields we use.
export type Candidate = {
  tcgplayer_id: number | null;
  name: string;
  number: string | null;
  rarity: string | null;
  set: { name: string; code: string | null } | null;
  image_url: string | null;
  suggested_printing: string | null;
  prices?: {
    printing: string;
    market_price: number | null;
    low_price: number | null;
    last_updated_at: string | null;
  }[];
};

export type IdentifyUpstream = {
  data: {
    status: "matched" | "ambiguous" | "retake" | "not_found" | "unsupported";
    message: string | null;
    candidates: Candidate[];
  };
  meta?: { scans_remaining?: number };
};

// What /api/identify returns to the browser.
export type CardResult = {
  match: "matched" | "ambiguous";
  card: {
    tcgplayer_id: number | null;
    name: string;
    set_name: string | null;
    set_code: string | null;
    number: string | null;
    rarity: string | null;
    is_foil: boolean;
    printing: string | null;
    image_url: string | null;
  };
  market_data: {
    market_price: number | null;
    low_price: number | null;
    updated_at: string | null;
  } | null;
};

export type ApiResponse = {
  result?: CardResult;
  error?: string;
  scans_remaining?: number | null;
  raw?: Record<string, unknown>; // complete TCGAPI payload, shown untruncated in the UI
};

const NOT_RECOGNIZED: Record<string, string> = {
  retake: "The photo wasn't usable. Check for glare or blur and try again.",
  not_found: "Card not recognized. Fill the frame with the card and try again.",
  unsupported: "This game or language isn't supported yet.",
};

/** Maps TCGAPI's identify payload to our card shape, or returns a user-facing error string. */
export function toResult(data: IdentifyUpstream["data"]): CardResult | string {
  const c = data.candidates?.[0];
  if (!c || (data.status !== "matched" && data.status !== "ambiguous")) {
    return data.message || NOT_RECOGNIZED[data.status] || NOT_RECOGNIZED.not_found;
  }
  const printing = c.suggested_printing ?? c.prices?.[0]?.printing ?? null;
  const price = c.prices?.find((p) => p.printing === printing) ?? c.prices?.[0];
  return {
    match: data.status,
    card: {
      tcgplayer_id: c.tcgplayer_id,
      name: c.name,
      set_name: c.set?.name ?? null,
      set_code: c.set?.code ?? null,
      number: c.number,
      rarity: c.rarity,
      // ponytail: TCGAPI has no foil boolean; inferred from printing name ("Holofoil", "Foil", "Reverse Holofoil").
      is_foil: /foil/i.test(printing ?? ""),
      printing,
      image_url: c.image_url,
    },
    market_data: price
      ? { market_price: price.market_price, low_price: price.low_price, updated_at: price.last_updated_at }
      : null,
  };
}
