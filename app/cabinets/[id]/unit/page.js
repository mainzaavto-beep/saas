import UnitPage from "./UnitPage";
export default async function Page({ params }) {
  return <UnitPage cabinetId={Number(params.id)} />;
}
