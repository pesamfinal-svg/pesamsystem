// src/lib/auth/AuthContext.tsx
"use client";

import {
    createContext,
    useContext,
    useEffect,
    useState,
    type ReactNode,
} from "react";
import {
    onAuthStateChanged,
    signInWithEmailAndPassword,
    signOut as firebaseSignOut,
    type User,
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase/config";

// ZAKTUALIZOWANY INTERFEJS
export interface PesamUser {
    uid: string;
    email: string;
    firstName: string;
    lastName: string;
    roleId: string;
    roleName?: string;
    rolePermissions: Record<string, boolean>; // Dane z kolekcji 'roles'
    permissionOverrides: Record<string, boolean>; // Dane z dokumentu użytkownika
    assignedSites?: string[];
}

interface AuthContextType {
    user: PesamUser | null;
    firebaseUser: User | null;
    loading: boolean;
    signIn: (email: string, password: string) => Promise<void>;
    signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<PesamUser | null>(null);
    const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
            setLoading(true);
            if (fbUser) {
                setFirebaseUser(fbUser);
                try {
                    // 1. Pobierz dokument użytkownika
                    const userDoc = await getDoc(doc(db, "users", fbUser.uid));
                    if (userDoc.exists()) {
                        const userData = userDoc.data();

                        let fetchedRoleName = "Brak roli";
                        let fetchedRolePermissions = {};

                        // 2. Pobierz dokument roli na podstawie roleId użytkownika
                        if (userData.roleId) {
                            const roleDoc = await getDoc(doc(db, "roles", userData.roleId));
                            if (roleDoc.exists()) {
                                fetchedRoleName = roleDoc.data().name || "Bez nazwy";
                                fetchedRolePermissions = roleDoc.data().permissions || {};
                            }
                        }

                        // 3. Złóż to w jeden obiekt użytkownika PESAM
                        setUser({
                            uid: fbUser.uid,
                            email: fbUser.email!,
                            roleName: fetchedRoleName,
                            rolePermissions: fetchedRolePermissions,
                            permissionOverrides: userData.permissionOverrides || {},
                            ...userData
                        } as PesamUser);
                    } else {
                        setUser(null);
                    }
                } catch (error) {
                    console.error("Błąd pobierania profilu:", error);
                    setUser(null);
                }
            } else {
                setFirebaseUser(null);
                setUser(null);
            }
            setLoading(false);
        });
        return unsubscribe;
    }, []);

    const signIn = async (email: string, pass: string) => {
        await signInWithEmailAndPassword(auth, email, pass);
    };

    const signOut = async () => {
        await firebaseSignOut(auth);
    };

    return (
        <AuthContext.Provider value={{ user, firebaseUser, loading, signIn, signOut }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (!context) throw new Error("useAuth must be used within an AuthProvider");
    return context;
}