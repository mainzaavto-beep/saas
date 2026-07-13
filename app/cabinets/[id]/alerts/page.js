import AlertsPage from './AlertsPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <AlertsPage cabinetId={Number(params.id)} />;
}
