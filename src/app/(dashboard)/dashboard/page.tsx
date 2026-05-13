// src/app/(dashboard)/dashboard/page.tsx
"use client";

import { useAuth } from "@/lib/auth/AuthContext";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function DashboardPage() {
    const { user, firebaseUser, loading } = useAuth();
    const router = useRouter();

    // Zabezpieczenie przed brakiem sesji
    useEffect(() => {
        if (!loading && !firebaseUser) {
            router.push("/login");
        }
    }, [firebaseUser, loading, router]);

    // Jeśli się ładuje, pokaż cokolwiek, żeby nie było białego ekranu
    if (loading) {
        return <div className="p-10 text-center text-slate-500">Ładowanie panelu...</div>;
    }

    // Jeśli nie zalogowany, ukryj render
    if (!firebaseUser) return null;

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto animate-fade-in">
            <div className="flex justify-between items-center mb-10 border-b border-slate-200 pb-4">
                <h1 className="text-3xl font-bold text-slate-800">
                    Witaj, {user?.firstName || firebaseUser.email}! 👋
                </h1>
            </div>

            {!user ? (
                <div className="bg-yellow-50 border border-yellow-200 p-6 rounded-lg mb-6 shadow-sm">
                    <h3 className="font-bold text-yellow-800 text-lg">Brak profilu w bazie!</h3>
                    <p className="text-yellow-700 mt-2">
                        Jesteś poprawnie zalogowany do systemu, ale Twoje konto nie posiada jeszcze profilu w bazie <b>Firestore (kolekcja 'users')</b>.
                        System nie wie, jakie masz uprawnienia, dlatego na razie widzisz tylko ten ekran.
                    </p>
                </div>
            ) : (
                <div className="bg-green-50 border border-green-200 p-6 rounded-lg mb-6 shadow-sm flex items-center justify-between">
                    <div>
                        <h3 className="font-bold text-green-800 text-lg mb-1">Profil znaleziony!</h3>
                        <p className="text-green-700">
                            Twoja rola w systemie to: <b className="text-green-900 bg-green-100 px-2 py-1 rounded">{user.roleName || user.roleId}</b>
                        </p>
                    </div>
                </div>
            )}

            {/* Skrócone statystyki - tymczasowe */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
                <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 hover:shadow-md transition">
                    <p className="text-sm text-slate-500 font-medium">Aktywne budowy</p>
                    <p className="text-3xl font-bold text-slate-800 mt-2">0</p>
                </div>
                <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 hover:shadow-md transition">
                    <p className="text-sm text-slate-500 font-medium">Sprzęt w naprawie</p>
                    <p className="text-3xl font-bold text-slate-800 mt-2">0</p>
                </div>
                <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 hover:shadow-md transition">
                    <p className="text-sm text-slate-500 font-medium">Oczekujące protokoły</p>
                    <p className="text-3xl font-bold text-slate-800 mt-2">0</p>
                </div>
            </div>
        </div>
    );
}