import OrderMatrixPage from "./OrderMatrixPage";
export const dynamic = "force-dynamic";
export default async function Page({ params }) {
  return <OrderMatrixPage cabinetId={Number(params.id)} />;
}
