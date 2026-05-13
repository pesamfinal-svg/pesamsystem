import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  // Sprawdzamy czy użytkownik ma token autoryzacji
  // Firebase Auth w Next.js często przechowuje sesję w cookies
  const session = request.cookies.get('__session');

  // Jeśli nie ma sesji i próbujemy wejść na stronę wewnątrz folderu (dashboard)
  if (!session && (request.nextUrl.pathname.startsWith('/dashboard') || request.nextUrl.pathname.startsWith('/admin'))) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  
  return NextResponse.next();
}

// Definiujemy, które trasy mają być sprawdzane
export const config = {
  matcher:['/dashboard/:path*', '/admin/:path*'],
};
