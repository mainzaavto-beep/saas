import MpStockPage from './MpStockPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <MpStockPage cabinetId={Number(params.id)} />;
}
