"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CardSightResponse, CardSightResult } from "@/lib/cardsight";
import type { ApiResponse, CardResult } from "@/lib/tcgapi";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const MAX_EDGE = 1600; // px — plenty for recognition, keeps uploads well under Vercel's 4.5 MB body cap

type Panel<T> = { loading: boolean; result: T | null; error: string | null };
const IDLE: Panel<never> = { loading: false, result: null, error: null };
const LOADING: Panel<never> = { loading: true, result: null, error: null };

function cameraMessage(err: unknown) {
  switch (err instanceof DOMException ? err.name : "") {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera access was blocked. Allow camera permission for this site (usually the camera icon in the address bar), then try again.";
    case "NotFoundError":
      return "No camera was found on this device.";
    case "NotReadableError":
      return "Your camera is in use by another app. Close it and try again.";
    case "NotSupportedError":
      return "This browser can't access the camera. Open the site over HTTPS in a modern browser.";
    default:
      return "Couldn't start the camera.";
  }
}

/** POSTs the photo; always resolves to a JSON body (network and parse failures become `error`). */
async function send<T extends { error?: string }>(url: string, form: FormData): Promise<T> {
  try {
    const res = await fetch(url, { method: "POST", body: form });
    return await res.json().catch(() => ({ error: `Server error (${res.status}). Try again.` }) as T);
  } catch {
    return { error: "Network error. Check your connection and try again." } as T;
  }
}

function settle<T>(body: { result?: T; error?: string }): Panel<T> {
  return body.result
    ? { loading: false, result: body.result, error: null }
    : { loading: false, result: null, error: body.error ?? "Something went wrong. Try again." };
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [cameraAttempt, setCameraAttempt] = useState(0);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [tcg, setTcg] = useState<Panel<CardResult>>(IDLE);
  const [cs, setCs] = useState<Panel<CardSightResult>>(IDLE);
  const [scans, setScans] = useState<number | null>(null);
  const [calls, setCalls] = useState<number | null>(null);
  const scanning = tcg.loading || cs.loading;
  const hasOutput = !!(tcg.result || tcg.error || cs.result || cs.error);

  // Start the webcam (prefers the rear camera on phones).
  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | undefined;
    const request = navigator.mediaDevices?.getUserMedia
      ? navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        })
      : Promise.reject(new DOMException("Camera API unavailable", "NotSupportedError"));

    request
      .then((s) => {
        stream = s;
        if (cancelled) s.getTracks().forEach((t) => t.stop());
        else if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch((err) => {
        if (!cancelled) setCameraError(cameraMessage(err));
      });

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [cameraAttempt]);

  // Show both usage badges before the first scan (neither usage endpoint consumes a scan).
  useEffect(() => {
    fetch("/api/identify")
      .then((r) => r.json() as Promise<ApiResponse>)
      .then((b) => typeof b.scans_remaining === "number" && setScans(b.scans_remaining))
      .catch(() => {});
    fetch("/api/cardsight")
      .then((r) => r.json() as Promise<CardSightResponse>)
      .then((b) => typeof b.calls_this_month === "number" && setCalls(b.calls_this_month))
      .catch(() => {});
  }, []);

  // When results land below the camera (phones/tablets), bring them into view once per scan.
  useEffect(() => {
    if (hasOutput) resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [hasOutput]);

  async function capture() {
    const video = videoRef.current;
    if (!video?.videoWidth || scanning) return;

    const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) {
      const error = "Couldn't capture a frame from the camera. Try again.";
      setTcg({ ...IDLE, error });
      setCs({ ...IDLE, error });
      return;
    }

    setTcg(LOADING);
    setCs(LOADING);
    video.pause(); // freezes the captured frame under the scanning overlay

    const form = new FormData();
    form.append("image", blob, "card.jpg");
    // Same photo to both providers; each panel fills in as soon as its API answers.
    await Promise.all([
      send<ApiResponse>("/api/identify", form).then((b) => {
        if (typeof b.scans_remaining === "number") setScans(b.scans_remaining);
        setTcg(settle(b));
      }),
      send<CardSightResponse>("/api/cardsight", form).then((b) => {
        if (typeof b.calls_this_month === "number") setCalls(b.calls_this_month);
        setCs(settle(b));
      }),
    ]);
    video.play().catch(() => {});
  }

  function retryCamera() {
    setCameraError(null);
    setReady(false);
    setCameraAttempt((n) => n + 1);
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:py-10">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Card Scanner</h1>
          <p className="text-sm text-zinc-400">Compare TCGAPI and CardSight on the same photo</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <UsageBadge
            provider="TCGAPI"
            value={scans}
            unit="scans remaining"
            dot={scans === 0 ? "bg-red-500" : scans !== null && scans <= 10 ? "bg-amber-400" : "bg-emerald-400"}
          />
          <UsageBadge provider="CardSight" value={calls} unit="calls this month" dot="bg-sky-400" />
        </div>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)]">
        <section className="mx-auto flex w-full max-w-xl flex-col gap-4 lg:sticky lg:top-6 lg:max-w-none">
          {/* Portrait on phones and in the narrow desktop column so a card fills the frame;
              capped height keeps Capture above the fold. */}
          <div className="relative aspect-[3/4] max-h-[62svh] overflow-hidden rounded-2xl bg-zinc-900 ring-1 ring-white/10 sm:aspect-[4/3] lg:aspect-[3/4]">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              onCanPlay={() => setReady(true)}
              className="h-full w-full object-cover"
            />

            {!cameraError && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="aspect-[63/88] h-[82%] rounded-xl border-2 border-dashed border-white/50 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
              </div>
            )}

            {scanning && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/55">
                <div className="absolute inset-x-0 h-0.5 animate-scan bg-emerald-400 shadow-[0_0_18px_4px_rgba(52,211,153,0.6)] motion-reduce:hidden" />
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-emerald-400" />
                <p className="text-sm font-medium">Identifying card…</p>
              </div>
            )}

            {cameraError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
                <svg viewBox="0 0 24 24" className="h-10 w-10 text-zinc-500" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
                  <path d="M3 3l18 18M10.5 5H15l2 2h2a2 2 0 012 2v8.5M17 19H5a2 2 0 01-2-2V9a2 2 0 012-2h2" />
                </svg>
                <p role="alert" className="max-w-sm text-sm text-zinc-300">{cameraError}</p>
                <button
                  onClick={retryCamera}
                  className="rounded-lg bg-white/10 px-5 py-3 text-sm font-medium transition hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-emerald-400"
                >
                  Try again
                </button>
              </div>
            )}
          </div>

          <button
            onClick={capture}
            disabled={!ready || scanning || !!cameraError}
            className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-emerald-500 text-lg font-semibold text-zinc-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
              <path d="M4 8a2 2 0 012-2h1.5l1.5-2h6l1.5 2H18a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2V8z" />
              <circle cx="12" cy="12.5" r="3.5" />
            </svg>
            {scanning ? "Scanning…" : "Capture"}
          </button>
        </section>

        <div ref={resultsRef} className="grid items-start gap-6 md:grid-cols-2">
          <ProviderPanel name="TCGAPI" panel={tcg}>
            {(r) => <TcgCard result={r} />}
          </ProviderPanel>
          <ProviderPanel name="CardSight AI" panel={cs}>
            {(r) => <CardSightCard result={r} />}
          </ProviderPanel>
        </div>
      </div>
    </main>
  );
}

function UsageBadge({ provider, value, unit, dot }: { provider: string; value: number | null; unit: string; dot: string }) {
  return (
    <div className="flex items-center gap-2 rounded-full bg-white/5 px-4 py-2 text-sm ring-1 ring-white/10">
      <span className={`h-2 w-2 rounded-full ${value === null ? "bg-zinc-500" : dot}`} aria-hidden />
      <span className="text-zinc-400">{provider}</span>
      <span className="font-semibold tabular-nums">{value ?? "—"}</span>
      <span className="text-zinc-400">{unit}</span>
    </div>
  );
}

function ProviderPanel<T>({ name, panel, children }: { name: string; panel: Panel<T>; children: (result: T) => ReactNode }) {
  return (
    <section aria-live="polite" aria-busy={panel.loading} className="flex min-w-0 flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">{name}</h2>
      {panel.loading ? (
        <div className="flex items-center justify-center gap-3 rounded-2xl bg-zinc-900 p-10 text-sm text-zinc-400 ring-1 ring-white/10">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-emerald-400" />
          Identifying…
        </div>
      ) : panel.error ? (
        <div role="alert" className="rounded-2xl bg-red-500/10 p-6 ring-1 ring-red-500/30">
          <h3 className="font-semibold text-red-300">Scan failed</h3>
          <p className="mt-1 text-sm text-red-200/80">{panel.error}</p>
        </div>
      ) : panel.result ? (
        children(panel.result)
      ) : (
        <div className="rounded-2xl border border-dashed border-white/15 p-10 text-center text-sm text-zinc-400">
          Hold a card inside the frame and press Capture.
        </div>
      )}
    </section>
  );
}

function MatchBadge({ tone, children }: { tone: "good" | "ok" | "bad"; children: ReactNode }) {
  const color = {
    good: "bg-emerald-500/15 text-emerald-300",
    ok: "bg-amber-500/15 text-amber-300",
    bad: "bg-red-500/15 text-red-300",
  }[tone];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{children}</span>;
}

function CardName({ name }: { name: string }) {
  return (
    <>
      <p className="mt-2 text-xs uppercase tracking-wider text-zinc-500">Card Name</p>
      <h3 className="text-2xl font-semibold leading-tight break-words">{name}</h3>
    </>
  );
}

const Price = ({ value }: { value: number | null | undefined }) => (
  <span className="text-lg font-semibold text-emerald-300">{value != null ? usd.format(value) : "—"}</span>
);

function TcgCard({ result: { match, card, market_data } }: { result: CardResult }) {
  return (
    <article className="overflow-hidden rounded-2xl bg-zinc-900 ring-1 ring-white/10">
      <header className="flex gap-4 border-b border-white/10 p-5">
        {card.image_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.image_url} alt={card.name} className="h-28 w-20 shrink-0 rounded-md object-cover ring-1 ring-white/10" />
        )}
        <div className="min-w-0">
          <MatchBadge tone={match === "matched" ? "good" : "ok"}>{match === "matched" ? "Exact match" : "Best guess"}</MatchBadge>
          <CardName name={card.name} />
        </div>
      </header>

      <Section title="Card Details">
        <Row label="Set Name">{card.set_name ?? "—"}</Row>
        <Row label="Set Code">{card.set_code ?? "—"}</Row>
        <Row label="Collector Number">{card.number ?? "—"}</Row>
        <Row label="Rarity">{card.rarity ?? "—"}</Row>
        <Row label="Foil">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              card.is_foil ? "bg-gradient-to-r from-fuchsia-500/25 to-sky-500/25 text-sky-200" : "bg-white/10 text-zinc-300"
            }`}
          >
            {card.is_foil ? "True" : "False"}
          </span>
          {card.printing && <span className="ml-2 text-zinc-500">{card.printing}</span>}
        </Row>
      </Section>

      <Section title="TCGplayer">
        <Row label="Market Price">
          <Price value={market_data?.market_price} />
        </Row>
        <Row label="TCGplayer ID">
          {card.tcgplayer_id ? (
            <a
              href={`https://www.tcgplayer.com/product/${card.tcgplayer_id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-300 underline-offset-2 hover:underline"
            >
              {card.tcgplayer_id}
            </a>
          ) : (
            "—"
          )}
        </Row>
        {market_data?.updated_at && (
          <Row label="Price Updated">
            <span className="text-zinc-400">{new Date(market_data.updated_at).toLocaleDateString()}</span>
          </Row>
        )}
      </Section>
    </article>
  );
}

function CardSightCard({ result: { confidence, card, grading, pricing } }: { result: CardSightResult }) {
  return (
    <article className="overflow-hidden rounded-2xl bg-zinc-900 ring-1 ring-white/10">
      <header className="border-b border-white/10 p-5">
        <MatchBadge tone={confidence === "High" ? "good" : confidence === "Medium" ? "ok" : "bad"}>
          {confidence} confidence
        </MatchBadge>
        <CardName name={card.name} />
      </header>

      <Section title="Card Details">
        <Row label="Year">{card.year ?? "—"}</Row>
        <Row label="Manufacturer">{card.manufacturer ?? "—"}</Row>
        <Row label="Release">{card.release ?? "—"}</Row>
        <Row label="Set">{card.set ?? "—"}</Row>
        <Row label="Card Number">{card.number ?? "—"}</Row>
        <Row label="Parallel">{card.parallel ?? "Base"}</Row>
        {card.numbered_to ? <Row label="Serial Numbered">/{card.numbered_to}</Row> : null}
      </Section>

      {grading && (
        <Section title="Graded Slab">
          <Row label="Company">{grading.company}</Row>
          <Row label="Grade">{grading.grade ?? "—"}</Row>
          <Row label="Cert Number">{grading.cert ?? "—"}</Row>
        </Section>
      )}

      <Section title="eBay Sold · Raw · Last 90 Days">
        <Row label="Median Price">
          <Price value={pricing?.median} />
        </Row>
        <Row label="Sales">{pricing ? pricing.sales : "—"}</Row>
        {pricing?.last_sale && (
          <Row label="Last Sale">
            <span className="text-zinc-400">{new Date(pricing.last_sale).toLocaleDateString()}</span>
          </Row>
        )}
      </Section>
    </article>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b border-white/10 px-5 py-4 last:border-0">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">{title}</h4>
      <dl className="divide-y divide-white/5">{children}</dl>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <dt className="shrink-0 text-zinc-400">{label}</dt>
      <dd className="min-w-0 text-right font-medium break-words">{children}</dd>
    </div>
  );
}
