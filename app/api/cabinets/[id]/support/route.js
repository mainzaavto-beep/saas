// /api/cabinets/[id]/support — чат поддержки (AI-бот + эскалация к оператору).
//
//  Поток: клиент пишет → AI (glm-5.2, askSmart) отвечает первым мгновенно →
//  если клиент просит человека или AI недоступен → тред эскалируется
//  (status='escalated'). Polling подбирает новые сообщения через GET ?since=<id>.
//
//  Один активный тред на cabinet (создаётся автоматически при первом обращении).
//  Сообщения: role='user' (клиент) | 'assistant' (AI или оператор).
//
//  GET  ?since=<id>            — сообщения треда новее since + статус (для polling).
//  POST {action:"send", content} — отправить сообщение клиента, получить ответ AI.
//  PATCH {action:"resolve"}    — закрыть тред (manager+, для хозяина).
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { getSession } from "@/lib/session.js";
import { askSmart, llmAvailable } from "@/lib/llm.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// AI-вызов может занимать несколько секунд.
export const maxDuration = 30;

// System prompt для AI-ассистента поддержки. Жёсткое правило: НЕ придумывать
// цифры конкретного клиента (AI не видит tenant.* данные) — направлять в разделы.
const SUPPORT_SYSTEM_PROMPT = [
  "Ты — дружелюбный ассистент поддержки SaaS-дашборда для продавцов Wildberries и Ozon (SySell).",
  "Сервис показывает аналитику: заказы, выручку, прибыль, маржу, юнит-экономику, остатки, ABC-анализ, отзывы, финансы.",
  "Отвечай КОРОТКО (2-5 предложений), по делу, на «вы», на русском. Будь полезен.",
  "ВАЖНО: ты НЕ видишь цифры и данные конкретного кабинета пользователя. Если вопрос про его цифры",
  "(«сколько у меня продаж», «какая моя маржа», «какая выручка») — отвечай, ГДЕ это посмотреть",
  "(раздел «Сводка по товарам», «Сводка по прибыли», «ABC анализ» и т.д.), и НЕ называй конкретные числа.",
  "Если пользователь просит оператора/человека/менеджера — скажи, что передаёшь вопрос команде.",
  "Если не уверен — честно скажи и предложи позвать оператора.",
].join("\n");

// Фразы, триггерящие эскалацию к живому оператору.
const ESCALATE_PATTERNS = [
  "оператор", "человек", "менеджер", "позови", "позвать", "живой",
  "свяжитесь", "перезвон", "телефон", "позвонит", "консультация",
  "не понял", "не понимаю", "не работает", "ошибка", "баг", "сломалось",
];

// Найти или создать активный тред для текущего cabinet. Возвращает {id, status}.
async function getOrCreateThread(user) {
  const rows = await tenantQuery(
    `SELECT id, status FROM tenant.support_threads
     WHERE status IN ('ai','escalated') ORDER BY id DESC LIMIT 1`
  );
  if (rows.length) return rows[0];
  const created = await tenantQuery(
    `INSERT INTO tenant.support_threads (cabinet_id, user_id, user_name, status)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, 'ai')
     RETURNING id, status`,
    [user?.user_id || null, user?.name || user?.email || null]
  );
  return created[0];
}

export const GET = withCabinet(async (req, { cabinet }) => {
  const session = await getSession();
  const url = new URL(req.url);
  const since = Number(url.searchParams.get("since") || 0);
  const thread = await getOrCreateThread(session);
  const msgs = await tenantQuery(
    `SELECT id, thread_id, role, content, by_ai,
            to_char(created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD"T"HH24:MI') AS ts
     FROM tenant.support_messages
     WHERE thread_id = $1 AND id > $2
     ORDER BY id ASC`,
    [thread.id, since]
  );
  return NextResponse.json({ thread: { id: thread.id, status: thread.status }, messages: msgs });
});

export const POST = withCabinet(async (req, { cabinet }) => {
  const session = await getSession();
  const body = await req.json();
  const { action, content } = body;

  if (action === "send") {
    const text = (content || "").trim();
    if (!text) return NextResponse.json({ error: "content required" }, { status: 400 });

    const thread = await getOrCreateThread(session);

    // 1) Сохраняем сообщение клиента.
    const userMsg = await tenantQuery(
      `INSERT INTO tenant.support_messages (cabinet_id, thread_id, role, content, by_ai)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, 'user', $2, false)
       RETURNING id, role, content, by_ai`,
      [thread.id, text]
    );

    // 2) Проверка эскалации (просьба оператора / жалоба на ошибку).
    const lower = text.toLowerCase();
    const shouldEscalate = ESCALATE_PATTERNS.some((p) => lower.includes(p));

    let aiMsg = null;
    if (shouldEscalate) {
      // Эскалация: переводим тред в escalated, отвечаем заглушкой.
      await tenantQuery(
        `UPDATE tenant.support_threads SET status='escalated', updated_at=now(), user_id=$1, user_name=$2 WHERE id=$3`,
        [session?.user_id || null, session?.name || session?.email || null, thread.id]
      );
      const reply = "Спасибо! Передал ваш вопрос команде поддержки. Мы ответим в этом чате в течение рабочего дня. 🙌";
      aiMsg = await tenantQuery(
        `INSERT INTO tenant.support_messages (cabinet_id, thread_id, role, content, by_ai)
         VALUES (current_setting('app.cabinet_id')::bigint, $1, 'assistant', $2, false)
         RETURNING id, role, content, by_ai`,
        [thread.id, reply]
      );
      aiMsg = aiMsg[0];
    } else if (llmAvailable()) {
      // 3) AI-ответ. Контекст: последние ~8 сообщений треда (для связности диалога).
      const history = await tenantQuery(
        `SELECT role, content FROM tenant.support_messages
         WHERE thread_id=$1 ORDER BY id DESC LIMIT 8`,
        [thread.id]
      );
      const dialog = history.reverse().map((m) => `${m.role === "user" ? "Пользователь" : "Ассистент"}: ${m.content}`).join("\n");
      const prompt = `${dialog}\n\nПользователь: ${text}\nАссистент:`;
      const aiText = await askSmart(prompt, { system: SUPPORT_SYSTEM_PROMPT, maxTokens: 600, temperature: 0.5 });

      if (aiText) {
        aiMsg = await tenantQuery(
          `INSERT INTO tenant.support_messages (cabinet_id, thread_id, role, content, by_ai)
           VALUES (current_setting('app.cabinet_id')::bigint, $1, 'assistant', $2, true)
           RETURNING id, role, content, by_ai`,
          [thread.id, aiText]
        );
        aiMsg = aiMsg[0];
      } else {
        // AI недоступен/ошибся → эскалация (fallback на человека).
        await tenantQuery(
          `UPDATE tenant.support_threads SET status='escalated', updated_at=now() WHERE id=$1`,
          [thread.id]
        );
        const reply = "Сейчас не могу ответить автоматически — передал ваш вопрос команде поддержки, ответим в течение дня.";
        aiMsg = await tenantQuery(
          `INSERT INTO tenant.support_messages (cabinet_id, thread_id, role, content, by_ai)
           VALUES (current_setting('app.cabinet_id')::bigint, $1, 'assistant', $2, false)
           RETURNING id, role, content, by_ai`,
          [thread.id, reply]
        );
        aiMsg = aiMsg[0];
      }
    } else {
      // LLM не настроен вообще → эскалация.
      await tenantQuery(
        `UPDATE tenant.support_threads SET status='escalated', updated_at=now() WHERE id=$1`,
        [thread.id]
      );
      const reply = "Спасибо за обращение! Команда поддержки ответит вам в этом чате в течение рабочего дня.";
      aiMsg = await tenantQuery(
        `INSERT INTO tenant.support_messages (cabinet_id, thread_id, role, content, by_ai)
         VALUES (current_setting('app.cabinet_id')::bigint, $1, 'assistant', $2, false)
         RETURNING id, role, content, by_ai`,
        [thread.id, reply]
      );
      aiMsg = aiMsg[0];
    }

    // Обновим updated_at треда.
    await tenantQuery(`UPDATE tenant.support_threads SET updated_at=now() WHERE id=$1`, [thread.id]);

    const status = await tenantQuery(`SELECT status FROM tenant.support_threads WHERE id=$1`, [thread.id]);
    return NextResponse.json({
      userMessage: userMsg[0],
      aiMessage: aiMsg,
      threadStatus: status[0]?.status,
    });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
});

export const PATCH = withCabinet(async (req, { cabinet }) => {
  const { action } = await req.json();
  if (action === "resolve") {
    const rows = await tenantQuery(
      `UPDATE tenant.support_threads SET status='closed', updated_at=now()
       WHERE status IN ('ai','escalated') RETURNING id`
    );
    return NextResponse.json({ ok: true, resolved: rows.length });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}, { requireRole: "manager" });
