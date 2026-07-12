import OrdersPage from "./OrdersPage";
export default async function Page({ params }) {
  return <OrdersPage cabinetId={Number(params.id)} />;
}
