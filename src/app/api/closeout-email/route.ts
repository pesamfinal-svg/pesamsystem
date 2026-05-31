import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import nodemailer from 'nodemailer';

interface CloseoutEmailPayload {
    type: "CLOSEOUT_INITIATED" | "CLOSEOUT_SIGNED_BY_MANAGER" | "CLOSEOUT_FINALIZED";
    siteName: string;
    managerName: string;
    managerEmail: string;
    warehousemanName: string;
    debtsList: { name: string; quantity: number; unit: string; inventoryNumber: string; resolution?: "LOSS" | "CONSUMED"; }[];
    detectiveList?: { name: string; inventoryNumber: string; failureDescription: string; }[];
}

export async function POST(req: Request) {
    try {
        const body: CloseoutEmailPayload = await req.json();
        const { type, siteName, managerName, managerEmail, warehousemanName, debtsList, detectiveList } = body;

        // Pobierz ustawienia globalne
        const settingsSnap = await adminDb.doc("settings/system").get();
        if (!settingsSnap.exists) throw new Error("Brak konfiguracji maili w Ustawieniach Systemu!");

        const settings = settingsSnap.data() || {};
        const testEmails: string[] = settings.closeoutEmailRecipients || [];
        const isSandbox = settings.isCloseoutSandboxMode !== undefined ? settings.isCloseoutSandboxMode : true;
        const dyrektorEmail = settings.clsDirectorEmail || "";
        const szefEmail = settings.clsBossEmail || "";

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        const senderString = `"Audytor Zamknięć PESAM" <${process.env.EMAIL_USER}>`;

        let subject = "";
        let recipients: string[] = [];
        let htmlContent = "";

        // ROZDZIELENIE STRAT OD ZUŻYCIA NORMALNEGO
        const lossItems = debtsList.filter(item => item.resolution !== "CONSUMED");
        const consumedItems = debtsList.filter(item => item.resolution === "CONSUMED");

        // 1. Tabela strat (braków)
        const debtsTableRows = lossItems.length > 0
            ? lossItems.map(item => `
                <tr style="border-bottom:1px solid #f1f5f9">
                    <td style="padding:10px 0;font-size:13px;color:#334155"><b>${item.name}</b><br/><span style="font-size:10px;color:#94a3b8">Nr: ${item.inventoryNumber || '-'}</span></td>
                    <td style="padding:10px 0;text-align:right;font-size:13px;color:#ef4444;font-weight:bold">${item.quantity} ${item.unit || 'szt.'}</td>
                </tr>`).join("")
            : `<tr><td colspan="2" style="padding:12px 0;text-align:center;color:#10b981;font-weight:bold;font-size:13px">Brak bezpośrednich strat / kradzieży sprzętu!</td></tr>`;

        // 2. Tabela normalnego zużycia eksploatacyjnego (BHP / materiały)
        let consumedTableHtml = "";
        if (consumedItems.length > 0) {
            const consumedRows = consumedItems.map(item => `
                <tr style="border-bottom:1px solid #f1f5f9">
                    <td style="padding:10px 0;font-size:13px;color:#475569"><b>${item.name}</b></td>
                    <td style="padding:10px 0;text-align:right;font-size:13px;color:#64748b;font-weight:bold">${item.quantity} ${item.unit || 'szt.'}</td>
                </tr>`).join("");

            consumedTableHtml = `
                <h4 style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin:25px 0 10px 0;border-bottom:1px solid #f1f5f9;padding-bottom:5px">🧼 ZUŻYCIE NORMALNE (Koszty eksploatacyjne projektowe):</h4>
                <p style="font-size:11px;color:#64748b;margin-bottom:12px">Poniższe materiały zostały zatwierdzone przez Magazyniera jako normalne zużycie BHP / materiałów i nie obciążają finansowo kierownika budowy:</p>
                <table style="width:100%;border-collapse:collapse">${consumedRows}</table>
            `;
        }

        // 3. Tabela Detektywa (Ujawnione ukryte wady)
        let detectiveHtml = "";
        if (detectiveList && detectiveList.length > 0) {
            const detRows = detectiveList.map(item => `
                <div style="background:#fff7ed;border-left:4px solid #f97316;padding:12px;margin-bottom:8px;font-size:12px;color:#431407;border-radius:0 8px 8px 0">
                    <b style="font-size:13px">${item.name}</b> (Nr: ${item.inventoryNumber || 'brak'})<br/>
                    <i style="color:#9a3412;display:block;margin-top:4px">Opis usterki z bazy: ${item.failureDescription}</i>
                </div>
            `).join("");

            detectiveHtml = `
                <h4 style="font-size:11px;color:#f97316;text-transform:uppercase;letter-spacing:1px;margin:25px 0 10px 0;border-bottom:1px solid #f1f5f9;padding-bottom:5px">🕵️ Detektyw PESAM (Zatajone Usterki):</h4>
                <p style="font-size:11px;color:#64748b;margin-bottom:12px">Poniższe urządzenia powróciły z tej budowy teoretycznie sprawne, ale krótko po zwrocie uległy awarii u kolejnych osób lub zostały wysłane do serwisu:</p>
                ${detRows}
            `;
        }

        if (type === "CLOSEOUT_INITIATED") {
            subject = `⏳ [ROZLICZENIE BUDOWY] Audyt końcowy projektu · ${siteName}`;
            recipients = isSandbox ? testEmails : [managerEmail];

            htmlContent = `
                <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                    <div style="background:#0f172a;color:#fff;padding:15px;border-radius:8px;text-align:center">
                        <h2 style="margin:0;font-size:16px;text-transform:uppercase;letter-spacing:1px">⏳ Zgłoszenie Zamknięcia Budowy</h2>
                    </div>
                    <div style="background:#fff;padding:20px;margin-top:15px;border-radius:8px;border:1px solid #e2e8f0">
                        <p style="font-size:14px;color:#334155">Cześć <b>${managerName}</b>,</p>
                        <p style="font-size:13px;color:#475569;line-height:1.5">Magazynier centralny (<b>${warehousemanName}</b>) zakończył fizyczny audyt sprzętu na Twoim projekcie: <b>${siteName}</b> i rozpoczął procedurę zamknięcia budowy.</p>
                        
                        <h4 style="font-size:11px;color:#ef4444;text-transform:uppercase;letter-spacing:1px;margin:20px 0 10px 0;border-bottom:1px solid #f1f5f9;padding-bottom:5px">Wykaz strat obciążających budowę (Długi):</h4>
                        <table style="width:100%;border-collapse:collapse">${debtsTableRows}</table>
                        ${consumedTableHtml}
                        ${detectiveHtml}

                        <p style="font-size:13px;color:#ef4444;font-weight:bold;margin-top:20px;background:#fef2f2;padding:10px;border-radius:6px;border-left:4px solid #ef4444">
                            ✍️ WYMAGANY PODPIS: Zaloguj się do systemu PESAM, przejdź do zakładki "Zatwierdzanie Zamknięć" i złóż cyfrowy podpis pod rozliczeniem, aby sprawa mogła trafić do ostatecznej decyzji Dyrekcji.
                        </p>
                    </div>
                    ${isSandbox ? `<div style="text-align:center;font-size:10px;color:#f97316;margin-top:10px;font-weight:bold">🧪 [KOMUNIKAT PIASKOWNICY]: Ten mail oryginalnie leciałby do: ${managerEmail}</div>` : ""}
                </div>`;
        }
        else if (type === "CLOSEOUT_SIGNED_BY_MANAGER") {
            subject = `✍️ [PODPIS KIEROWNIKA] Kierownik zaakceptował rozliczenie · ${siteName}`;
            recipients = isSandbox ? testEmails : [dyrektorEmail, szefEmail].filter(Boolean);

            htmlContent = `
                <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                    <div style="background:#2563eb;color:#fff;padding:15px;border-radius:8px;text-align:center">
                        <h2 style="margin:0;font-size:16px;text-transform:uppercase;letter-spacing:1px">✍️ Złożono Podpis Kierownika</h2>
                    </div>
                    <div style="background:#fff;padding:20px;margin-top:15px;border-radius:8px;border:1px solid #e2e8f0">
                        <p style="font-size:14px;color:#334155">Kierownik Budowy <b>${managerName}</b> pomyślnie podpisał cyfrowo raport strat dla budowy: <b>${siteName}</b>.</p>
                        <p style="font-size:13px;color:#475569;line-height:1.5">Wniosek został przekazany do ostatecznej akceptacji finansowej i oficjalnego zamknięcia bazy przez Dyrekcję.</p>
                        
                        <h4 style="font-size:11px;color:#ef4444;text-transform:uppercase;letter-spacing:1px;margin:20px 0 10px 0;border-bottom:1px solid #f1f5f9;padding-bottom:5px">Zatwierdzony wykaz ubytków (Długi):</h4>
                        <table style="width:100%;border-collapse:collapse">${debtsTableRows}</table>
                        ${consumedTableHtml}
                        ${detectiveHtml}

                        <p style="font-size:13px;color:#16a34a;font-weight:bold;margin-top:20px;background:#f0fdf4;padding:10px;border-radius:6px;border-left:4px solid #16a34a">
                            👉 PROŚBA O ZAMKNIĘCIE: Prosimy Dyrekcję o zalogowanie się do systemu PESAM i ostateczne zamknięcie budowy w zakładce "Zatwierdzanie Zamknięć".
                        </p>
                    </div>
                    ${isSandbox ? `<div style="text-align:center;font-size:10px;color:#f97316;margin-top:10px;font-weight:bold">🧪 [KOMUNIKAT PIASKOWNICY]: Ten mail oryginalnie leciałby do dyrekcji: ${dyrektorEmail}, ${szefEmail}</div>` : ""}
                </div>`;
        }
        else if (type === "CLOSEOUT_FINALIZED") {
            subject = `🔒 [PROJEKT ROZLICZONY] Oficjalne zamknięcie budowy · ${siteName}`;
            recipients = isSandbox
                ? testEmails
                : [...testEmails, managerEmail, dyrektorEmail, szefEmail].filter(Boolean);

            htmlContent = `
                <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px;border:1px solid #e2e8f0">
                    <div style="background:#16a34a;color:#fff;padding:15px;border-radius:8px;text-align:center">
                        <h2 style="margin:0;font-size:16px;text-transform:uppercase;letter-spacing:1px">🔒 Projekt Został Zamknięty</h2>
                    </div>
                    <div style="background:#fff;padding:20px;margin-top:15px;border-radius:8px;border:1px solid #e2e8f0">
                        <p style="font-size:14px;color:#334155">Dyrektor podjął ostateczną decyzję i autoryzował podpisem zamknięcie projektu: <b>${siteName}</b>.</p>
                        <p style="font-size:13px;color:#475569;line-height:1.5">Budowa została oficjalnie oznaczona w systemie PESAM jako <b>ZAKOŃCZONA</b>. Wszystkie alokacje sprzętowe zostały wyzerowane, a wykazane straty odpisano w koszty.</p>
                        
                        <h4 style="font-size:11px;color:#ef4444;text-transform:uppercase;letter-spacing:1px;margin:20px 0 10px 0;border-bottom:1px solid #f1f5f9;padding-bottom:5px">Ostateczny wykaz odpisanych strat (LIKWIDACJA):</h4>
                        <table style="width:100%;border-collapse:collapse">${debtsTableRows}</table>
                        ${consumedTableHtml}
                        ${detectiveHtml}

                        <p style="font-size:12px;color:#64748b;text-align:center;margin-top:20px;border-top:1px dashed #e2e8f0;padding-top:10px">Dokument zarchiwizowany w bazie PESAM Cloud. Sprawa zamknięta.</p>
                    </div>
                </div>`;
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

        return NextResponse.json({ success: true, message: `Wysłano e-mail rozliczenia budowy` });

    } catch (error: any) {
        console.error("Błąd wysyłki e-mail Closeout:", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}