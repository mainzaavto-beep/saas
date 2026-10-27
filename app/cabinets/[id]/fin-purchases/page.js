import OrdersPage from './OrdersPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <OrdersPage cabinetId={Number(params.id)} />;
}
