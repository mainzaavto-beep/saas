import PnlPage from "./PnlPage";
export default async function Page({ params }) {
  return <PnlPage cabinetId={Number(params.id)} />;
}
