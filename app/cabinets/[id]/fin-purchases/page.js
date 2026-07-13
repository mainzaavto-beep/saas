import PurchasesPage from './PurchasesPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <PurchasesPage cabinetId={Number(params.id)} />;
}
