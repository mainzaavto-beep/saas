import BonusPage from './BonusPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <BonusPage cabinetId={Number(params.id)} />;
}
