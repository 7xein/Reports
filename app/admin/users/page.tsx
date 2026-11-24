import { getCurrentUser } from '@/lib/auth';
import { listUsers, UserStoreError } from '@/lib/users';
import { sortUsersForAdmin } from '@/lib/user-admin';
import type { PublicUser } from '@/lib/access';
import { UsersAdmin } from './UsersAdmin';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  const me = await getCurrentUser();
  let users: PublicUser[] = [];
  let loadError: string | null = null;
  try {
    users = sortUsersForAdmin(await listUsers());
  } catch (err) {
    console.error('[admin/users] could not list users:', err);
    loadError = err instanceof UserStoreError ? err.message : 'Could not load users. Please refresh.';
  }
  return <UsersAdmin initialUsers={users} currentEmail={me?.email ?? ''} loadError={loadError} />;
}
