// src/app/api/claims-email/route.ts
import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import nodemailer from 'nodemailer';

interface EmailPayload {
    type: "NEW_CLAIM" | "CLAIM_FINISHED" | "VERDICT_DYREKTOR" | "VERDICT_FINAL" | "REMINDER_1" | "REMINDER_2" | "REFUSAL";
    claimId: string;
    inventoryName: string;
    inventoryNumber: string;
    siteName: string;
    managerName?: string;
    managerUid?: string;
    reportText?: string;
}

export async function POST(req: Request) {
    try {
        const body: EmailPayload = await req.json();
        const { type, claimId, inventoryName, inventoryNumber, siteName, managerName, managerUid, reportText } = body;

        const settingsSnap = await adminDb.doc("settings/system").get();
        if (!settingsSnap.exists) throw new Error("Brak konfiguracji maili w Ustawieniach Systemu!");

        const settings = settingsSnap.data() || {};
        const dyrektorEmail = settings.clsDirectorEmail || "";
        const szefEmail = settings.clsBossEmail || "";

        if (!dyrektorEmail || !szefEmail) {
            throw new Error("Adresy e-mail Dyrektora lub Szefa nie są uzupełnione w Ustawieniach!");
        }

        let managerEmail = "";
        if (managerUid) {
            const userSnap = await adminDb.collection("users").doc(managerUid).get();
            if (userSnap.exists) {
                const userData = userSnap.data() || {};
                managerEmail = userData.email || "";
            }
        }

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        const senderString = `"Panel Analizy Szkód CLS" <${process.env.EMAIL_USER}>`;

        let subject = "";
        let recipients: string[] = [];
        let htmlContent = "";

        switch (type) {
            case "NEW_CLAIM":
                subject = `📋 [NOWE ZGŁOSZENIE] Zarejestrowano zgłoszenie szkody CLS · ${claimId}`;
                recipients = [dyrektorEmail, szefEmail];
                if (managerEmail) recipients.push(managerEmail);

                htmlContent = `
                    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                        <div style="background:#2563eb;color:#fff;padding:15px;border-radius:8px;text-align:center">
                            <h2 style="margin:0;font-size:18px;text-transform:uppercase">📋 Rejestracja Zgłoszenia Szkody</h2>
                        </div>
                        <div style="background:#fff;padding:20px;margin-top:15px;border-radius:8px">
                            <p style="font-size:14px;color:#334155">Zgłoszono uszkodzenie sprzętu na budowie <b>${siteName}</b>.</p>
                            <table style="width:100%;font-size:13px;color:#475569;margin-bottom:15px">
                                <tr><td><b>ID Zgłoszenia:</b></td><td>${claimId}</td></tr>
                                <tr><td><b>Sprzęt:</b></td><td>${inventoryName} (Nr: ${inventoryNumber || 'brak'})</td></tr>
                                <tr><td><b>Kierownik odpowiedzialny:</b></td><td>${managerName || 'Przypisany do budowy'}</td></tr>
                            </table>
                            <p style="font-size:13px;color:#2563eb;font-weight:bold">ℹ️ Prośba o wyjaśnienie okoliczności: Prosimy o zalogowanie się do Panelu CLS w ciągu 72 godzin i udzielenie wyjaśnień Asystentowi CLS AI.</p>
                        </div>
                    </div>`;
                break;

            case "CLAIM_FINISHED":
                subject = `✨ [WYJAŚNIENIA GOTOWE] Kierownik udzielił informacji · ${claimId}`;
                recipients = [dyrektorEmail, szefEmail];

                htmlContent = `
                    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                        <div style="background:#8b5cf6;color:#fff;padding:15px;border-radius:8px;text-align:center">
                            <h2 style="margin:0;font-size:18px;text-transform:uppercase">✨ Wyjaśnienia Zgromadzone przez AI</h2>
                        </div>
                        <div style="background:#fff;padding:20px;margin-top:15px;border-radius:8px">
                            <p style="font-size:14px;color:#334155">Kierownik <b>${managerName}</b> zakończył rozmowę wyjaśniającą z Asystentem CLS AI.</p>
                            <div style="background:#faf5ff;border-left:4px solid #8b5cf6;padding:12px;margin:15px 0;border-radius:0 8px 8px 0;font-size:12px;color:#5b21b6">
                                <b>PODSUMOWANIE ANALIZY ASYSTENTA CLS AI:</b><br/><br/>
                                <pre style="font-family:sans-serif;white-space:pre-wrap;margin:0">${reportText}</pre>
                            </div>
                            <p style="font-size:13px;color:#1e40af;font-weight:bold">👉 Dyrektor może teraz zalogować się do systemu i wprowadzić propozycję rozstrzygnięcia.</p>
                        </div>
                    </div>`;
                break;

            case "VERDICT_DYREKTOR":
                subject = `⏳ [PROPOZYCJA ROZSTRZYGNIĘCIA] Dyrektor przygotował propozycję · ${claimId}`;
                recipients = [szefEmail];
                if (managerEmail) recipients.push(managerEmail);

                htmlContent = `
                    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                        <div style="background:#f59e0b;color:#fff;padding:15px;border-radius:8px;text-align:center">
                            <h2 style="margin:0;font-size:18px;text-transform:uppercase">⏳ Propozycja Rozstrzygnięcia (Dyrektor)</h2>
                        </div>
                        <div style="background:#fff;padding:20px;margin-top:15px;border-radius:8px">
                            <p style="font-size:14px;color:#334155">Dyrektor wprowadził proponowane rozstrzygnięcie w sprawie <b>${claimId}</b>.</p>
                            <p style="font-size:13px;color:#b45309;font-weight:bold">⚠️ Uwaga dla Szefa: Masz 72 godziny na zatwierdzenie lub modyfikację tej propozycji. Po tym czasie propozycja Dyrektora zostanie zatwierdzona automatycznie.</p>
                        </div>
                    </div>`;
                break;

            case "VERDICT_FINAL":
                subject = `✅ [ROZSTRZYGNIĘCIE OSTATECZNE] Zgłoszenie CLS zostało zamknięte · ${claimId}`;
                recipients = [dyrektorEmail, szefEmail];
                if (managerEmail) recipients.push(managerEmail);

                htmlContent = `
                    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                        <div style="background:#1e293b;color:#fff;padding:15px;border-radius:8px;text-align:center">
                            <h2 style="margin:0;font-size:18px;text-transform:uppercase">✅ OSTATECZNA DECYZJA ZARZĄDU</h2>
                        </div>
                        <div style="background:#fff;padding:20px;margin-top:15px;border-radius:8px">
                            <p style="font-size:14px;color:#334155">Zarząd podjął ostateczną decyzję w sprawie <b>${claimId}</b> (${inventoryName}). Zgłoszenie zostało zamknięte i zarchiwizowane.</p>
                        </div>
                    </div>`;
                break;

            // --- NOWE SZABLONY DLA STRÓŻA TERMINÓW (CRONA) ---
            case "REMINDER_1":
                subject = `⚠️ [CLS przypomnienie I] Prośba o wyjaśnienie okoliczności · ${claimId}`;
                if (managerEmail) recipients = [managerEmail];

                htmlContent = `
                    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                        <div style="background:#f59e0b;color:#fff;padding:12px;border-radius:8px;text-align:center">
                            <h4 style="margin:0;text-transform:uppercase">⚠️ Przypomnienie I: Wyjaśnienie okoliczności szkody</h4>
                        </div>
                        <p style="font-size:14px;color:#334155;margin-top:15px">Przypominamy, że minęły już <b>24 godziny</b> od rejestracji zgłoszenia szkody sprzętu <b>${inventoryName}</b> z Twojej budowy.</p>
                        <p style="font-size:13px;color:#334155">Proszę zalogować się do systemu, wejść w zakładkę <b>Panel Analizy Szkód (CLS)</b> i udzielić wyjaśnień Asystentowi CLS AI.</p>
                    </div>`;
                break;

            case "REMINDER_2":
                subject = `🔥 [CLS PILNE przypomnienie II] Ostateczna prośba o wyjaśnienia · ${claimId}`;
                if (managerEmail) recipients = [managerEmail];

                htmlContent = `
                    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                        <div style="background:#ea580c;color:#fff;padding:12px;border-radius:8px;text-align:center">
                            <h4 style="margin:0;text-transform:uppercase">🔥 Ostateczna prośba o udzielenie wyjaśnień</h4>
                        </div>
                        <p style="font-size:14px;color:#334155;margin-top:15px"><b>Ważne:</b> Minęły już <b>48 godzin</b>, a w systemie nadal brakuje Twojego stanowiska w sprawie zgłoszenia <b>${claimId}</b>.</p>
                        <p style="font-size:13px;color:#b45309;font-weight:bold">Brak odpowiedzi w ciągu kolejnych 24 godzin zostanie uznany za brak ustosunkowania się do zgłoszenia. Sprawa trafi bezpośrednio do decyzji Zarządu bez Twoich wyjaśnień, co może skutkować podjęciem jednostronnej decyzji o podziale kosztów (obciążeniem finansowym).</p>
                    </div>`;
                break;

            case "REFUSAL":
                subject = `🚨 [CLS BRAK ODPOWIEDZI] Brak wyjaśnień kierownika budowy · ${claimId}`;
                recipients = [dyrektorEmail, szefEmail];

                htmlContent = `
                    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                        <div style="background:#dc2626;color:#fff;padding:15px;border-radius:8px;text-align:center">
                            <h2 style="margin:0;font-size:18px;text-transform:uppercase">🚨 Brak ustosunkowania się do zgłoszenia CLS</h2>
                        </div>
                        <div style="background:#fff;padding:20px;margin-top:15px;border-radius:8px">
                            <p style="font-size:14px;color:#334155">Kierownik Budowy <b>${managerName}</b> nie udzielił odpowiedzi w wyznaczonym terminie 72 godzin w sprawie <b>${claimId}</b>.</p>
                            <p style="font-size:13px;color:#b91c1c;font-weight:bold">Możliwość edycji zgłoszenia została zamknięta. Sprawa została przekazana bezpośrednio do decyzji Zarządu bez wyjaśnień ze strony budowy.</p>
                        </div>
                    </div>`;
                break;
        }

        const finalRecipients = recipients.filter(Boolean);

        if (finalRecipients.length > 0) {
            await transporter.sendMail({
                from: senderString,
                to: finalRecipients.join(", "),
                subject: subject,
                html: htmlContent
            });
        }

        return NextResponse.json({ success: true, message: `Wysłano powiadomienie CLS typu: ${type}` });

    } catch (error: any) {
        console.error("Błąd wysyłki e-mail CLS:", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}