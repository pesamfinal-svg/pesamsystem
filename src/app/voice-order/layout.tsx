import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "PESAM Voice — Dyktafon Budowy",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "PESAM Voice",
  },
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
};

export default function VoiceOrderLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
