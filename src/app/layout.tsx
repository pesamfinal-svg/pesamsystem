import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth/AuthContext";

// 1. ZMIANA: Dodaliśmy link do manifest.json w metadanych Next.js
export const metadata: Metadata = {
  title: "PESAM — System Zarządzania Magazynem",
  manifest: "/manifest.json",
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

        {/* 2. ZMIANA: Skrypt rejestrujący Service Worker dla trybu offline PWA na telefonach */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/sw.js').then(function(reg) {
                    console.log('PESAM PWA SW zarejestrowany:', reg.scope);
                  }).catch(function(err) {
                    console.log('PESAM PWA SW błąd rejestracji:', err);
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