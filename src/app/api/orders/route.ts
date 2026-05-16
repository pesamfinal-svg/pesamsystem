// src/app/api/orders/route.ts
import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import nodemailer from 'nodemailer';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { orderId, siteId, siteName, user, cart, notes } = body;

        // 1. Zapisanie zamówienia do Firestore (przez Admin SDK)
        const orderRef = adminDb.collection('orders').doc(orderId);
        await orderRef.set({
            orderId,
            siteId,
            siteName,
            orderedBy: user.uid,
            orderedByName: `${user.firstName} ${user.lastName}`,
            status: "NOWE", // NOWE, W_REALIZACJI, ZAKONCZONE
            notes: notes || "",
            createdAt: new Date().toISOString(),
            items: cart
        });

        // 2. Konfiguracja wysyłki E-mail (Nodemailer)
        // Wymaga utworzenia "Hasła Aplikacji" w ustawieniach konta Google
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER, // Np. TwojMail@gmail.com
                pass: process.env.EMAIL_PASS, // Hasło Aplikacji wygenerowane w Google
            },
        });

        // 3. Generowanie "Dokumentu" jako eleganckiego e-maila HTML
        const itemsHtml = cart.map((item: any, index: number) => `
            <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">${index + 1}</td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">
                    <strong>${item.name}</strong> 
                    ${item.isManual ? '<span style="color: #d97706; font-size: 10px;">(Wpis ręczny)</span>' : ''}
                </td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: center;">
                    ${item.inventoryNumber || '-'}
                </td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: center; font-weight: bold;">
                    ${item.quantity}
                </td>
            </tr>
        `).join('');

        const mailOptions = {
            from: `"PESAM System" <${process.env.EMAIL_USER}>`,
            to: process.env.EMAIL_WAREHOUSE || process.env.EMAIL_USER, // Mail magazynu
            subject: `🔥 Nowe zamówienie [${siteName}] - ${orderId}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
                    <div style="background-color: #2563eb; padding: 20px; color: white; text-align: center;">
                        <h2 style="margin: 0;">Dokument Zamówienia</h2>
                        <p style="margin: 5px 0 0 0; opacity: 0.8;">Nr: ${orderId}</p>
                    </div>
                    <div style="padding: 20px;">
                        <p><strong>Budowa:</strong> ${siteName}</p>
                        <p><strong>Zamawiający:</strong> ${user.firstName} ${user.lastName}</p>
                        <p><strong>Data:</strong> ${new Date().toLocaleString('pl-PL')}</p>
                        ${notes ? `<div style="background: #fffbeb; padding: 10px; border-left: 4px solid #f59e0b; margin-bottom: 20px;"><strong>Uwagi:</strong> ${notes}</div>` : ''}
                        
                        <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
                            <thead style="background-color: #f8fafc; text-align: left;">
                                <tr>
                                    <th style="padding: 10px; border-bottom: 2px solid #ddd;">Lp</th>
                                    <th style="padding: 10px; border-bottom: 2px solid #ddd;">Nazwa</th>
                                    <th style="padding: 10px; border-bottom: 2px solid #ddd; text-align: center;">Nr Mag</th>
                                    <th style="padding: 10px; border-bottom: 2px solid #ddd; text-align: center;">Ilość</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${itemsHtml}
                            </tbody>
                        </table>
                    </div>
                </div>
            `,
        };

        // Wysyłanie e-maila
        await transporter.sendMail(mailOptions);

        return NextResponse.json({ success: true, message: "Zamówienie zapisane i wysłane!" });

    } catch (error: any) {
        console.error("Błąd API Orders:", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}