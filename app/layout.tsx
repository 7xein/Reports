import './globals.css';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NavigationProgress } from '@/components/NavigationProgress';

export const metadata: Metadata = {
  title: 'EVS Reports',
  description: 'EVS Regional Operations Dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <Suspense fallback={null}>
          <NavigationProgress />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
