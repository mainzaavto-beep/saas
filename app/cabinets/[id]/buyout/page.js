import BuyoutPage from "./BuyoutPage";
export const dynamic = "force-dynamic";
export default async function Page({ params }) {
  return <BuyoutPage cabinetId={Number(params.id)} />;
}
