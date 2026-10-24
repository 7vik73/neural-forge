import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Neural Forge — Your local workflow studio',
  description: 'Build useful automations with a little guidance and local AI.',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
