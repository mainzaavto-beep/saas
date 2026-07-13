import PlanPage from './PlanPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <PlanPage cabinetId={Number(params.id)} />;
}
