import RnpPage from "./RnpPage";

export default async function Page({ params }) {
  return <RnpPage cabinetId={Number(params.id)} />;
}
