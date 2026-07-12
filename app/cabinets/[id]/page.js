// app/cabinets/[id]/page.js — Главная кабинета.
// Серверный компонент: данные через overview API (withCabinet/RLS).
// Период/МП теперь управляются внутри OverviewClient (переключатель).
import OverviewClient from './OverviewClient';

export const dynamic = 'force-dynamic';

export default async function CabinetPage({ params }) {
  const cabinetId = Number(params.id);
  return <OverviewClient cabinetId={cabinetId} />;
}
