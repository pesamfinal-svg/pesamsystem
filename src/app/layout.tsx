import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth/AuthContext";

// Poprawny sposób definiowania meta tagów dla PWA w Next.js
export const metadata: Metadata = {
  title: "PESAM — System Zarządzania Magazynem",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "PESAM Voice"
  },
};

// Kolor motywu został wydzielony do osobnego obiektu (standard Next.js)
export const viewport: Viewport = {
  themeColor: "#0f172a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pl">
      <body>
        <AuthProvider>
          {children}
        </AuthProvider>

        {/* Skrypt rejestrujący Service Worker dla całego systemu */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/sw.js', { scope: '/' })
                    .then(function(reg) {
                      console.log('PESAM SW zarejestrowany:', reg.scope);
                    })
                    .catch(function(err) {
                      console.error('PESAM SW błąd:', err);
                    });

                  navigator.serviceWorker.addEventListener('message', function(event) {
                    if (event.data && event.data.type === 'SW_UPDATED') {
                      window.location.reload();
                    }
                  });
                });
              }
            `
          }}
        />
      </body>
    </html>
  );
}