'use client';
import { AuthView } from '../../src/accounts-view';
export default function Page() {
  return <AuthView onReady={() => window.location.assign('/')} />;
}
