// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizePricing, toCardSight, type CsIdentify } from "./cardsight.ts";

const identified: CsIdentify = {
  success: true,
  detections: [
    {
      confidence: "High",
      card: {
        id: "0b8f2c1e-1111-4222-8333-444455556666",
        year: "2017",
        manufacturer: "The Pokemon Company",
        releaseName: "Pokemon Sun & Moon",
        setName: "Burning Shadows",
        name: "Darkrai",
        number: "87",
        parallelSuggestions: [{ id: "p-1", name: "Holofoil", confidence: "High" }],
      },
      grading: { company: { name: "PSA" }, grade: { value: "10", condition: "Gem Mint" }, certNumber: "12345678" },
    },
  ],
};

test("maps the first identified card, its parallel and slab grade", () => {
  const r = toCardSight(identified);
  assert.ok(typeof r !== "string");
  assert.equal(r.card.name, "Darkrai");
  assert.equal(r.card.parallel, "Holofoil");
  assert.equal(r.card.numbered_to, null);
  assert.deepEqual(r.grading, { company: "PSA", grade: "10 Gem Mint", cert: "12345678" });
});

test("no identified card returns a message", () => {
  assert.match(toCardSight({ success: true, detections: [] }) as string, /not recognized/);
  assert.equal(
    toCardSight({ success: true, detections: [{ confidence: "Low" }], messages: [{ type: "warning", message: "Too blurry" }] }),
    "Too blurry",
  );
});

test("pricing uses the median sale and the latest sale date", () => {
  const p = summarizePricing({
    raw: {
      records: [
        { price: 2, date: "2026-10-01" },
        { price: 100, date: "2026-11-01" }, // outlier shouldn't drag the median
        { price: 1, date: "2026-09-15" },
        { price: 3, date: null },
      ],
    },
  });
  assert.deepEqual(p, { median: 2.5, sales: 4, last_sale: "2026-11-01" });
  assert.deepEqual(summarizePricing({}), { median: null, sales: 0, last_sale: null });
});
