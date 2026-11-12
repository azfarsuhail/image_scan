import { connection } from "next/server";
import {
  CARDSIGHT_MONTHLY_LIMIT,
  summarizePricing,
  toCardSight,
  type CsIdentify,
  type CsPricing,
} from "@/lib/cardsight";
import { missingKey, readImage } from "@/lib/upload";

const API = "https://api.cardsight.ai/v1";

const UPSTREAM_ERRORS: Record<number, string> = {
  400: "CardSight couldn't read that image. Try a clearer photo.",
  401: "The server's CardSight key is invalid.",
  403: "This CardSight key isn't allowed to identify cards.",
  404: "Card not recognized. Fill the frame with the card and try again.",
  408: "CardSight timed out. Try again.",
  429: "CardSight rate limit reached. Wait a moment and try again.",
  503: "CardSight is temporarily unavailable. Try again shortly.",
};

async function getJson<T>(path: string, key: string): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { "X-API-Key": key },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

// CardSight reports calls used this month; remaining = plan cap minus that.
async function usage(key: string) {
  const body = await getJson<{ calls?: number }>("/subscription/", key);
  const used = typeof body?.calls === "number" ? body.calls : null;
  return {
    calls_this_month: used,
    calls_remaining: used === null ? null : Math.max(0, CARDSIGHT_MONTHLY_LIMIT - used),
  };
}

export async function GET() {
  await connection(); // always run at request time, never prerendered at build
  const key = process.env.CARDSIGHT_API_KEY;
  if (!key) return missingKey("CARDSIGHT_API_KEY");
  return Response.json(await usage(key));
}

export async function POST(req: Request) {
  const key = process.env.CARDSIGHT_API_KEY;
  if (!key) return missingKey("CARDSIGHT_API_KEY");

  const image = await readImage(req);
  if (image instanceof Response) return image;

  const form = new FormData();
  form.append("image", image, image.name || "card.jpg");

  let res: Response;
  try {
    res = await fetch(`${API}/identify/card`, {
      method: "POST",
      headers: { "X-API-Key": key },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return Response.json({ error: "Couldn't reach CardSight. Try again." }, { status: 504 });
  }

  if (!res.ok) {
    const u = await usage(key);
    if (u.calls_remaining === 0) {
      return Response.json(
        {
          error: `CardSight monthly limit reached (${CARDSIGHT_MONTHLY_LIMIT} calls). Upgrade the CardSight plan for more calls.`,
          ...u,
        },
        { status: 429 },
      );
    }
    const known = res.status in UPSTREAM_ERRORS;
    return Response.json(
      { error: known ? UPSTREAM_ERRORS[res.status] : `CardSight error (${res.status}).`, ...u },
      { status: known ? res.status : 502 },
    );
  }

  const body = (await res.json().catch(() => null)) as CsIdentify | null;
  if (!body) return Response.json({ error: "Unexpected response from CardSight." }, { status: 502 });

  const result = toCardSight(body);
  if (typeof result === "string") {
    return Response.json(
      { error: result, ...(await usage(key)), raw: body },
      { status: 422 },
    );
  }

  // Ungraded completed auctions from the last 90 days, for the suggested parallel (or the base card).
  const pricing = result.card.id
    ? await getJson<CsPricing>(
        `/pricing/${encodeURIComponent(result.card.id)}?period=90d&listing_type=auction&grade_id=null` +
          `&parallel_id=${encodeURIComponent(result.card.parallel_id ?? "null")}`,
        key,
      )
    : null;

  return Response.json({
    result: { ...result, pricing: pricing && summarizePricing(pricing) },
    ...(await usage(key)),
    raw: { ...body, pricing }, // full payloads for the "full response" panel
  });
}
