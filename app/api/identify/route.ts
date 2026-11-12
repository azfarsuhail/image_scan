import { connection } from "next/server";
import { toResult, type IdentifyUpstream } from "@/lib/tcgapi";
import { missingKey, readImage } from "@/lib/upload";

const API = "https://api.tcgapi.dev/v1/identify";

const UPSTREAM_ERRORS: Record<number, string> = {
  400: "TCGAPI couldn't read that image. Try a clearer photo.",
  401: "The server's TCGAPI key is invalid.",
  402: "You're out of scans. Buy more in the TCGAPI dashboard.",
  403: "Card identification isn't available in this region.",
  429: "Rate limit reached. Wait a moment and try again.",
  503: "The identification service is temporarily unavailable. Try again shortly.",
};

async function getUsage(key: string): Promise<number | null> {
  try {
    const res = await fetch(`${API}/usage`, {
      headers: { "X-API-Key": key },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.data?.balance === "number" ? body.data.balance : null;
  } catch {
    return null;
  }
}

// Free call (doesn't consume scans): lets the badge show a balance before the first scan.
export async function GET() {
  await connection(); // always run at request time, never prerendered at build
  const key = process.env.TCGAPI_KEY;
  if (!key) return missingKey("TCGAPI_KEY");
  return Response.json({ scans_remaining: await getUsage(key) });
}

export async function POST(req: Request) {
  const key = process.env.TCGAPI_KEY;
  if (!key) return missingKey("TCGAPI_KEY");

  const image = await readImage(req);
  if (image instanceof Response) return image;

  const form = new FormData();
  form.append("image", image, image.name || "card.jpg");

  let res: Response;
  try {
    res = await fetch(`${API}?include=prices`, {
      method: "POST",
      headers: { "X-API-Key": key },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return Response.json({ error: "Couldn't reach TCGAPI. Try again." }, { status: 504 });
  }

  if (!res.ok) {
    const known = res.status in UPSTREAM_ERRORS;
    return Response.json(
      {
        error: known ? UPSTREAM_ERRORS[res.status] : `TCGAPI error (${res.status}).`,
        scans_remaining: res.status === 402 ? 0 : undefined,
      },
      { status: known ? res.status : 502 },
    );
  }

  const body = (await res.json().catch(() => null)) as IdentifyUpstream | null;
  if (!body?.data) return Response.json({ error: "Unexpected response from TCGAPI." }, { status: 502 });

  // The scan is charged on any 200, so refresh the balance whether or not the card was recognized.
  const scans_remaining = (await getUsage(key)) ?? body.meta?.scans_remaining ?? null;
  const result = toResult(body.data);

  return typeof result === "string"
    ? Response.json({ error: result, scans_remaining }, { status: 422 })
    : Response.json({ result, scans_remaining });
}
