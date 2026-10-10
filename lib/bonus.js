// lib/bonus.js — премия менеджеров площадок (спека docs/superpowers/specs/2026-10-08-managers-bonus-design.md).
// Чистые функции, БД не трогают. Модель — лист «KPI (копия)» владельца + порог из листа «KPI»:
//   три показателя (продажи, прибыль, маржа) × % выполнения; любой ниже порога → бонус 0;
//   бонус = bonusPct × факт прибыли × среднее трёх %; к оплате = оклад + бонус. Потолка нет.
// Исключённый артикул снимает и свой факт (канон по товару), и введённую владельцем долю плана.

const round2 = (v) => Math.round(((v || 0) + Number.EPSILON) * 100) / 100;
const num = (v) => (v == null || v === "" ? 0 : Number(v) || 0);

export function computeBonus({ salesPlan, profitPlan, salesFact, profitFact, exclusions = [], salary, bonusPct, threshold }) {
  const ex = exclusions.reduce((a, e) => ({
    revenue: a.revenue + num(e.revenue), profit: a.profit + num(e.profit),
    salesOff: a.salesOff + num(e.salesPlanOff), profitOff: a.profitOff + num(e.profitPlanOff),
  }), { revenue: 0, profit: 0, salesOff: 0, profitOff: 0 });

  const fact = { sales: round2(num(salesFact) - ex.revenue), profit: round2(num(profitFact) - ex.profit) };
  fact.margin = fact.sales > 0 ? fact.profit / fact.sales : 0;
  const plan = { sales: round2(num(salesPlan) - ex.salesOff), profit: round2(num(profitPlan) - ex.profitOff) };
  plan.margin = plan.sales > 0 ? plan.profit / plan.sales : 0;

  const sal = num(salary);
  if (!(plan.sales > 0) || !(plan.profit > 0)) {
    return { status: "no_plan", plan, fact, indicators: [], avg: null, eligible: false, bonusBase: 0, bonus: 0, payout: round2(sal) };
  }

  const thr = num(threshold);
  const indicators = [
    { key: "sales", plan: plan.sales, fact: fact.sales },
    { key: "profit", plan: plan.profit, fact: fact.profit },
    { key: "margin", plan: plan.margin, fact: fact.margin },
  ].map((i) => {
    const pct = i.fact / i.plan;
    return { ...i, pct, below: pct < thr };
  });
  const avg = indicators.reduce((a, i) => a + i.pct, 0) / indicators.length;
  const eligible = fact.profit > 0 && indicators.every((i) => !i.below);
  const bonusBase = round2(num(bonusPct) * Math.max(fact.profit, 0));
  const bonus = eligible ? round2(bonusBase * avg) : 0;
  return { status: "ok", plan, fact, indicators, avg, eligible, bonusBase, bonus, payout: round2(sal + bonus) };
}

export function isValidPeriod(period) {
  return typeof period === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
}

// Окно факта: прошлый месяц — целиком; текущий — с 1-го по вчера; будущий или начавшийся сегодня — null.
export function monthWindow(period, today) {
  const [y, m] = period.split("-").map(Number);
  const from = `${period}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthEnd = `${period}-${String(last).padStart(2, "0")}`;
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  const yesterday = t.toISOString().slice(0, 10);
  const to = monthEnd < yesterday ? monthEnd : yesterday;
  return to < from ? null : { from, to };
}

// Кто какую карточку видит. Менеджер — только свою (параметр запроса игнорируется),
// и только если он в программе; наблюдатель — никогда; владелец — любую из программы.
export function resolveBonusViewer({ role, sessionUserId, requestedUserId, employees }) {
  const ids = employees.map((e) => Number(e.user_id));
  if (role === "owner") {
    const req = Number(requestedUserId);
    return { mode: "owner", userId: ids.includes(req) ? req : (ids[0] ?? null) };
  }
  if (role === "manager" && ids.includes(Number(sessionUserId))) {
    return { mode: "self", userId: Number(sessionUserId) };
  }
  return { mode: "denied", userId: null };
}
