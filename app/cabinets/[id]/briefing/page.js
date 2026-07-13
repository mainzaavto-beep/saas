import BriefingPage from './BriefingPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <BriefingPage cabinetId={Number(params.id)} />;
}
