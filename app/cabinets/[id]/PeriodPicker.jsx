"use client";
import { useEffect, useMemo, useState } from "react";
import { C } from "@/lib/palette.js";

// Переиспользуемый выбор периода: гранулярность (день/неделя/месяц/год/
// интервал) + «якорь» + стрелки ‹/› + кнопка «Вчера», либо ручные
// date-инпуты для произвольного интервала.
//
// Эталон — app/cabinets/[id]/OverviewClient.jsx (блок GRANS, shiftPeriod,
// computePeriod, ymd, goPrev/goNext/goYesterday). Главная пока сидит на
// своей копии этой логики (не переведена на этот компонент) — бэклог:
// перевести Overview на PeriodPicker.
//
// API: <PeriodPicker value={{from,to}} onChange={({from,to,label,gran}) => ...} />
// Родитель хранит только from/to (value используется лишь как исходное
// сидирование полей «Интервала» при монтировании — источник правды по
// гранулярности/якорю живёт внутри компонента, как и в эталоне).
// Дефолт компонента — gran="month" (текущий месяц), КАК НА ГЛАВНОЙ
// (OverviewClient.jsx:93, тот же выбор — «первое впечатление» не должно
// сужаться с ~30 дней до 1 дня). Кнопка «Вчера» остаётся — быстрый переход
// на день (сегодня финансово недособран, конвенция панели, см. lib/period.js).
// defaultGran/defaultAnchor — пропы для переопределения стартовой
// гранулярности/якоря, если конкретной странице нужен другой дефолт.

const GRANS = [
  { id: "day", label: "День" },
  { id: "week", label: "Неделя" },
  { id: "month", label: "Месяц" },
  { id: "year", label: "Год" },
  { id: "custom", label: "Интервал" },
];

const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
const yesterday = () => ymd(new Date(Date.now() - 86400000));

// Сдвиг «якоря» периода (назад/вперёд) на 1 шаг гранулярности.
function shiftPeriod(gran, anchor, dir) {
  const [Y, M, D] = anchor.split("-").map(Number);
  const d = new Date(Y, M - 1, D);
  if (gran === "day") d.setDate(d.getDate() + dir);
  else if (gran === "week") d.setDate(d.getDate() + dir * 7);
  else if (gran === "month") d.setMonth(d.getMonth() + dir);
  else if (gran === "year") d.setFullYear(d.getFullYear() + dir);
  return ymd(d);
}

// Превратить (гранулярность, якорь) в {from,to,label}.
function computePeriod(gran, anchor) {
  const [Y, M, D] = anchor.split("-").map(Number);
  const d = new Date(Y, M - 1, D);
  let from, to, label;
  const fmtRu = (x) =>
    x.toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "numeric" });
  const fmtMon = (x) => x.toLocaleDateString("ru-RU", { month: "long", year: "numeric" });

  if (gran === "day") {
    from = to = ymd(d);
    label = d.toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" });
  } else if (gran === "week") {
    const wd = (d.getDay() + 6) % 7;
    const start = new Date(d);
    start.setDate(d.getDate() - wd);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    from = ymd(start);
    to = ymd(end);
    label = `${fmtRu(start)} – ${fmtRu(end)}`;
  } else if (gran === "month") {
    from = ymd(new Date(d.getFullYear(), d.getMonth(), 1));
    to = ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    label = fmtMon(d);
  } else {
    from = ymd(new Date(d.getFullYear(), 0, 1));
    to = ymd(new Date(d.getFullYear(), 11, 31));
    label = String(d.getFullYear());
  }
  return { from, to, label };
}

export default function PeriodPicker({ value, onChange, defaultGran = "month", defaultAnchor }) {
  const [gran, setGran] = useState(defaultGran);
  const [anchor, setAnchor] = useState(() => defaultAnchor || ymd(new Date()));
  // Поля «Интервала» — независимое состояние (как в эталоне), сидируются
  // один раз из value (если родитель его передал), иначе — «вчера».
  const [customFrom, setCustomFrom] = useState(() => value?.from || yesterday());
  const [customTo, setCustomTo] = useState(() => value?.to || yesterday());

  const period = useMemo(() => {
    if (gran === "custom") {
      const f = customFrom || yesterday();
      const t = customTo || yesterday();
      return { from: f, to: t, label: `${f} — ${t}` };
    }
    return computePeriod(gran, anchor);
  }, [gran, anchor, customFrom, customTo]);

  // Сообщаем родителю о периоде — при монтировании (дефолт «вчера») и при
  // каждом изменении. Родитель хранит только from/to (см. докстроку выше).
  useEffect(() => {
    onChange && onChange({ from: period.from, to: period.to, label: period.label, gran });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.from, period.to, gran]);

  const goPrev = () => setAnchor((a) => shiftPeriod(gran, a, -1));
  const goNext = () => setAnchor((a) => shiftPeriod(gran, a, +1));
  // Кнопка «Вчера»: обязательно переключаем гранулярность на «День» —
  // иначе при gran="month"/"week" смена якоря ничего не даст.
  const goYesterday = () => {
    setGran("day");
    setAnchor(yesterday());
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      {/* Гранулярность */}
      <div style={{ display: "flex", gap: 4, background: C.surfaceAlt, borderRadius: 10, padding: 3 }}>
        {GRANS.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => setGran(g.id)}
            style={{
              border: "none", padding: "6px 14px", borderRadius: 8, cursor: "pointer",
              fontFamily: "inherit", fontSize: 13, fontWeight: 600,
              background: gran === g.id ? C.accent : "transparent",
              color: gran === g.id ? "var(--accentInk)" : C.muted,
            }}
          >
            {g.label}
          </button>
        ))}
      </div>

      {/* Навигация периода (для пресетов — стрелки, для custom — date-инпуты) */}
      {gran === "custom" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="date" value={customFrom}
            max={customTo || undefined}
            onChange={(e) => setCustomFrom(e.target.value)}
            style={{ ...dateInputStyle, color: C.ink }}
          />
          <span style={{ color: C.faint, fontSize: 13 }}>—</span>
          <input
            type="date" value={customTo}
            min={customFrom || undefined}
            onChange={(e) => setCustomTo(e.target.value)}
            style={{ ...dateInputStyle, color: C.ink }}
          />
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <NavBtn onClick={goPrev} title="Предыдущий">‹</NavBtn>
          <span style={{ minWidth: 180, textAlign: "center", fontSize: 14, fontWeight: 600, color: C.ink }}>
            {period.label}
          </span>
          <NavBtn onClick={goNext} title="Следующий">›</NavBtn>
          <NavBtn onClick={goYesterday} title="Вчера">Вчера</NavBtn>
        </div>
      )}
    </div>
  );
}

function NavBtn({ children, onClick, title }) {
  return (
    <button type="button" onClick={onClick} title={title} style={{
      border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink,
      borderRadius: 8, padding: "5px 12px", cursor: "pointer",
      fontFamily: "inherit", fontSize: 14, fontWeight: 700, lineHeight: 1,
    }}>{children}</button>
  );
}

const dateInputStyle = {
  padding: "6px 10px", borderRadius: 8, border: `1px solid ${C.line}`,
  background: C.surfaceAlt, fontSize: 13, fontFamily: "inherit",
};
