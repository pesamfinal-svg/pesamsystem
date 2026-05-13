import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  // Tymczasowo przepuszczamy wszystkie żądania.
  // Zabezpieczeniami zajmują się teraz komponenty klienckie i useEffect.
  return NextResponse.next();
}

// Ograniczamy działanie proxy tylko do określonych ścieżek
export const config = {
  matcher: ['/dashboard/:path*', '/admin/:path*'],
};