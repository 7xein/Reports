import { readData } from '@/lib/data-store';
import { AdminForm } from './AdminForm';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const data = await readData();
  return <AdminForm initialData={data} />;
}
