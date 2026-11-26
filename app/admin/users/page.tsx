import { getCurrentUser } from '@/lib/auth';
import { listUsers, UserStoreError } from '@/lib/users';
import { kpiPersonOptions, sortUsersForAdmin, type KpiPersonOption } from '@/lib/user-admin';
import { readData } from '@/lib/data-store';
import { withKpiDefaults } from '@/lib/types';
import type { PublicUser } from '@/lib/access';
import { UsersAdmin } from './UsersAdmin';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  const me = await getCurrentUser();
  let users: PublicUser[] = [];
  let kpiPeople: KpiPersonOption[] = [];
  let loadError: string | null = null;
  try {
    users = sortUsersForAdmin(await listUsers());
  } catch (err) {
    console.error('[admin/users] could not list users:', err);
    loadError = err instanceof UserStoreError ? err.message : 'Could not load users. Please refresh.';
  }
  try {
    kpiPeople = kpiPersonOptions(withKpiDefaults((await readData()).kpiConfig).saRoster);
  } catch (err) {
    console.error('[admin/users] could not read the KPI roster:', err);
    loadError ??= 'Could not load the KPI roster. Please refresh.';
  }
  return (
    <UsersAdmin initialUsers={users} kpiPeople={kpiPeople} currentEmail={me?.email ?? ''} loadError={loadError} />
  );
}
