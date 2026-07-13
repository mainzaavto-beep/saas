import TeamPage from './TeamPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <TeamPage cabinetId={Number(params.id)} />;
}
