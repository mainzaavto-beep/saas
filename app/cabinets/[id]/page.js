// app/cabinets/[id]/page.js — Главная кабинета.
// Серверный компонент: данные через overview API (withCabinet/RLS).
import OverviewClient from './OverviewClient';

export const dynamic = 'force-dynamic';

export default async function CabinetPage({ params, searchParams }) {
  const cabinetId = Number(params.id);
  const from = searchParams?.from || new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const to = searchParams?.to || new Date().toISOString().slice(0, 10);

  return <OverviewClient cabinetId={cabinetId} from={from} to={to} />;
}
