import SelfBuyoutsPage from './SelfBuyoutsPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <SelfBuyoutsPage cabinetId={Number(params.id)} />;
}
