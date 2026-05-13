"use client";

import { useAuth } from "@/lib/auth/AuthContext";
import { useRouter, usePathname } from "next/navigation";
import { useEffect } from "react";
import Link from "next/link";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
    const { user, loading, signOut } = useAuth();
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        if (!loading && !user) router.push("/login");
    }, [user, loading, router]);

    if (loading || !user) return <div className="p-10 text-center">Ładowanie systemu...</div>;

    const handleLogout = async () => {
        await signOut();
        router.push("/login");
    };

    const menuItems = [
        { name: "Pulpit", path: "/dashboard", icon: "📊" },
        { name: "Sklep (Zamówienia)", path: "/dashboard/shop", icon: "🛒" },
        { name: "Protokoły", path: "/dashboard/protocols", icon: "📝" },
        { name: "Katalog Sprzętu", path: "/dashboard/inventory", icon: "📦" },
        { name: "Budowy", path: "/dashboard/sites", icon: "🏗️" },
        { name: "Zarządzanie Pracownikami", path: "/dashboard/admin/users", icon: "👥" },
        { name: "Role i Uprawnienia", path: "/dashboard/admin/roles", icon: "🔑" },
    ];

    return (
        <div className="flex h-screen bg-slate-100">
            <aside className="w-64 bg-slate-900 text-white flex flex-col shadow-xl">
                <div className="p-6 border-b border-slate-800">
                    <h1 className="text-2xl font-extrabold text-blue-500 tracking-widest">PESAM</h1>
                </div>
                <nav className="flex-1 py-4 px-3 space-y-2 overflow-y-auto">
                    {menuItems.map((item) => (
                        <Link key={item.path} href={item.path}>
                            <div className={`flex items-center gap-3 px-4 py-3 rounded-lg transition cursor-pointer ${pathname.startsWith(item.path) && item.path !== "/dashboard" || pathname === item.path
                                    ? "bg-blue-600 text-white"
                                    : "text-slate-300 hover:bg-slate-800 hover:text-white"
                                }`}>
                                <span>{item.icon}</span>
                                <span className="font-medium text-sm">{item.name}</span>
                            </div>
                        </Link>
                    ))}
                </nav>
            </aside>

            <div className="flex-1 flex flex-col overflow-hidden">
                <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6">
                    <h2 className="font-semibold text-slate-700">System Magazynowy</h2>
                    <div className="flex items-center gap-4">
                        <span className="text-sm text-slate-600">Zalogowany: <b>{user.email}</b></span>
                        <button onClick={handleLogout} className="px-4 py-2 bg-red-50 text-red-600 rounded-md hover:bg-red-100 text-sm font-bold transition">
                            Wyloguj
                        </button>
                    </div>
                </header>
                <main className="flex-1 overflow-auto">
                    {children}
                </main>
            </div>
        </div>
    );
}