import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { askSmart, llmAvailable } from "@/lib/llm";
import { CATEGORIES, normDomain } from "@/lib/opexMeta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// =====================================================================
//  /api/cabinets/[id]/voice-expense — NER-извлечение сущностей из
//  голосового/текстового сообщения о расходе (голосовой финконтроль).
//
//  ПОТОК: клиент (веб-кнопка 🎤 на /fin-manual) распознаёт речь в текст
//  (STT в браузере через Web Speech API) и присылает сюда ТОЛЬКО текст.
//  Сервер через GLM (glm-5.2, askSmart) извлекает сущности и возвращает
//  ИХ ПРЕДПРОСМОТР для подтверждения. Записи в БД НЕ происходит —
//  пользователь проверяет/правит карточку, затем финальный
//  POST /api/cabinets/[id]/opex (с source='voice') сохраняет.
//
//  Обёрнуто в withCabinet: session + membership + RLS по cabinet_id.
//  Без requireRole — NER не пишет в БД, поэтому доступно любой роли
//  (viewer/manager могут распознать, но сохранить смогут только owner —
//  POST /opex требует owner; фронт покажет 403 при попытке сохранения).
//
//  POST { text, domain }  →  { ok, entities: {amount, category, op_date,
//                                                note, counterparty, period} }
//
//  domain — какой поток расходов диктуется (business/personal/family).
//  Влияет на то, как GLM подбирает категорию: business → один из enum P&L;
//  personal/family → свободный текст (Продукты, Транспорт...).
//
//  Парсинг JSON defensive (нативного JSON-mode в кодбазе нет):
//  ищем {...} в ответе, на провал — regex-fallback по сумме.
// =====================================================================

// todayISO — 'YYYY-MM-DD' в локальной зоне (для дат-относителей «сегодня/вчера»).
function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Извлекает первый {...}-блок из текста и парсит. На провал возвращает null.
function extractJson(text) {
  if (!text) return null;
  const t = String(text).trim();
  // Случай 1: весь ответ — JSON.
  if (t.startsWith("{")) {
    try { return JSON.parse(t); } catch { /* идём к случаю 2 */ }
  }
  // Случай 2: JSON встроен в текст (модель могла добавить пояснение).
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* ниже */ }
  }
  return null;
}

// Regex-fallback: если JSON не вышел, хоть сумму попробуем вытащить.
// «5000», «5к», «15 тыс», «15000 рублей».
function fallbackAmount(text) {
  if (!text) return null;
  const m = String(text).match(/(\d+(?:[.,]\d+)?)\s*(тыс|тр|к|k)?\s*(?:руб|р\.?|\$|₽)?/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(",", "."));
  const mult = (m[2] || "").toLowerCase();
  if (mult === "к" || mult === "k") n *= 1000;
  if (mult === "тыс" || mult === "тр") n *= 1000;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function buildSystem(domain) {
  const today = todayISO();
  const yesterday = dateOffset(-1);
  const catRule = domain === "business"
    ? `Категория — ОДНА из строго заданного enum: ${CATEGORIES.join(" / ")}. Если не ясно — ставь «Прочие».`
    : `Категория — короткое существительное/словосочетание в именительном падеже из контекста (Продукты, Транспорт, Жильё, Здоровье, Развлечения, Одежда, Связь, Кафе, Бензин, Аптека и т.п.). Одно-два слова.`;
  return [
    "Ты — ассистент, который разбирает русскую фразу о расходе и извлекает из неё структурированные данные.",
    "Твоя задача — вернуть ТОЛЬКО валидный JSON-объект с полями. Никакого текста вокруг, без markdown-обёртки.",
    "",
    "Поля:",
    "- amount: число (float). Сумма в рублях. «5к»=5000, «15 тыс»=15000, «пятнадцать тысяч»=15000.",
    "- category: строка. " + catRule,
    "- op_date: строка 'YYYY-MM-DD' — дата расхода.",
    "    «сегодня»=" + today + ", «вчера»=" + yesterday + ", «позавчера»=" + dateOffset(-2) + ".",
    "    Если дата не названа — ставь «" + today + "».",
    "    Конкретная дата «3 июля»/«03.07» переведи в YYYY-MM-DD (год текущий).",
    "- note: строка. Краткое описание из фразы (чищеное), что куплено/за что заплачено.",
    "- counterparty: строка или null. Кому/где (название магазина, конторы) — если названо, иначе null.",
    "- is_expense: true (мы пока фиксируем только расходы; зарплата/доход — отдельная задача).",
    "",
    "Возвращай СТРОГО JSON. Примеры:",
    '{"amount":5000,"category":"Продукты","op_date":"' + today + '","note":"продукты в супермаркете","counterparty":"Пятёрочка","is_expense":true}',
    '{"amount":15000,"category":"Административные","op_date":"' + yesterday + '","note":"аренда офиса за июль","counterparty":null,"is_expense":true}',
  ].join("\n");
}

export const POST = withCabinet(async (req) => {
  const b = await req.json();
  const text = String(b.text || "").trim();
  const domain = await normDomain(b.domain); // normDomain в saas — async (await обязателен)
  if (!text) {
    return NextResponse.json({ error: "text не должен быть пустым" }, { status: 400 });
  }
  if (!llmAvailable()) {
    return NextResponse.json(
      { error: "Не настроен ZAI_API_KEY — NER недоступен" },
      { status: 503 }
    );
  }

  const raw = await askSmart(text, {
    system: buildSystem(domain),
    // glm-5.2 — reasoning-модель: под NER уходит ~470-570 токенов в скрытый
    // reasoning-блок ПЕРЕД content. При бюджете < reasoning ответ пустой
    // (finish_reason: "length"). 1200 = запас над reasoning (~570) + content (~200).
    maxTokens: 1200,
    temperature: 0.1, // NER — детерминированная задача, минимум креатива.
  });
  if (!raw) {
    return NextResponse.json(
      { error: "GLM не вернул ответ (сеть/квота)" },
      { status: 502 }
    );
  }

  let ents = extractJson(raw);
  // Fallback: JSON не разобрался — пробуем вытащить хотя бы сумму.
  if (!ents) {
    const amount = fallbackAmount(text);
    ents = {
      amount,
      category: domain === "business" ? "Прочие" : "Прочее",
      op_date: todayISO(),
      note: text.slice(0, 200),
      counterparty: null,
      is_expense: true,
      _fallback: true,
    };
  }

  // Нормализация и санитизация.
  const amount = Number(ents.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    // Сумма не распознана — это блокер, возвращаем что есть с пометкой.
    return NextResponse.json({
      ok: false,
      error: "не удалось распознать сумму",
      entities: {
        ...ents,
        amount: null,
        _parse_warning: "GLM не извлёк корректную сумму — введите вручную",
      },
    }, { status: 200 });
  }
  const op_date = /^\d{4}-\d{2}-\d{2}$/.test(String(ents.op_date))
    ? String(ents.op_date)
    : todayISO();
  // period выводим из даты (месяц) — для записи в opex.
  const period = op_date.slice(0, 7);

  return NextResponse.json({
    ok: true,
    entities: {
      amount: Math.round(amount * 100) / 100,
      category: String(ents.category || (domain === "business" ? "Прочие" : "Прочее"))
        .trim().slice(0, 100),
      op_date,
      period,
      note: String(ents.note || text).trim().slice(0, 400),
      counterparty: ents.counterparty ? String(ents.counterparty).trim().slice(0, 200) : null,
      is_expense: true,
      domain,
      _fallback: !!ents._fallback,
    },
  });
});
