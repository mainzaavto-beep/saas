import BalancePage from './BalancePage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <BalancePage cabinetId={Number(params.id)} />;
}
