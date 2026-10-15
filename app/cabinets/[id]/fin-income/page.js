import IncomePage from './IncomePage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <IncomePage cabinetId={Number(params.id)} />;
}
