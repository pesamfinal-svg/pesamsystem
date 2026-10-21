import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "PESAM Plac & Resztki",
  description: "Mobilny magazyn resztek budowlanych i obchód placu",
  manifest: "/manifest-plac.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "PESAM Plac",
  },
  icons: {
    icon: "/icon-plac.svg",
    apple: "/icon-plac.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#020617",
};

export default function PlacLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
