import DeliveriesPage from "./DeliveriesPage";
export const dynamic = "force-dynamic";
export default async function Page({ params }) {
  return <DeliveriesPage cabinetId={Number(params.id)} />;
}
