import TimingPage from './TimingPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <TimingPage cabinetId={Number(params.id)} />;
}
