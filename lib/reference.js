// lib/reference.js — чтение эталона и сравнение с допуском.
//
// Эталон — числа из официальных отчётов маркетплейса. Он существует, чтобы ловить
// расхождения, поэтому модуль намеренно строгий: незаполненная величина — это
// ошибка, а не ноль. Молчаливый ноль превратил бы сверку в вечнозелёную.
import { readFileSync } from 'node:fs';

// Расхождение значимо, только если превышены ОБА порога: и рубль, и полпроцента.
// Один порог без другого делает сверку либо шумной на копейках, либо слепой на
// мелких величинах.
const TOL_RUB = 1;
const TOL_PCT = 0.5;

export function compare(expected, actual) {
  const e = Number(expected);
  const a = Number(actual);
  const diffRub = a - e;
  const diffPct = e === 0 ? (a === 0 ? 0 : 100) : (diffRub / e) * 100;
  const ok = Math.abs(diffRub) <= TOL_RUB || Math.abs(diffPct) <= TOL_PCT;
  return { ok, diffRub, diffPct };
}

export function loadReference(dir) {
  const path = `${dir.replace(/\/$/, '')}/expected.json`;
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`эталон не читается (${path}): ${e.message}`);
  }
  const ref = JSON.parse(raw);
  const missing = [];
  for (const mp of ['wb', 'ozon']) {
    const block = ref[mp];
    if (!block) {
      missing.push(`${mp} (блок отсутствует)`);
      continue;
    }
    if (!Array.isArray(block.periods) || block.periods.length === 0) {
      missing.push(`${mp}.periods (пусто или отсутствует)`);
    } else {
      for (const p of block.periods) {
        if (!p.date_from || !p.date_to) missing.push(`${mp}.periods[].date_from/date_to`);
      }
    }
    if (block.values) {
      for (const [k, v] of Object.entries(block.values)) {
        if (typeof v !== 'number' || isNaN(v)) {
          missing.push(`${mp}.${k} (должно быть число, получено ${typeof v})`);
        }
      }
    } else {
      missing.push(`${mp}.values (пусто или отсутствует)`);
    }
  }
  if (missing.length) {
    throw new Error(
      `эталон не заполнен: ${missing.join(', ')}.\n`
      + `Числа берутся из официальных отчётов маркетплейса — см. ${dir}/SOURCES.md.`
    );
  }
  return ref;
}
