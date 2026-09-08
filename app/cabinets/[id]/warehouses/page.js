// app/cabinets/[id]/warehouses/page.js — «Склады 2.0», этап 4 «Витрина» (задача 5 плана).
// Тонкая обёртка: SSR только читает params, всё остальное — на клиенте (WarehousesPage.jsx),
// как у соседних страниц (/shipments, /stocks). Suspense вокруг WarehousesPage — потому что
// внутри useSearchParams (App Router требует границу Suspense при статической генерации);
// force-dynamic уже даёт SSR-обход, но Suspense добавлен на случай, если build проверит билд-тайм.
import { Suspense } from "react";
import WarehousesPage from "./WarehousesPage";

export const dynamic = "force-dynamic";

export default async function Page({ params }) {
  const cabinetId = Number(params.id);
  return (
    <Suspense fallback={null}>
      <WarehousesPage cabinetId={cabinetId} />
    </Suspense>
  );
}
