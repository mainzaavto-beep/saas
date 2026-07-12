'use client';
// OverviewClient — Главная кабинета. Тянет /api/cabinets/[id]/overview.
// UI повторяет data-presenter app/page.jsx (KPI карточки + alerts).
import { useState, useEffect } from 'react';

const fmtRub = (v) => {
  const n = Number(v) || 0;
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n.toFixed(0);
};

function Kpi({ label, value, sub, color }) {
  return (
    <div className="kpi-card">
      <div className="label">{label}</div>
      <div className="value" style={color ? { color } : {}}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export default function OverviewClient({ cabinetId, from, to }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`/api/cabinets/${cabinetId}/overview?from=${from}&to=${to}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(String(e)); setLoading(false); });
  }, [cabinetId, from, to]);

  if (loading) return <div style={{ padding: 40, color: '#8a99b8' }}>Загрузка...</div>;
  if (error) return <div style={{ padding: 40, color: '#ff6b6b' }}>Ошибка: {error}</div>;
  if (!data) return null;

  const k = data.kpi || {};
  const a = data.alerts || {};

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <h2 style={{ margin: '0 0 8px' }}>📊 Главная</h2>
      <div style={{ fontSize: 13, color: '#8a99b8', marginBottom: 24 }}>
        {data.period?.from} → {data.period?.to} · МП: {data.mp || 'все'}
      </div>

      {/* KPI */}
      <div className="kpi-row">
        <Kpi label="Выручка" value={`${fmtRub(k.revenue)} ₽`} />
        <Kpi label="Прибыль" value={`${fmtRub(k.grossProfit)} ₽`}
          sub={`Маржа ${Number(k.margin || 0).toFixed(1)}%`}
          color={(k.grossProfit || 0) >= 0 ? '#4ade80' : '#f87171'} />
        <Kpi label="К перечислению" value={`${fmtRub(k.netPay)} ₽`} color="#60a5fa" />
        <Kpi label="Заказы" value={k.orders || 0}
          sub={`Отмены ${Number(k.cancelRate || 0).toFixed(1)}%`} />
        <Kpi label="Продано" value={k.sold || 0} />
        <Kpi label="ДРР" value={`${fmtRub(k.adSpend)} ₽`}
          sub={k.revenue > 0 ? `${((k.adSpend / k.revenue) * 100).toFixed(1)}%` : ''} />
      </div>

      {/* Расходы */}
      <div className="section">
        <h3>💸 Расходы</h3>
        <div className="kpi-row" style={{ marginBottom: 0 }}>
          <Kpi label="Себестоимость" value={`${fmtRub(k.cogsSold)} ₽`} />
          <Kpi label="Комиссия МП" value={`${fmtRub(k.expensesBreakdown?.commission)} ₽`} />
          <Kpi label="Логистика" value={`${fmtRub(k.expensesBreakdown?.logistics)} ₽`} />
          <Kpi label="Хранение" value={`${fmtRub(k.expensesBreakdown?.storage)} ₽`} />
          <Kpi label="Налог (УСН 6%)" value={`${fmtRub(k.tax)} ₽`} />
        </div>
      </div>

      {/* Алерты */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        {/* Убыточные товары */}
        <div className="section" style={{ flex: '1 1 400px' }}>
          <h3>⚠️ Убыточные товары ({a.lossMakers?.length || 0})</h3>
          {(a.lossMakers || []).length === 0 ? (
            <div style={{ color: '#8a99b8', fontSize: 14 }}>Нет убыточных товаров 🎉</div>
          ) : (
            <table className="table">
              <tbody>
                {(a.lossMakers || []).map((lm, i) => (
                  <tr key={i}>
                    <td>{(lm.name || '').slice(0, 40)}</td>
                    <td style={{ textAlign: 'right', color: '#f87171', fontWeight: 600 }}>
                      {fmtRub(lm.profit)} ₽
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Заканчивается сток */}
        <div className="section" style={{ flex: '1 1 400px' }}>
          <h3>📦 Заканчивается сток ({a.lowStock?.length || 0})</h3>
          {(a.lowStock || []).length === 0 ? (
            <div style={{ color: '#8a99b8', fontSize: 14 }}>Нет проблем со стоком 🎉</div>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Товар</th><th style={{ textAlign: 'right' }}>Остаток</th><th style={{ textAlign: 'right' }}>Дней до OOS</th></tr>
              </thead>
              <tbody>
                {(a.lowStock || []).map((ls, i) => (
                  <tr key={i}>
                    <td>{(ls.name || '').slice(0, 35)}</td>
                    <td style={{ textAlign: 'right' }}>{ls.qty} шт</td>
                    <td style={{ textAlign: 'right', color: ls.days_to_oos <= 7 ? '#f87171' : '#fbbf24' }}>
                      {Number(ls.days_to_oos).toFixed(0)} дн
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Без себестоимости */}
      {a.noCogsCount > 0 && (
        <div className="section" style={{ borderColor: '#fbbf24' }}>
          <h3 style={{ color: '#fbbf24' }}>ℹ️ Без себестоимости: {a.noCogsCount} товаров</h3>
          <div style={{ fontSize: 14, color: '#8a99b8' }}>
            У этих товаров не указана закупочная цена — прибыль считается некорректно.
            Укажите себестоимость во вкладке «Товары».
          </div>
        </div>
      )}
    </div>
  );
}
