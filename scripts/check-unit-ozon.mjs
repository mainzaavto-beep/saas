#!/usr/bin/env node
// scripts/check-unit-ozon.mjs — сторож Ozon-модели юнитки (спека
// docs/superpowers/specs/2026-09-17-ozon-unit-model-design.md §7.2).
// Без HTTP: считает факты окна тем же SQL, что computeOzon, гонит их через
// calcOzon и проверяет тождество logistics × sold = Σлогистики окна (Δ < 1 коп.)
// на всех товарах кабинета с продажами. Читает под saas_ro.
// Запуск: node scripts/check-unit-ozon.mjs [cabinet_id=1]
import pg from "pg";
import { readonlyPgConfig } from "./lib/pgpass.mjs";
import { calcOzon } from "../lib/unit.js";
import { defaultPeriod } from "../lib/period.js";

const cabinetId = Number(process.argv[2] || 1);
const { from, to } = defaultPeriod(30);
const client = new pg.Client(readonlyPgConfig());
await client.connect();
const { rows } = await client.query(
  `SELECT product_id,
      COALESCE(SUM(qty) FILTER (WHERE is_return = 0), 0)            AS sold,
      COALESCE(SUM(qty) FILTER (WHERE is_return = 1), 0)            AS returns,
      ABS(COALESCE(SUM(logistics) FILTER (WHERE is_return = 0), 0)) AS log_fwd,
      ABS(COALESCE(SUM(logistics) FILTER (WHERE is_return = 1), 0)) AS log_ret,
      ABS(COALESCE(SUM(commission) FILTER (WHERE is_return = 0), 0)) AS comm_sum,
      ABS(COALESCE(SUM(acquiring) FILTER (WHERE is_return = 0), 0))  AS acq_sum,
      COALESCE(SUM(cost_value_retail) FILTER (WHERE is_return = 0), 0) AS retail_sum
   FROM tenant.ozon_order_costs
   WHERE cabinet_id = $1 AND product_id IS NOT NULL
     AND substr(COALESCE(sale_dt, return_dt), 1, 10) BETWEEN $2 AND $3
   GROUP BY product_id`, [cabinetId, from, to]);
await client.end();

let pass = 0, fail = 0;
for (const r of rows) {
  const f = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
  if (!(f.sold > 0)) continue;
  const R = f.returns > 0 ? f.log_ret / f.returns : 0;
  const out = calcOzon({
    priceOzon: f.retail_sum / f.sold,
    commissionRate: f.comm_sum / f.retail_sum, acquiringRate: f.acq_sum / f.retail_sum,
    logisticsFbo: f.log_fwd / f.sold, returnLogistics: R, buyout: f.sold / (f.sold + f.returns),
  });
  const want = (f.log_fwd + f.log_ret) / f.sold;
  const ok = Math.abs(out.logistics - want) < 0.01
    && Math.abs(out.commission * f.sold - f.comm_sum) < 0.01 * f.sold + 0.01;
  ok ? pass++ : fail++;
  if (!ok) console.log(`FAIL product ${f.product_id}: logistics ${out.logistics} vs ${want.toFixed(2)}; commission ${out.commission * f.sold} vs ${f.comm_sum}`);
}
console.log(`окно ${from}..${to}, кабинет ${cabinetId}: PASS ${pass}, FAIL ${fail}`);
process.exit(fail ? 1 : 0);
