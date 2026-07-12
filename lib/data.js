// Демо-данные продавца маркетплейсов.
// Когда подключим реальную БД, этот файл больше не понадобится —
// данные будет отдавать запрос в app/api/products/route.js.

async function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = {
  Одежда: ["Худи оверсайз", "Футболка хлопок", "Джинсы slim", "Платье миди", "Куртка-ветровка", "Носки, 5 пар"],
  Электроника: ["Наушники TWS", "Power bank 20000", "Кабель USB-C 1м", "Зарядка 65W", "Колонка портативная", "Подставка для телефона"],
  Дом: ["Органайзер для белья", "Контейнеры, набор 6", "Плед флисовый", "Светильник LED", "Полотенце махровое", "Коврик для ванной"],
  Красота: ["Сыворотка для лица", "Маски тканевые, 10 шт", "Крем для рук", "Шампунь 400 мл", "Палетка теней", "Масло для волос"],
  Спорт: ["Коврик для йоги", "Гантели 2 кг, пара", "Бутылка 750 мл", "Эспандер, набор", "Скакалка скоростная", "Фитнес-резинки, 5 шт"],
};
const CATS = Object.keys(NAMES);
const MARKETS = ["Wildberries", "Ozon", "Яндекс Маркет"];
const PRICE = {
  Одежда: [690, 3200],
  Электроника: [490, 4500],
  Дом: [350, 2600],
  Красота: [290, 2200],
  Спорт: [390, 2900],
};

export async function buildMockProducts() {
  const r = mulberry32(42);
  const rows = [];
  for (let i = 0; i < 42; i++) {
    const cat = CATS[Math.floor(r() * CATS.length)];
    const name = NAMES[cat][Math.floor(r() * NAMES[cat].length)];
    const market = MARKETS[Math.floor(r() * MARKETS.length)];
    const [lo, hi] = PRICE[cat];
    const price = Math.round((lo + r() * (hi - lo)) / 10) * 10;
    const cost = Math.round(price * (0.42 + r() * 0.28));
    const base = 1 + r() * 14;
    const daily = [];
    for (let d = 0; d < 30; d++) {
      const trend = 1 + (d / 30) * (r() * 0.6);
      daily.push(Math.max(0, Math.round(base * trend * (0.4 + r() * 1.3))));
    }
    rows.push({
      id: i,
      art: `${cat[0]}${market[0]}-${(100000 + Math.floor(r() * 899999)).toString()}`,
      name,
      cat,
      market,
      price,
      cost,
      stock: Math.floor(r() * 480),
      returnRate: 0.01 + r() * 0.07,
      daily,
    });
  }
  return rows;
}
