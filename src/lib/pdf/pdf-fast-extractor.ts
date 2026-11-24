// src/lib/pdf/pdf-fast-extractor.ts
// Ekstraktor pełnego tekstu z PDF z warstwą tekstową (Fast Path).
// Reużywa logiki dekompresji FlateDecode z text-layer-detector, ale
// zbiera CAŁY tekst (bez limitu 50 fragmentów) i zwraca go jako
// płaski string gotowy do dalszego parsowania regexem.

import zlib from 'zlib';

export interface ExtractedPdfText {
    fullText: string;
    pageTexts: string[]; // tekst per strumień (przybliżenie stron)
    charCount: number;
    extractionTimeMs: number;
}

export function extractFullTextFromPdf(buffer: Buffer): ExtractedPdfText {
    const startTime = performance.now();
    const rawString = buffer.toString('binary');
    const streamRegex = /stream[ \t]*\r?\n([\s\S]*?)[\r\n\s]*endstream/g;

    const pageTexts: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = streamRegex.exec(rawString)) !== null) {
        const rawStream = match[1];
        let streamContent = '';

        // Dekompresja FlateDecode
        try {
            const streamBuffer = Buffer.from(rawStream, 'binary');
            let decompressed: Buffer;
            try {
                decompressed = zlib.inflateSync(streamBuffer);
            } catch {
                decompressed = zlib.inflateRawSync(streamBuffer);
            }
            streamContent = decompressed.toString('latin1');
        } catch {
            streamContent = rawStream;
        }

        const tokens: string[] = [];

        // 1. Operator (tekst) Tj — string literalny
        const tjMatches = streamContent.match(/\(([^()]*)\)\s*Tj/g) || [];
        for (const t of tjMatches) {
            const text = t.replace(/^\(/, '').replace(/\)\s*Tj$/, '');
            if (text.trim()) tokens.push(decodePdfString(text));
        }

        // 2. Operator [(tekst) kern (tekst)] TJ — tablicowy
        const tjArrayMatches = streamContent.match(/\[([^\]]*)\]\s*TJ/g) || [];
        for (const t of tjArrayMatches) {
            const inner = t.match(/\(([^()]*)\)/g) || [];
            const word = inner.map(s => decodePdfString(s.slice(1, -1))).join('');
            if (word.trim()) tokens.push(word);
        }

        // 3. Hex <4142...> Tj
        const hexTjMatches = streamContent.match(/<([0-9a-fA-F]{2,})>\s*Tj/g) || [];
        for (const t of hexTjMatches) {
            const hex = t.replace(/^</, '').replace(/>\s*Tj$/, '');
            const decoded = hexToReadable(hex);
            if (decoded.trim()) tokens.push(decoded);
        }

        // 4. [<hex>] TJ
        const hexTjArrayMatches = streamContent.match(/\[([^\]]*<[0-9a-fA-F]{4,}>[^\]]*)\]\s*TJ/g) || [];
        for (const t of hexTjArrayMatches) {
            const hexParts = t.match(/<([0-9a-fA-F]{2,})>/g) || [];
            const decoded = hexParts.map(h => hexToReadable(h.slice(1, -1))).join('');
            if (decoded.trim()) tokens.push(decoded);
        }

        if (tokens.length > 0) {
            // Bezpieczne łączenie tokenów w czytelną treść wierszy
            const simpleJoined = tokens.join(' ');
            pageTexts.push(simpleJoined);
        }
    }

    // Fallback: jeśli nic nie znaleźliśmy przez strumienie, szukamy surowego tekstu
    if (pageTexts.length === 0) {
        const plainMatches = rawString.match(/\(([a-zA-Z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ .,\-/]{4,})\)\s*Tj/g) || [];
        if (plainMatches.length > 0) {
            pageTexts.push(plainMatches.map(t => t.replace(/[()]/g, '').replace(/\s*Tj$/, '')).join(' '));
        }
    }

    const fullText = pageTexts.join('\n\n');
    const extractionTimeMs = Math.round((performance.now() - startTime) * 100) / 100;

    return {
        fullText,
        pageTexts,
        charCount: fullText.length,
        extractionTimeMs
    };
}

// ─── Pomocnicze funkcje ──────────────────────────────────────────────────────

/**
 * Dekoduje specjalne sekwencje escape w stringu PDF:
 * \n, \r, \t, \(, \), \\, \ddd (oktalny)
 */
function decodePdfString(raw: string): string {
    return raw
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\(/g, '(')
        .replace(/\\\)/g, ')')
        .replace(/\\\\/g, '\\')
        .replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Konwertuje ciąg hex na czytelny tekst (latin1 / CP1250 fallback)
 */
function hexToReadable(hex: string): string {
    try {
        const bytes = Buffer.from(hex, 'hex');
        // Próba UTF-16 BE (2 bajty na znak) — common w PDF-ach z custom ToUnicode
        if (bytes.length % 2 === 0 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
            return bytes.slice(2).toString('utf16le');
        }
        if (bytes.length % 2 === 0 && bytes.length > 2) {
            // Sprawdź czy to wygląda jak UTF-16 (co 2. bajt = 0x00)
            const isUtf16 = bytes.every((b, i) => i % 2 === 1 ? b === 0 : true);
            if (isUtf16) {
                const everyOther = Buffer.from(bytes.filter((_, i) => i % 2 === 0));
                return everyOther.toString('latin1').replace(/[^\x20-\x7E\xC0-\xFF]/g, '');
            }
        }
        return bytes.toString('latin1').replace(/[^\x20-\x7E\xC0-\xFF]/g, '');
    } catch {
        return '';
    }
}

/**
 * Próba grupowania tokenów w linie na podstawie operatorów pozycjonowania PDF.
 * Uproszczone: każde BT...ET to blok, Td/T* to nowa linia.
 */
function reconstructLines(streamContent: string, tokens: string[]): string {
    // Uproszczona heurystyka: łącz tokeny spacją, a przy operatorze Td/T*/TD wstaw newline
    // Pełna implementacja wymagałaby śledzenia macierzy transformacji
    const lines: string[] = [];
    let currentLine = '';
    let tokenIndex = 0;

    // Parsujemy sekwencję operatorów PDF (uproszczone)
    const opRegex = /(?:\(([^()]*)\)\s*Tj|\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj|(T[dD*]|ET|BT))/g;
    let m: RegExpExecArray | null;

    while ((m = opRegex.exec(streamContent)) !== null) {
        if (m[4] === 'BT') {
            // Begin text block
            if (currentLine.trim()) lines.push(currentLine.trim());
            currentLine = '';
        } else if (m[4] === 'ET') {
            // End text block
            if (currentLine.trim()) lines.push(currentLine.trim());
            currentLine = '';
        } else if (m[4] === 'Td' || m[4] === 'TD' || m[4] === 'T*') {
            // Nowy wiersz
            if (currentLine.trim()) lines.push(currentLine.trim());
            currentLine = '';
        } else if (tokenIndex < tokens.length) {
            currentLine += tokens[tokenIndex++];
        }
    }

    // Dodaj pozostałe tokeny, które nie zostały przetworzone
    while (tokenIndex < tokens.length) {
        currentLine += ' ' + tokens[tokenIndex++];
    }
    if (currentLine.trim()) lines.push(currentLine.trim());

    // Filtruj puste linie i zwróć
    return lines.filter(l => l.length > 0).join('\n');
}
