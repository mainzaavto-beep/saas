import ReviewsPage from "./ReviewsPage";
export default async function Page({ params }) {
  return <ReviewsPage cabinetId={Number(params.id)} />;
}
