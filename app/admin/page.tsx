import { readData } from '@/lib/data-store';
import { AdminForm } from './AdminForm';

export const dynamic = 'force-dynamic';

export default function AdminPage() {
  const data = readData();
  return <AdminForm initialData={data} />;
}
