// src/app/(dashboard)/dashboard/admin/roles/page.tsx
"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, doc, setDoc, deleteDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { ALL_PERMISSIONS, hasPermission } from "@/lib/auth/permissions";
import { useAuth } from "@/lib/auth/AuthContext";
import { useRouter } from "next/navigation";

// Interfejs opisujący pojedynczą rolę w Firestore
interface Role {
    id: string;
    name: string;
    description: string;
    permissions: Record<string, boolean>;
}

export default function RolesManagementPage() {
    const { user } = useAuth();
    const router = useRouter();

    const [roles, setRoles] = useState<Role[]>([]);
    const [loading, setLoading] = useState(true);

    // Stan modala formularza
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingRole, setEditingRole] = useState<Role | null>(null);

    // Pola formularza
    const [formData, setFormData] = useState({
        name: "",
        description: "",
        permissions: {} as Record<string, boolean>
    });

    // Zabezpieczenie trasy: Wpuszcza tylko tych, co mają uprawnienie 'manageRoles'
    // Znika na stałe sztywne sprawdzanie słowa "admin"!
    useEffect(() => {
        if (user && !hasPermission("manageRoles", user.rolePermissions, user.permissionOverrides)) {
            alert("Brak uprawnień. Tylko osoby z uprawnieniem 'Zarządzanie rolami' mogą przeglądać tę stronę.");
            router.push("/dashboard");
        }
    }, [user, router]);

    // Pobieranie ról z Firestore
    const fetchRoles = async () => {
        setLoading(true);
        try {
            const querySnapshot = await getDocs(collection(db, "roles"));
            const rolesData = querySnapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            })) as Role[];
            setRoles(rolesData);
        } catch (error) {
            console.error("Błąd pobierania ról:", error);
            alert("Nie udało się pobrać ról.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchRoles();
    }, []);

    // Otwieranie modala (dodawanie lub edycja)
    const openModal = (role?: Role) => {
        if (role) {
            setEditingRole(role);
            setFormData({
                name: role.name,
                description: role.description,
                permissions: role.permissions || {}
            });
        } else {
            setEditingRole(null);
            setFormData({ name: "", description: "", permissions: {} });
        }
        setIsModalOpen(true);
    };

    // Zaznaczanie/odznaczanie uprawnień w formularzu
    const togglePermission = (permId: string) => {
        setFormData(prev => ({
            ...prev,
            permissions: {
                ...prev.permissions,
                [permId]: !prev.permissions[permId]
            }
        }));
    };

    // Zapisywanie roli do bazy Firestore
    const handleSaveRole = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            // Jeśli edytujemy - używamy istniejącego ID, w przeciwnym razie Firestore wygeneruje nowe
            const roleRef = editingRole ? doc(db, "roles", editingRole.id) : doc(collection(db, "roles"));

            await setDoc(roleRef, {
                name: formData.name,
                description: formData.description,
                permissions: formData.permissions
            });

            setIsModalOpen(false);
            fetchRoles(); // Odświeżenie listy po zapisie
        } catch (error) {
            console.error("Błąd zapisu:", error);
            alert("Nie udało się zapisać roli.");
        }
    };

    // Usuwanie roli z potwierdzeniem
    const handleDeleteRole = async (roleId: string) => {
        if (confirm("Czy na pewno chcesz usunąć tę rolę? Pamiętaj, by upewnić się, czy jacyś pracownicy jej nie używają.")) {
            try {
                await deleteDoc(doc(db, "roles", roleId));
                fetchRoles();
            } catch (error) {
                console.error("Błąd usuwania:", error);
                alert("Nie udało się usunąć roli.");
            }
        }
    };

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto animate-fade-in">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800">Zarządzanie Rolami</h1>
                    <p className="text-slate-500 text-sm mt-1">Twórz profile dostępu i decyduj, kto co widzi</p>
                </div>
                <button
                    onClick={() => openModal()}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition shadow-sm"
                >
                    + Dodaj nową rolę
                </button>
            </div>

            {/* Tabela ról */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                {loading ? (
                    <div className="p-10 text-center text-slate-500 flex flex-col items-center justify-center">
                        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-2"></div>
                        Ładowanie ról z bazy...
                    </div>
                ) : (
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-slate-50 border-b border-slate-200">
                                <th className="p-4 font-semibold text-slate-700">Nazwa Roli</th>
                                <th className="p-4 font-semibold text-slate-700">Opis (dla Ciebie)</th>
                                <th className="p-4 font-semibold text-slate-700 text-center">Aktywne uprawnienia</th>
                                <th className="p-4 font-semibold text-slate-700 text-right">Akcje</th>
                            </tr>
                        </thead>
                        <tbody>
                            {roles.length === 0 ? (
                                <tr>
                                    <td colSpan={4} className="p-8 text-center text-slate-500">Brak zdefiniowanych ról. Utwórz np. rolę "Kierownik Budowy".</td>
                                </tr>
                            ) : (
                                roles.map((role) => {
                                    const activePermsCount = Object.values(role.permissions || {}).filter(Boolean).length;
                                    return (
                                        <tr key={role.id} className="border-b border-slate-100 hover:bg-slate-50 transition">
                                            <td className="p-4 font-medium text-slate-800">{role.name}</td>
                                            <td className="p-4 text-slate-500">{role.description}</td>
                                            <td className="p-4 text-center">
                                                <span className="bg-blue-100 text-blue-700 px-3 py-1 rounded-full text-xs font-bold">
                                                    {activePermsCount}
                                                </span>
                                            </td>
                                            <td className="p-4 text-right space-x-2">
                                                <button onClick={() => openModal(role)} className="text-blue-600 hover:text-blue-800 font-medium text-sm px-2">
                                                    Edytuj
                                                </button>
                                                <button onClick={() => handleDeleteRole(role.id)} className="text-red-500 hover:text-red-700 font-medium text-sm px-2">
                                                    Usuń
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Modal - Dodawanie / Edycja Roli */}
            {isModalOpen && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden animate-fade-in">
                        <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                            <h2 className="text-xl font-bold text-slate-800">
                                {editingRole ? "Edytuj rolę" : "Tworzenie nowej roli"}
                            </h2>
                            <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600 text-2xl leading-none">&times;</button>
                        </div>

                        <form onSubmit={handleSaveRole} className="p-6 overflow-y-auto flex-1">
                            <div className="space-y-4 mb-8">
                                <div>
                                    <label className="block text-sm font-semibold text-slate-700 mb-1">Nazwa roli (np. Magazynier)</label>
                                    <input type="text" required value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-600 outline-none" />
                                </div>
                                <div>
                                    <label className="block text-sm font-semibold text-slate-700 mb-1">Krótki opis</label>
                                    <input type="text" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} placeholder="np. Zarządza całym magazynem, ale nie budowami" className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-600 outline-none" />
                                </div>
                            </div>

                            <div>
                                <h3 className="text-lg font-bold text-slate-800 mb-4 border-b pb-2">Uprawnienia dla tej roli</h3>
                                <p className="text-xs text-slate-500 mb-4">Zaznacz, do czego pracownicy przypisani do tej roli będą mieli dostęp.</p>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    {Object.entries(ALL_PERMISSIONS).map(([key, label]) => (
                                        <label key={key} className={`flex items-center p-3 border rounded-lg cursor-pointer transition ${formData.permissions[key] ? 'bg-blue-50 border-blue-200' : 'bg-white border-slate-200 hover:bg-slate-50'}`}>
                                            <input
                                                type="checkbox"
                                                className="w-5 h-5 text-blue-600 rounded border-gray-300 focus:ring-blue-500 mr-3"
                                                checked={!!formData.permissions[key]}
                                                onChange={() => togglePermission(key)}
                                            />
                                            <span className={`text-sm ${formData.permissions[key] ? 'font-semibold text-blue-900' : 'text-slate-700'}`}>
                                                {label}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </div>

                            <div className="mt-8 flex justify-end gap-3 pt-4 border-t border-slate-100">
                                <button type="button" onClick={() => setIsModalOpen(false)} className="px-5 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition">Anuluj</button>
                                <button type="submit" className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition shadow-sm">Zapisz rolę</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}