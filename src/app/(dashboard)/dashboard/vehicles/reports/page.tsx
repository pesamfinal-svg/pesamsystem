// src/app/(dashboard)/vehicles/reports/page.tsx
"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";

export default function FleetReportsHub() {
    const { user } = useAuth();
    const [loading, setLoading] = useState(false);

    // Zabezpieczenie uprawnień do raportów
    const canView = user ? hasPermission("viewVehicles", user.rolePermissions, user.permissionOverrides) : false;

    if (!canView) return <div className="p-10 text-center text-red-500 font-bold">Brak uprawnień do przeglądania raportów floty.</div>;

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto animate-fade-in space-y-8">
            {/* Nagłówek z przyciskiem powrotu */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-200 pb-6">
                <div>
                    <div className="flex items-center gap-3">
                        <Link href="/dashboard/vehicles" className="text-slate-400 hover:text-slate-800 text-sm font-bold transition flex items-center gap-1">
                            ⬅ Powrót do Floty
                        </Link>
                    </div>
                    <h1 className="text-3xl font-black text-slate-800 tracking-tight mt-2">📊 Raporty i Analizy Floty</h1>
                    <p className="text-sm text-slate-500 mt-1">Wykresy kosztów, analiza niezawodności pojazdów oraz sztuczna inteligencja.</p>
                </div>
            </div>

            {/* MIEJSCE NA PRZYSZŁE WYKRESY (KARTY PODGLĄDU) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-white border p-6 rounded-3xl shadow-sm h-[350px] flex items-center justify-center text-center text-slate-400">
                    <div>
                        <span className="text-4xl block mb-2">📈</span>
                        <p className="font-bold text-slate-700">Koszty wg pojazdu</p>
                        <p className="text-xs mt-1">Wykres słupkowy zostanie dodany w kolejnym kroku.</p>
                    </div>
                </div>

                <div className="bg-white border p-6 rounded-3xl shadow-sm h-[350px] flex items-center justify-center text-center text-slate-400">
                    <div>
                        <span className="text-4xl block mb-2">📅</span>
                        <p className="font-bold text-slate-700">Liczba napraw w czasie</p>
                        <p className="text-xs mt-1">Wykres liniowy zostanie dodany w kolejnym kroku.</p>
                    </div>
                </div>

                <div className="bg-white border p-6 rounded-3xl shadow-sm h-[350px] flex items-center justify-center text-center text-slate-400">
                    <div>
                        <span className="text-4xl block mb-2">🛡️</span>
                        <p className="font-bold text-slate-700">Ranking niezawodności</p>
                        <p className="text-xs mt-1">Wykresy MTBF/MDBF zostaną dodane w kolejnym kroku.</p>
                    </div>
                </div>

                <div className="bg-white border p-6 rounded-3xl shadow-sm h-[350px] flex items-center justify-center text-center text-slate-400">
                    <div>
                        <span className="text-4xl block mb-2">🤖</span>
                        <p className="font-bold text-slate-700">Asystent AI Floty</p>
                        <p className="text-xs mt-1">Rozmowa ze sztuczną inteligencją o stanie floty zostanie dodana w kolejnym kroku.</p>
                    </div>
                </div>
            </div>
        </div>
    );
}