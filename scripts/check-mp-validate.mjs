// scripts/check-mp-validate.mjs — проверка lib/mpValidate.js против заглушки.
// Настоящие ключи и сеть не нужны: адреса маркетплейсов подменяются.
import { startStub } from './lib/mp-stub.mjs';
import { validateShopCreds } from '../lib/mpValidate.js';

let failed = 0;
const check = (name, cond, got = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${got}`}`);
  if (!cond) failed++;
};

const basesFor = (base) => ({
  wbCommon: base, wbStats: base, wbPrices: base, ozonSeller: base, ozonPerf: base,
});

// 1. Всё хорошо — сохраняем.
{
  const s = await startStub('ok');
  const r = await validateShopCreds({ mpCode: 'ozon', creds: { client_id: '1', api_key: 'k' }, bases: basesFor(s.base) });
  check('ozon, рабочие ключи: ok', r.ok === true && r.unreachable === false, JSON.stringify(r));
  await s.stop();
}

// 2. Неверный ключ Ozon — отказ, в тексте сказано про ключ.
{
  const s = await startStub('bad_key');
  const r = await validateShopCreds({ mpCode: 'ozon', creds: { client_id: '1', api_key: 'k' }, bases: basesFor(s.base) });
  const msg = r.checks.filter((c) => !c.ok).map((c) => c.message).join(' ');
  check('ozon, неверный ключ: отказ', r.ok === false && r.unreachable === false, JSON.stringify(r));
  check('ozon, неверный ключ: текст про ключ', /ключ/i.test(msg), msg);
}

// 3. Нет нужной роли (случай 1009) — отказ, в тексте сказано про доступ/роль.
{
  const s = await startStub('no_role');
  const r = await validateShopCreds({ mpCode: 'ozon', creds: { client_id: '1', api_key: 'k' }, bases: basesFor(s.base) });
  const msg = r.checks.filter((c) => !c.ok).map((c) => c.message).join(' ');
  check('ozon, нет роли: отказ', r.ok === false, JSON.stringify(r));
  check('ozon, нет роли: текст про доступ', /доступ|роль/i.test(msg), msg);
  await s.stop();
}

// 4. Просроченный токен WB — отказ.
{
  const s = await startStub('expired');
  const r = await validateShopCreds({ mpCode: 'wb', creds: { token: 't' }, bases: basesFor(s.base) });
  check('wb, просроченный токен: отказ', r.ok === false && r.unreachable === false, JSON.stringify(r));
  await s.stop();
}

// 5. Маркетплейс лежит — сохраняем с предупреждением, НЕ отказ.
{
  const s = await startStub('down');
  const r = await validateShopCreds({ mpCode: 'wb', creds: { token: 't' }, bases: basesFor(s.base) });
  check('wb, маркетплейс лежит: сохранить с предупреждением', r.ok === true && r.unreachable === true, JSON.stringify(r));
  await s.stop();
}

// 6. Таймаут — тоже предупреждение, и укладываемся в бюджет.
{
  const s = await startStub('slow');
  const t0 = Date.now();
  const r = await validateShopCreds({ mpCode: 'wb', creds: { token: 't' }, bases: basesFor(s.base), timeoutMs: 1000 });
  const spent = Date.now() - t0;
  check('wb, таймаут: сохранить с предупреждением', r.ok === true && r.unreachable === true, JSON.stringify(r));
  check('wb, таймаут: уложились в бюджет', spent < 4000, `${spent}мс`);
  await s.stop();
}

// 7. Рекламные креды Ozon необязательные: их отказ не блокирует сохранение.
{
  const s = await startStub('ok');
  const r = await validateShopCreds({
    mpCode: 'ozon',
    creds: { client_id: '1', api_key: 'k', perf_client_id: 'p', perf_client_secret: 's' },
    bases: { ...basesFor(s.base), ozonPerf: 'http://127.0.0.1:1' },  // порт закрыт
  });
  check('ozon, реклама не проверилась: всё равно сохраняем', r.ok === true, JSON.stringify(r));
  check('ozon, реклама: предупреждение отдельной строкой',
    r.checks.some((c) => c.capability === 'ads' && !c.ok && c.fatal === false), JSON.stringify(r.checks));
  await s.stop();
}

console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
