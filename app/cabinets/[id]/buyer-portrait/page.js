import BuyerPortraitPage from "./BuyerPortraitPage";

export const dynamic = "force-dynamic";

export default async function Page({ params }) {
  return <BuyerPortraitPage cabinetId={Number(params.id)} />;
}
