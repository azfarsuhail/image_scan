"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CardSightResponse, CardSightResult } from "@/lib/cardsight";
import type { ApiResponse, CardResult } from "@/lib/tcgapi";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const MAX_EDGE = 1600; // px — plenty for recognition, keeps uploads well under Vercel's 4.5 MB body cap

type Raw = Record<string, unknown>;
type Panel<T> = { loading: boolean; result: T | null; error: string | null; raw: Raw | null; ms: number | null };
const IDLE: Panel<never> = { loading: false, result: null, error: null, raw: null, ms: null };
const LOADING: Panel<never> = { ...IDLE, loading: true };

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

/** POSTs the photo and times the round trip; always resolves (network/parse failures become `error`). */
async function send<T extends { error?: string }>(url: string, form: FormData): Promise<{ body: T; ms: number }> {
  const t0 = performance.now();
  let body: T;
  try {
    const res = await fetch(url, { method: "POST", body: form });
    body = await res.json().catch(() => ({ error: `Server error (${res.status}). Try again.` }) as T);
  } catch {
    body = { error: "Network error. Check your connection and try again." } as T;
  }
  return { body, ms: performance.now() - t0 };
}

function settle<T>({ body, ms }: { body: { result?: T; error?: string; raw?: Raw }; ms: number }): Panel<T> {
  return {
    loading: false,
    result: body.result ?? null,
    error: body.result ? null : (body.error ?? "Something went wrong. Try again."),
    raw: body.raw ?? null,
    ms,
  };
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

  // Below the desktop breakpoint the results sit under the camera; bring them into view once per scan.
  useEffect(() => {
    if (hasOutput && window.matchMedia("(max-width: 1023px)").matches) {
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
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
    // Same photo to both providers; each column fills in as soon as its API answers.
    await Promise.all([
      send<ApiResponse>("/api/identify", form).then((r) => {
        if (typeof r.body.scans_remaining === "number") setScans(r.body.scans_remaining);
        setTcg(settle(r));
      }),
      send<CardSightResponse>("/api/cardsight", form).then((r) => {
        if (typeof r.body.calls_this_month === "number") setCalls(r.body.calls_this_month);
        setCs(settle(r));
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

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
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
                <Spinner className="h-10 w-10 border-4" />
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

        <div ref={resultsRef} className="flex min-w-0 scroll-mt-4 flex-col gap-6">
          {scanning || hasOutput ? (
            <>
              <Comparison tcg={tcg} cs={cs} scans={scans} calls={calls} />
              <div className="grid items-start gap-6 md:grid-cols-2">
                <FullResponse title="TCGAPI" panel={tcg} />
                <FullResponse title="CardSight AI" panel={cs} />
              </div>
            </>
          ) : (
            <div className="rounded-2xl border border-dashed border-white/15 p-10 text-center text-sm text-zinc-400">
              <p className="font-medium text-zinc-300">No card scanned yet</p>
              <p className="mt-1">Hold a card inside the frame and press Capture. Both APIs are compared here.</p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

/* ---------- comparison table ---------- */

const date = (iso: string) => new Date(iso).toLocaleDateString();
const seconds = (ms: number | null) => (ms == null ? null : `${(ms / 1000).toFixed(1)} s`);

function Comparison({
  tcg,
  cs,
  scans,
  calls,
}: {
  tcg: Panel<CardResult>;
  cs: Panel<CardSightResult>;
  scans: number | null;
  calls: number | null;
}) {
  const t = tcg.result;
  const c = cs.result;
  const rows: [string, ReactNode, ReactNode][] = [
    ["Card Name", t?.card.name, c?.card.name],
    ["Set", t?.card.set_name, c && [c.card.release, c.card.set].filter(Boolean).join(" › ")],
    ["Set Code", t?.card.set_code, null],
    ["Card Number", t?.card.number, c?.card.number],
    ["Year", null, c?.card.year],
    ["Manufacturer", null, c?.card.manufacturer],
    ["Rarity", t?.card.rarity, null],
    ["Variant", t?.card.printing, c && (c.card.parallel ?? "Base")],
    ["Foil", t && <FoilPill on={t.card.is_foil} />, null],
    ["Serial Numbered", null, c?.card.numbered_to ? `/${c.card.numbered_to}` : null],
    [
      "Graded Slab",
      null,
      c?.grading && [c.grading.company, c.grading.grade, c.grading.cert && `Cert ${c.grading.cert}`].filter(Boolean).join(" · "),
    ],
    [
      "Price",
      t && <Price value={t.market_data?.market_price} note="TCGplayer market price" />,
      c && <Price value={c.pricing?.median} note={`Median of ${c.pricing?.sales ?? 0} eBay sales (raw, 90 days)`} />,
    ],
    ["Low Price", t?.market_data?.low_price != null ? usd.format(t.market_data.low_price) : null, null],
    [
      "Price Date",
      t?.market_data?.updated_at && `Updated ${date(t.market_data.updated_at)}`,
      c?.pricing?.last_sale && `Last sale ${date(c.pricing.last_sale)}`,
    ],
    [
      "ID",
      t?.card.tcgplayer_id && (
        <a
          href={`https://www.tcgplayer.com/product/${t.card.tcgplayer_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sky-300 underline-offset-2 hover:underline"
        >
          TCGplayer {t.card.tcgplayer_id}
        </a>
      ),
      c?.card.id,
    ],
    ["Response Time", seconds(tcg.ms), seconds(cs.ms)],
    ["Usage After Scan", scans != null && `${scans} scans remaining`, calls != null && `${calls} calls this month`],
  ];

  return (
    <div role="table" aria-label="TCGAPI and CardSight results compared" className="rounded-2xl bg-zinc-900 ring-1 ring-white/10">
      {/* Sticky so the column names stay visible while scrolling the table on a phone. */}
      <div role="row" className={`${GRID} sticky top-0 z-10 rounded-t-2xl border-b border-white/10 bg-zinc-900/95 py-3 backdrop-blur`}>
        <div role="columnheader" className="hidden text-xs font-semibold uppercase tracking-wider text-zinc-500 sm:block">
          Field
        </div>
        <div role="columnheader" className="text-sm font-semibold">TCGAPI</div>
        <div role="columnheader" className="text-sm font-semibold">CardSight AI</div>
      </div>

      <CompareRow
        label="Result"
        a={<Status panel={tcg}>{t && <MatchBadge tone={t.match === "matched" ? "good" : "ok"}>{t.match === "matched" ? "Exact match" : "Best guess"}</MatchBadge>}</Status>}
        b={<Status panel={cs}>{c && <MatchBadge tone={c.confidence === "High" ? "good" : c.confidence === "Medium" ? "ok" : "bad"}>{c.confidence} confidence</MatchBadge>}</Status>}
      />
      {t?.card.image_url && (
        <CompareRow
          label="Image"
          // eslint-disable-next-line @next/next/no-img-element
          a={<img src={t.card.image_url} alt={t.card.name} className="h-32 w-auto rounded-md ring-1 ring-white/10" />}
          b={<Empty note="CardSight returns no image URL" />}
        />
      )}
      {rows.map(([label, a, b]) => (
        <CompareRow key={label} label={label} a={cell(tcg, a)} b={cell(cs, b)} />
      ))}
    </div>
  );
}

// Mobile: field name spans the row, the two values sit side by side under it. sm+: classic 3-column table.
const GRID = "grid grid-cols-2 gap-x-4 gap-y-1 px-4 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)] sm:px-5";

function CompareRow({ label, a, b }: { label: string; a: ReactNode; b: ReactNode }) {
  return (
    <div role="row" className={`${GRID} border-b border-white/5 py-3 last:rounded-b-2xl last:border-0`}>
      <div
        role="rowheader"
        className="col-span-2 text-xs font-medium uppercase tracking-wider text-zinc-500 sm:col-span-1 sm:text-sm sm:normal-case sm:tracking-normal sm:text-zinc-400"
      >
        {label}
      </div>
      <div role="cell" className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{a}</div>
      <div role="cell" className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{b}</div>
    </div>
  );
}

function cell(panel: Panel<unknown>, value: ReactNode) {
  if (panel.loading) return <span className="block h-4 w-2/3 animate-pulse rounded bg-white/10" aria-label="Loading" />;
  return value === null || value === undefined || value === "" || value === false ? <Empty /> : value;
}

function Status({ panel, children }: { panel: Panel<unknown>; children: ReactNode }) {
  if (panel.loading) {
    return (
      <span className="inline-flex items-center gap-2 text-zinc-400">
        <Spinner className="h-4 w-4 border-2" /> Identifying…
      </span>
    );
  }
  if (panel.error) return <span role="alert" className="text-red-300">{panel.error}</span>;
  return children;
}

const Empty = ({ note }: { note?: string }) => (
  <span className="text-zinc-600">
    —{note && <span className="ml-1 text-xs font-normal">{note}</span>}
  </span>
);

const Price = ({ value, note }: { value: number | null | undefined; note: string }) => (
  <span className="flex flex-col">
    <span className="text-lg font-semibold text-emerald-300">{value != null ? usd.format(value) : "—"}</span>
    <span className="text-xs font-normal text-zinc-500">{note}</span>
  </span>
);

const FoilPill = ({ on }: { on: boolean }) => (
  <span
    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
      on ? "bg-gradient-to-r from-fuchsia-500/25 to-sky-500/25 text-sky-200" : "bg-white/10 text-zinc-300"
    }`}
  >
    {on ? "True" : "False"}
  </span>
);

/* ---------- full response (every field each API returned) ---------- */

const humanize = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^\w/, (ch) => ch.toUpperCase());

// Scalars and arrays of scalars render as one row; objects and arrays of objects nest.
const isLeaf = (v: unknown): boolean =>
  v === null || typeof v !== "object" || (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object"));

function FullResponse({ title, panel }: { title: string; panel: Panel<unknown> }) {
  const entries = panel.raw ? Object.entries(panel.raw) : [];
  const scalars = entries.filter(([, v]) => isLeaf(v));
  const groups = entries.filter(([, v]) => !isLeaf(v));
  return (
    <section aria-busy={panel.loading} className="min-w-0 rounded-2xl bg-zinc-900 ring-1 ring-white/10">
      <h2 className="border-b border-white/10 px-5 py-4 text-sm font-semibold">
        {title} <span className="font-normal text-zinc-500">· full response</span>
      </h2>
      {panel.loading ? (
        <p className="flex items-center gap-2 p-5 text-sm text-zinc-400">
          <Spinner className="h-4 w-4 border-2" /> Identifying…
        </p>
      ) : !panel.raw ? (
        <p className="p-5 text-sm text-zinc-500">{panel.error ?? "No data returned."}</p>
      ) : (
        <>
          {scalars.length > 0 && (
            <dl className="divide-y divide-white/5 px-5 py-2">
              {scalars.map(([k, v]) => (
                <Row key={k} label={humanize(k)}>
                  <Leaf name={k} value={v} />
                </Row>
              ))}
            </dl>
          )}
          {groups.map(([k, v]) => (
            <details key={k} open className="border-t border-white/10">
              <summary className="cursor-pointer select-none px-5 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-200">
                {humanize(k)}
              </summary>
              <div className="px-5 pb-4">
                <Tree value={v} />
              </div>
            </details>
          ))}
        </>
      )}
    </section>
  );
}

function Tree({ value }: { value: unknown }): ReactNode {
  if (isLeaf(value)) return <Leaf name="" value={value} />;
  if (Array.isArray(value)) {
    return (
      <div className="flex flex-col gap-3">
        {value.map((item, i) => (
          <div key={i} className="rounded-lg bg-white/[0.03] p-3 ring-1 ring-white/5">
            <p className="mb-1 text-xs font-semibold text-zinc-500">#{i + 1}</p>
            <Tree value={item} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <dl className="divide-y divide-white/5">
      {Object.entries(value as Raw).map(([k, v]) =>
        isLeaf(v) ? (
          <Row key={k} label={humanize(k)}>
            <Leaf name={k} value={v} />
          </Row>
        ) : (
          <div key={k} className="py-2">
            <dt className="mb-2 text-sm text-zinc-400">{humanize(k)}</dt>
            <dd className="border-l border-white/10 pl-3">
              <Tree value={v} />
            </dd>
          </div>
        ),
      )}
    </dl>
  );
}

function Leaf({ name, value }: { name: string; value: unknown }) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return <Empty />;
  if (Array.isArray(value)) return <>{value.join(", ")}</>;
  if (typeof value === "boolean") return <>{value ? "Yes" : "No"}</>;
  if (typeof value === "string" && /^https?:\/\//.test(value)) {
    const link = (
      <a href={value} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline-offset-2 hover:underline">
        {value}
      </a>
    );
    if (!/image/i.test(name)) return link;
    return (
      <span className="flex flex-col items-end gap-1">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={value} alt="" className="h-24 w-auto rounded ring-1 ring-white/10" />
        {link}
      </span>
    );
  }
  return <>{String(value)}</>;
}

/* ---------- small shared bits ---------- */

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

function MatchBadge({ tone, children }: { tone: "good" | "ok" | "bad"; children: ReactNode }) {
  const color = {
    good: "bg-emerald-500/15 text-emerald-300",
    ok: "bg-amber-500/15 text-amber-300",
    bad: "bg-red-500/15 text-red-300",
  }[tone];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{children}</span>;
}

const Spinner = ({ className }: { className: string }) => (
  <span className={`inline-block shrink-0 animate-spin rounded-full border-white/20 border-t-emerald-400 ${className}`} aria-hidden />
);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <dt className="shrink-0 text-zinc-400">{label}</dt>
      <dd className="min-w-0 text-right font-medium [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}
