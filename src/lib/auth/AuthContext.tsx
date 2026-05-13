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

// Definicja typu użytkownika
export interface PesamUser {
    uid: string;
    email: string;
    firstName: string;
    lastName: string;
    roleId: string;
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
                    const userDoc = await getDoc(doc(db, "users", fbUser.uid));
                    if (userDoc.exists()) {
                        setUser({ uid: fbUser.uid, email: fbUser.email!, ...userDoc.data() } as PesamUser);
                    } else {
                        console.error("Brak dokumentu użytkownika w Firestore!");
                        setUser(null);
                    }
                } catch (error) {
                    console.error("Błąd pobierania danych:", error);
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
    if (!context) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}