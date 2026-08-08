// /onboarding — создание проекта. Обёртка проверяет подтверждение адреса:
// без него POST /shops всё равно откажет, и клиент заполнил бы форму впустую.
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session.js';
import { query } from '@/lib/db.js';
import OnboardingPage from './OnboardingPage.jsx';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const session = await getSession();
  if (!session?.user_id) redirect('/login');
  const rows = await query(
    `SELECT (email_verified_at IS NOT NULL) AS verified FROM auth.users WHERE user_id = $1`,
    [session.user_id]
  );
  if (!rows[0]?.verified) redirect('/verify-pending');
  return <OnboardingPage />;
}
