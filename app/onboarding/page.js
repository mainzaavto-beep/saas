'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function OnboardingPage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [mps, setMps] = useState({ wb: true, ozon: true });
  const [wbToken, setWbToken] = useState('');
  const [ozonClientId, setOzonClientId] = useState('');
  const [ozonApiKey, setOzonApiKey] = useState('');
  const [ozonPerfId, setOzonPerfId] = useState('');
  const [ozonPerfSecret, setOzonPerfSecret] = useState('');
  const [usnPct, setUsnPct] = useState('6');
  const [vat, setVat] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  function toggleMp(mp) { setMps((s) => ({ ...s, [mp]: !s[mp] })); }

  async function submit(e) {
    e.preventDefault();
    setErr('');
    const marketplaces = Object.keys(mps).filter((m) => mps[m]);
    if (!marketplaces.length) { setErr('Выберите хотя бы один маркетплейс'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/onboarding/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: displayName, marketplaces,
          wb_token: wbToken,
          ozon_client_id: ozonClientId, ozon_api_key: ozonApiKey,
          ozon_perf_client_id: ozonPerfId, ozon_perf_client_secret: ozonPerfSecret,
          usn_pct: usnPct, vat,
        }),
      });
      const data = await r.json();
      if (!r.ok) { setErr(data.error || 'Ошибка'); return; }
      router.push('/');
      router.refresh();
    } catch { setErr('Сетевая ошибка'); }
    finally { setBusy(false); }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" style={{ maxWidth: 520 }} onSubmit={submit}>
        <h1>Подключение кабинета</h1>
        <p className="sub">Заполните данные — мы начнём собирать вашу аналитику</p>
        {err && <div className="err">{err}</div>}

        <div className="field">
          <label>Название кабинета</label>
          <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Напр. ИП Иванов" required autoFocus />
        </div>

        <div className="field">
          <label>Маркетплейсы</label>
          <div style={{ display: 'flex', gap: 12 }}>
            {['wb', 'ozon'].map((mp) => (
              <label key={mp} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, cursor: 'pointer' }}>
                <input type="checkbox" checked={mps[mp]} onChange={() => toggleMp(mp)} />
                {mp === 'wb' ? 'Wildberries' : 'Ozon'}
              </label>
            ))}
          </div>
        </div>

        {mps.wb && (
          <div className="field">
            <label>WB Token (доступ «Статистика»)</label>
            <input type="password" value={wbToken} onChange={(e) => setWbToken(e.target.value)} required={mps.wb} />
          </div>
        )}

        {mps.ozon && (
          <>
            <div className="field">
              <label>Ozon Client-Id</label>
              <input type="text" value={ozonClientId} onChange={(e) => setOzonClientId(e.target.value)} required={mps.ozon} />
            </div>
            <div className="field">
              <label>Ozon Api-Key</label>
              <input type="password" value={ozonApiKey} onChange={(e) => setOzonApiKey(e.target.value)} required={mps.ozon} />
            </div>
            <div className="field">
              <label>Ozon Performance Client-Id (реклама, опционально)</label>
              <input type="text" value={ozonPerfId} onChange={(e) => setOzonPerfId(e.target.value)} />
            </div>
            <div className="field">
              <label>Ozon Performance Client-Secret (опционально)</label>
              <input type="password" value={ozonPerfSecret} onChange={(e) => setOzonPerfSecret(e.target.value)} />
            </div>
          </>
        )}

        <div className="field">
          <label>Налоговый режим: УСН (%)</label>
          <input type="number" min="0" max="100" value={usnPct} onChange={(e) => setUsnPct(e.target.value)} required />
        </div>
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={vat} onChange={(e) => setVat(e.target.checked)} />
            Работаю с НДС
          </label>
        </div>

        <button className="btn" disabled={busy}>{busy ? 'Создаём кабинет...' : 'Подключить'}</button>
        <div className="foot">Ключи хранятся зашифрованными. Сбор данных начнётся автоматически.</div>
      </form>
    </div>
  );
}
