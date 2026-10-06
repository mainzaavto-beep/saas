#!/usr/bin/env node
// scripts/check-unit-wb.mjs — сторож логистики WB в юнитке (06.10.2026).
// Без HTTP: считает факты окна тем же SQL, что computeWB
// (app/api/cabinets/[id]/unit/all/route.js), гонит через calcWB и проверяет
// тождество logistics × sold = Σлогистики окна (Δ < 1 коп. на штуку) на всех
// товарах кабинета с продажами в окне. Читает под saas_ro.
// Запуск: node scripts/check-unit-wb.mjs [cabinet_id=1]
import pg from "pg";
import { readonlyPgConfig } from "./lib/pgpass.mjs";
import { calcWB } from "../lib/unit.js";
import { defaultPeriod } from "../lib/period.js";

const cabinetId = Number(process.argv[2] || 1);
const { from, to } = defaultPeriod(30);
const client = new pg.Client(readonlyPgConfig());
await client.connect();
const { rows } = await client.query(
  `SELECT nm_id,
      COALESCE(SUM(quantity) FILTER (WHERE supplier_oper_name = 'Продажа'), 0) AS sold,
      COALESCE(SUM(quantity) FILTER (WHERE supplier_oper_name = 'Возврат'), 0) AS returns,
      COUNT(DISTINCT srid) FILTER (WHERE supplier_oper_name IN ('Логистика', 'Доставка')
                                     AND bonus_type_name ILIKE 'К клиенту при отмене%') AS cancels,
      COALESCE(SUM(delivery_rub) FILTER (WHERE supplier_oper_name IN ('Логистика', 'Доставка')
                                           AND bonus_type_name ILIKE 'К клиенту при продаже%'), 0) AS log_fwd,
      COALESCE(SUM(delivery_rub) FILTER (WHERE supplier_oper_name IN ('Логистика', 'Доставка')), 0) AS log_all
   FROM tenant.wb_finance_report
   WHERE cabinet_id = $1 AND nm_id <> 0 AND substr(rr_dt, 1, 10) BETWEEN $2 AND $3
   GROUP BY nm_id`, [cabinetId, from, to]);
await client.end();

let pass = 0, fail = 0, logAll = 0, sold = 0;
for (const r of rows) {
  const f = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
  if (!(f.sold > 0)) continue;
  const unb = f.cancels + f.returns;
  const rest = Math.max(0, f.log_all - f.log_fwd);
  const inputs = unb > 0
    ? { logisticsFbo: f.log_fwd / f.sold, returnLogistics: rest / unb, buyout: f.sold / (f.sold + unb) }
    : { logisticsFbo: f.log_all / f.sold, returnLogistics: 0, buyout: 1 };
  const out = calcWB({ priceSeller: 1000, discount: 0, commissionRate: 0.25, ...inputs });
  const want = f.log_all / f.sold;
  const ok = Math.abs(out.logistics - want) < 0.01;
  ok ? pass++ : fail++;
  logAll += f.log_all; sold += f.sold;
  if (!ok) console.log(`FAIL nm ${f.nm_id}: logistics ${out.logistics} vs ${want.toFixed(2)}`);
}
console.log(`окно ${from}..${to}, кабинет ${cabinetId}: PASS ${pass}, FAIL ${fail}; логистика на проданную по кабинету ${(logAll / sold).toFixed(2)} ₽`);
process.exit(fail ? 1 : 0);
