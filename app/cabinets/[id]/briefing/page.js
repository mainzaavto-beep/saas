import BriefingPage from "./BriefingPage";
export default async function Page({ params }) {
  return <BriefingPage cabinetId={Number(params.id)} />;
}
