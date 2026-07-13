import FfStockPage from './FfStockPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <FfStockPage cabinetId={Number(params.id)} />;
}
