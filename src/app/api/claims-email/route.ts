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

        const senderString = `"Sąd PESAM CLS" <${process.env.EMAIL_USER}>`;

        let subject = "";
        let recipients: string[] = [];
        let htmlContent = "";

        switch (type) {
            case "NEW_CLAIM":
                subject = `⚖️ [NOWE ŚLEDZTWO] Wszczęto postępowanie CLS · ${claimId}`;
                recipients = [dyrektorEmail, szefEmail];
                if (managerEmail) recipients.push(managerEmail);

                htmlContent = `
                    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                        <div style="background:#ef4444;color:#fff;padding:15px;border-radius:8px;text-align:center">
                            <h2 style="margin:0;font-size:18px;text-transform:uppercase">⚖️ Wszczęcie Postępowania Szkodowego</h2>
                        </div>
                        <div style="background:#fff;padding:20px;margin-top:15px;border-radius:8px">
                            <p style="font-size:14px;color:#334155">Zgłoszono uszkodzenie sprzętu na budowie <b>${siteName}</b>.</p>
                            <table style="width:100%;font-size:13px;color:#475569;margin-bottom:15px">
                                <tr><td><b>ID Sprawy:</b></td><td>${claimId}</td></tr>
                                <tr><td><b>Sprzęt:</b></td><td>${inventoryName} (Nr: ${inventoryNumber || 'brak'})</td></tr>
                                <tr><td><b>Oskarżony (Kierownik):</b></td><td>${managerName || 'Przypisany do budowy'}</td></tr>
                            </table>
                            <p style="font-size:13px;color:#dc2626;font-weight:bold">⚠️ Wezwanie dla Kierownika: Masz 72 godziny na zalogowanie się do Sądu PESAM i złożenie wyjaśnień Asystentowi AI.</p>
                        </div>
                    </div>`;
                break;

            case "CLAIM_FINISHED":
                subject = `✨ [ZEZNANIA GOTOWE] Kierownik złożył wyjaśnienia · ${claimId}`;
                recipients = [dyrektorEmail, szefEmail];

                htmlContent = `
                    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                        <div style="background:#8b5cf6;color:#fff;padding:15px;border-radius:8px;text-align:center">
                            <h2 style="margin:0;font-size:18px;text-transform:uppercase">✨ Zeznania Zabezpieczone przez AI</h2>
                        </div>
                        <div style="background:#fff;padding:20px;margin-top:15px;border-radius:8px">
                            <p style="font-size:14px;color:#334155">Kierownik <b>${managerName}</b> ukończył przesłuchanie techniczne z Asystentem AI.</p>
                            <div style="background:#faf5ff;border-left:4px solid #8b5cf6;padding:12px;margin:15px 0;border-radius:0 8px 8px 0;font-size:12px;color:#5b21b6">
                                <b>PROTOKÓŁ USTALEŃ ASYSTENTA AI:</b><br/><br/>
                                <pre style="font-family:sans-serif;white-space:pre-wrap;margin:0">${reportText}</pre>
                            </div>
                            <p style="font-size:13px;color:#1e40af;font-weight:bold">👉 Dyrektor może teraz zalogować się do systemu i wydać wyrok I instancji.</p>
                        </div>
                    </div>`;
                break;

            case "VERDICT_DYREKTOR":
                subject = `⏳ [WYROK I INSTANCJI] Dyrektor wydał wyrok · ${claimId}`;
                recipients = [szefEmail];
                if (managerEmail) recipients.push(managerEmail);

                htmlContent = `
                    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                        <div style="background:#f59e0b;color:#fff;padding:15px;border-radius:8px;text-align:center">
                            <h2 style="margin:0;font-size:18px;text-transform:uppercase">⏳ Orzeczenie I Instancji (Dyrektora)</h2>
                        </div>
                        <div style="background:#fff;padding:20px;margin-top:15px;border-radius:8px">
                            <p style="font-size:14px;color:#334155">Dyrektor ogłosił proponowany wyrok w sprawie <b>${claimId}</b>.</p>
                            <p style="font-size:13px;color:#b45309;font-weight:bold">⚠️ Uwaga dla Szefa: Masz 72 godziny na zatwierdzenie lub nadpisanie tego wyroku. Po tym czasie wyrok Dyrektora zaakceptuje się automatycznie.</p>
                        </div>
                    </div>`;
                break;

            case "VERDICT_FINAL":
                subject = `🔨 [WYROK OSTATECZNY] Sprawa CLS została zamknięta · ${claimId}`;
                recipients = [dyrektorEmail, szefEmail];
                if (managerEmail) recipients.push(managerEmail);

                htmlContent = `
                    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                        <div style="background:#1e293b;color:#fff;padding:15px;border-radius:8px;text-align:center">
                            <h2 style="margin:0;font-size:18px;text-transform:uppercase">🔨 OSTATECZNY WYROK SZEFA</h2>
                        </div>
                        <div style="background:#fff;padding:20px;margin-top:15px;border-radius:8px">
                            <p style="font-size:14px;color:#334155">Szef ogłosił ostateczną decyzję w sprawie <b>${claimId}</b> (${inventoryName}). Sprawa została trwale zamknięta i zarchiwizowana.</p>
                        </div>
                    </div>`;
                break;

            // --- NOWE SZABLONY DLA STRÓŻA TERMINÓW (CRONA) ---
            case "REMINDER_1":
                subject = `⚠️ [CLS przypomnienie I] Wyjaśnienie usterki · ${claimId}`;
                if (managerEmail) recipients = [managerEmail];

                htmlContent = `
                    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                        <div style="background:#f59e0b;color:#fff;padding:12px;border-radius:8px;text-align:center">
                            <h4 style="margin:0;text-transform:uppercase">⚠️ Przypomnienie I: Wyjaśnienie Szkody</h4>
                        </div>
                        <p style="font-size:14px;color:#334155;margin-top:15px">Przypominamy, że minęło już <b>24 godziny</b> od zgłoszenia uszkodzenia sprzętu <b>${inventoryName}</b> z Twojej budowy.</p>
                        <p style="font-size:13px;color:#334155">Proszę niezwłocznie zalogować się do systemu, wejść w zakładkę <b>Sąd PESAM</b> i złożyć wyjaśnienia asystentowi AI.</p>
                    </div>`;
                break;

            case "REMINDER_2":
                subject = `🔥 [CLS PILNE przypomnienie II] Ostateczne wezwanie · ${claimId}`;
                if (managerEmail) recipients = [managerEmail];

                htmlContent = `
                    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                        <div style="background:#ea580c;color:#fff;padding:12px;border-radius:8px;text-align:center">
                            <h4 style="margin:0;text-transform:uppercase">🔥 OSTATECZNE WEZWANIE PRZED KARĄ</h4>
                        </div>
                        <p style="font-size:14px;color:#334155;margin-top:15px"><b>UWAGA!</b> Minęło już <b>48 godzin</b>, a Ty wciąż nie złożyłeś wyjaśnień w sprawie <b>${claimId}</b>.</p>
                        <p style="font-size:13px;color:#b45309;font-weight:bold">Brak odpowiedzi w ciągu kolejnych 24 godzin zostanie uznany za odmowę współpracy. Sprawa trafi bezpośrednio na biurko Szefa bez Twoich zeznań, co będzie skutkowało jednostronnym wyrokiem (obciążeniem finansowym).</p>
                    </div>`;
                break;

            case "REFUSAL":
                subject = `🚨 [CLS ODMOWA WSPÓŁPRACY] Kierownik zignorował sprawę · ${claimId}`;
                recipients = [dyrektorEmail, szefEmail];

                htmlContent = `
                    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                        <div style="background:#dc2626;color:#fff;padding:15px;border-radius:8px;text-align:center">
                            <h2 style="margin:0;font-size:18px;text-transform:uppercase">🚨 Kierownik zignorował wezwanie CLS</h2>
                        </div>
                        <div style="background:#fff;padding:20px;margin-top:15px;border-radius:8px">
                            <p style="font-size:14px;color:#334155">Kierownik Budowy <b>${managerName}</b> zignorował wezwanie i nie złożył żadnych wyjaśnień w sprawie <b>${claimId}</b> w ciągu 72 godzin.</p>
                            <p style="font-size:13px;color:#b91c1c;font-weight:bold">System automatycznie zablokował mu możliwość obrony, wygenerował raport o odmowie współpracy i przekazał sprawę bezpośrednio do Waszego ukarania.</p>
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