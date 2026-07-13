// lib/mpStockValue.js — себестоимость остатков на МП (DatabaseSync PG+RLS).
import { DatabaseSync } from "./db.js";

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function resolveStockDate(db, dateParam) {
  if (dateParam && ISO_DATE.test(dateParam)) {
    const r = await db.prepare("SELECT MAX(date) AS d FROM daily_stock WHERE date <= ?").get(dateParam);
    if (r?.d) return r.d;
  }
  return (await db.prepare("SELECT MAX(date) AS d FROM daily_stock").get())?.d || null;
}

async function wbValueCost(dateParam) {
  const db = new DatabaseSync("wb", { readOnly: true });
  const date = await resolveStockDate(db, dateParam);
  if (!date) return { valueCost: 0, date: null };
  const r = await db.prepare(
    `SELECT COALESCE(SUM(st.quantity_full * COALESCE(c.cost, 0)), 0) AS v
     FROM (SELECT nm_id, SUM(quantity_full) AS quantity_full FROM daily_stock WHERE date = ? GROUP BY nm_id) st
     LEFT JOIN cogs c ON c.nm_id = st.nm_id`
  ).get(date);
  return { valueCost: round2(r?.v || 0), date };
}

async function ozonValueCost(dateParam) {
  const db = new DatabaseSync("ozon", { readOnly: true });
  const date = await resolveStockDate(db, dateParam);
  if (!date) return { valueCost: 0, date: null };
  const r = await db.prepare(
    `SELECT COALESCE(SUM(st.fbo_present * COALESCE(c.cost, 0)), 0) AS v
     FROM (SELECT product_id, SUM(fbo_present) AS fbo_present FROM daily_stock WHERE date = ? GROUP BY product_id) st
     LEFT JOIN cogs c ON c.product_id = st.product_id`
  ).get(date);
  return { valueCost: round2(r?.v || 0), date };
}

export async function stockBreakdown(asOfDate = null) {
  const wb = await wbValueCost(asOfDate);
  const oz = await ozonValueCost(asOfDate);
  const yandex = 0;
  return {
    wb: wb.valueCost, ozon: oz.valueCost, yandex,
    total: round2(wb.valueCost + oz.valueCost + yandex),
    dateWb: wb.date, dateOzon: oz.date,
  };
}
