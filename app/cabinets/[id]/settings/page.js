import SettingsPage from './SettingsPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <SettingsPage cabinetId={Number(params.id)} />;
}
