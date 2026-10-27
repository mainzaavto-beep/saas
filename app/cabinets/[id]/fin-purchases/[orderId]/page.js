import OrderPage from './OrderPage';

export const dynamic = 'force-dynamic';

export default async function Page({ params }) {
  return <OrderPage cabinetId={Number(params.id)} orderId={Number(params.orderId)} />;
}
