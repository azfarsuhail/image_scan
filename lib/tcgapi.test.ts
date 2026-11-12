// Run: npm test  (Node 24 strips TS types natively)
import { test } from "node:test";
import assert from "node:assert/strict";
import { toResult, type IdentifyUpstream } from "./tcgapi.ts";

// Trimmed from the docs example at https://tcgapi.dev/api/identify/
const matched: IdentifyUpstream["data"] = {
  status: "matched",
  message: null,
  candidates: [
    {
      tcgplayer_id: 138577,
      name: "Darkrai",
      number: "87/147",
      rarity: "Holo Rare",
      set: { name: "SM - Burning Shadows", code: null },
      image_url: "https://product-images.tcgplayer.com/fit-in/400x400/138577.jpg",
      suggested_printing: "Holofoil",
      prices: [
        { printing: "Reverse Holofoil", market_price: 1.34, low_price: 0.15, last_updated_at: "2026-10-13T22:08:52.239Z" },
        { printing: "Holofoil", market_price: 1.23, low_price: 0.27, last_updated_at: "2026-10-13T22:08:52.239Z" },
      ],
    },
  ],
};

test("maps a matched card and picks the suggested printing's price", () => {
  const r = toResult(matched);
  assert.ok(typeof r !== "string");
  assert.equal(r.card.name, "Darkrai");
  assert.equal(r.card.number, "87/147");
  assert.equal(r.card.set_code, null);
  assert.equal(r.card.is_foil, true);
  assert.equal(r.market_data?.market_price, 1.23);
});

test("non-foil printing is not foil", () => {
  const r = toResult({ ...matched, candidates: [{ ...matched.candidates[0], suggested_printing: "Normal", prices: [] }] });
  assert.ok(typeof r !== "string");
  assert.equal(r.card.is_foil, false);
  assert.equal(r.market_data, null);
});

test("unrecognized statuses return a message", () => {
  assert.match(toResult({ status: "not_found", message: null, candidates: [] }) as string, /not recognized/);
  assert.equal(toResult({ status: "retake", message: "Too much glare", candidates: [] }), "Too much glare");
});
