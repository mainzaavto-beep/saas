import PurchasePlanPage from './PurchasePlanPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <PurchasePlanPage cabinetId={Number(params.id)} />;
}
