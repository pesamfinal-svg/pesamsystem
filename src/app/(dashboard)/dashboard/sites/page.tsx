// src/app/(dashboard)/sites/page.tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import { collection, getDocs, doc, setDoc, deleteDoc, query, orderBy, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions"; // <-- DODANO IMPORT UPRAWNIEŃ
import { useRouter } from "next/navigation";

interface Site {
    id: string;
    name: string;
    location: string;
    status: "active" | "completed";
    createdAt: string;
}

export default function SitesManagementPage() {
    const { user } = useAuth();
    const router = useRouter();

    const [sites, setSites] = useState<Site[]>([]);
    const [loading, setLoading] = useState(true);

    // Stan modala
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingSite, setEditingSite] = useState<Site | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const [formData, setFormData] = useState({
        name: "",
        location: "",
        status: "active" as "active" | "completed"
    });

    // Weryfikacja, czy użytkownik ma prawo zarządzać budowami (manageSites)
    const canManageSites = user ? hasPermission("manageSites", user.rolePermissions, user.permissionOverrides) : false;

    // ZABEZPIECZENIE STRONY: Wywala z niej każdego bez odpowiedniego uprawnienia
    useEffect(() => {
        if (user && !canManageSites) {
            alert("Brak uprawnień do zarządzania słownikiem budów.");
            router.push("/dashboard");
        }
    }, [user, canManageSites, router]);

    const fetchSites = useCallback(async () => {
        setLoading(true);
        try {
            const q = query(collection(db, "sites"), orderBy("name", "asc"));
            const querySnapshot = await getDocs(q);
            const sitesData = querySnapshot.docs.map(d => ({
                id: d.id,
                ...d.data()
            })) as Site[];
            setSites(sitesData);
        } catch (error) {
            console.error("Błąd pobierania budów:", error);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (canManageSites) {
            fetchSites();
        }
    }, [canManageSites, fetchSites]);

    const openModal = (s?: Site) => {
        if (s) {
            setEditingSite(s);
            setFormData({ name: s.name, location: s.location, status: s.status });
        } else {
            setEditingSite(null);
            setFormData({ name: "", location: "", status: "active" });
        }
        setIsModalOpen(true);
    };

    const handleSaveSite = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canManageSites) return; // Podwójne zabezpieczenie

        setIsSubmitting(true);
        try {
            if (editingSite) {
                // Edycja
                await updateDoc(doc(db, "sites", editingSite.id), {
                    name: formData.name,
                    location: formData.location,
                    status: formData.status
                });
            } else {
                // Nowa budowa
                const newSiteRef = doc(collection(db, "sites"));
                await setDoc(newSiteRef, {
                    name: formData.name,
                    location: formData.location,
                    status: formData.status,
                    createdAt: new Date().toISOString()
                });
            }
            setIsModalOpen(false);
            fetchSites();
        } catch (error) {
            alert("Wystąpił błąd podczas zapisu.");
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDeleteSite = async (id: string, name: string) => {
        if (!canManageSites) return;

        if (confirm(`⚠️ Czy na pewno chcesz TRWALE USUNĄĆ budowę: ${name}?\n\nTej operacji nie da się cofnąć.`)) {
            try {
                await deleteDoc(doc(db, "sites", id));
                fetchSites();
            } catch (error) {
                alert("Nie udało się usunąć budowy.");
            }
        }
    };

    // Jeśli user nie ma uprawnień i jest w trakcie przekierowywania - nie renderuj UI
    if (!canManageSites) return null;

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto animate-fade-in">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800">Słownik Budów</h1>
                    <p className="text-slate-500 text-sm mt-1">Dodawaj aktywne projekty, do których przypisany będzie sprzęt</p>
                </div>
                {/* Przycisk schowany za uprawnieniem (w tym pliku i tak sprawdzamy dostęp do całej strony, ale to dobra praktyka) */}
                {canManageSites && (
                    <button
                        onClick={() => openModal()}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium shadow-sm transition"
                    >
                        + Dodaj Nową Budowę
                    </button>
                )}
            </div>

            {loading ? (
                <div className="p-10 text-center text-slate-400 italic">Ładowanie listy budów...</div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {sites.length === 0 ? (
                        <div className="col-span-full bg-slate-50 border-2 border-dashed border-slate-200 p-10 text-center rounded-2xl text-slate-400">
                            Brak budów w systemie. Dodaj pierwszą, aby móc przypisać do niej pracowników i sprzęt.
                        </div>
                    ) : (
                        sites.map((site) => (
                            <div key={site.id} className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex flex-col hover:shadow-md transition">
                                <div className="flex justify-between items-start mb-2">
                                    <h3 className="font-bold text-lg text-slate-800">{site.name}</h3>
                                    <span className={`text-[10px] font-bold px-2 py-1 rounded-full uppercase ${site.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                                        {site.status === 'active' ? 'Aktywna' : 'Zakończona'}
                                    </span>
                                </div>
                                <p className="text-sm text-slate-500 flex-grow mb-6">📍 {site.location}</p>

                                <div className="flex justify-between items-center pt-4 border-t border-slate-50">
                                    {canManageSites && (
                                        <>
                                            <button
                                                onClick={() => openModal(site)}
                                                className="text-blue-600 hover:text-blue-800 text-sm font-bold"
                                            >
                                                Edytuj
                                            </button>
                                            <button
                                                onClick={() => handleDeleteSite(site.id, site.name)}
                                                className="text-red-400 hover:text-red-600 text-xs"
                                            >
                                                Usuń trwale
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>
                        ))
                    )}
                </div>
            )}

            {/* Modal Formularza */}
            {isModalOpen && canManageSites && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden animate-fade-in">
                        <div className="p-6 border-b bg-slate-50 flex justify-between items-center">
                            <h2 className="text-xl font-bold text-slate-800">
                                {editingSite ? "Edycja Budowy" : "Nowa Budowa"}
                            </h2>
                            <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600 text-2xl">&times;</button>
                        </div>

                        <form onSubmit={handleSaveSite} className="p-6 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Nazwa inwestycji</label>
                                <input
                                    type="text"
                                    required
                                    value={formData.name}
                                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                                    className="w-full p-2 border rounded-lg outline-none focus:ring-2 focus:ring-blue-600"
                                    placeholder="np. SIM Wierzchosławice"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Lokalizacja (Adres)</label>
                                <input
                                    type="text"
                                    required
                                    value={formData.location}
                                    onChange={e => setFormData({ ...formData, location: e.target.value })}
                                    className="w-full p-2 border rounded-lg outline-none focus:ring-2 focus:ring-blue-600"
                                    placeholder="np. ul. Długa 12, Tarnów"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Status projektu</label>
                                <select
                                    value={formData.status}
                                    onChange={e => setFormData({ ...formData, status: e.target.value as any })}
                                    className="w-full p-2 border rounded-lg bg-white outline-none"
                                >
                                    <option value="active">Aktywna (Sprzęt pracuje)</option>
                                    <option value="completed">Zakończona (Archiwalna)</option>
                                </select>
                            </div>

                            <div className="pt-6 flex justify-end gap-3">
                                <button type="button" onClick={() => setIsModalOpen(false)} className="px-4 py-2 text-slate-500">Anuluj</button>
                                <button
                                    type="submit"
                                    disabled={isSubmitting}
                                    className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg shadow-md disabled:bg-blue-300"
                                >
                                    {isSubmitting ? "Zapisywanie..." : "Zapisz Budowę"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}