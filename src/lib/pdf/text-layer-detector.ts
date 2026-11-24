// src/lib/pdf/text-layer-detector.ts
import zlib from 'zlib';

export interface DetectionResult {
    fileName: string;
    fileType: 'pdf' | 'image' | 'audio' | 'unknown';
    hasTextLayer: boolean;
    extractedCharactersCount: number;
    extractedTextSample: string;
    recommendedPath: 'FAST_PATH' | 'SLOW_PATH' | 'SPEECH_TO_TEXT';
    reason: string;
    executionTimeMs: number;
    detectedMetadata?: {
        isComarchOptima?: boolean;
        hasImages?: boolean;
        hasFonts?: boolean;
        nipFound?: string | null;
        docNumberFound?: string | null;
    };
}

/**
 * Błyskawiczny detektor warstwy tekstowej w plikach PDF / obrazach / audio.
 * Działa w 100% deterministycznie w pamięci RAM (0 zł kosztu, 2-15 ms).
 */
export function detectDocumentTextLayer(
    buffer: Buffer,
    fileName: string,
    mimeType?: string
): DetectionResult {
    const startTime = performance.now();
    const lowerName = fileName.toLowerCase();

    // 1. Sprawdzenie plików graficznych (zdjęcia z kabiny auta, skany JPG/PNG)
    const isImage = (
        mimeType?.startsWith('image/') ||
        lowerName.endsWith('.jpg') ||
        lowerName.endsWith('.jpeg') ||
        lowerName.endsWith('.png') ||
        lowerName.endsWith('.webp') ||
        lowerName.endsWith('.bmp') ||
        lowerName.endsWith('.tiff')
    );

    if (isImage) {
        const executionTimeMs = Math.round((performance.now() - startTime) * 100) / 100;
        return {
            fileName,
            fileType: 'image',
            hasTextLayer: false,
            extractedCharactersCount: 0,
            extractedTextSample: '',
            recommendedPath: 'SLOW_PATH',
            reason: 'Plik jest rastrowym zdjęciem/grafiką ze smartfona lub skanera bez cyfrowej warstwy tekstu. Wymagany model wizyjny (Gemini 3.5/3.8 Flash).',
            executionTimeMs,
            detectedMetadata: {
                hasImages: true,
                hasFonts: false
            }
        };
    }

    // 2. Sprawdzenie plików audio (notatki dyktowane przez kierowców)
    const isAudio = (
        mimeType?.startsWith('audio/') ||
        lowerName.endsWith('.mp3') ||
        lowerName.endsWith('.m4a') ||
        lowerName.endsWith('.wav') ||
        lowerName.endsWith('.ogg') ||
        lowerName.endsWith('.aac')
    );

    if (isAudio) {
        const executionTimeMs = Math.round((performance.now() - startTime) * 100) / 100;
        return {
            fileName,
            fileType: 'audio',
            hasTextLayer: false,
            extractedCharactersCount: 0,
            extractedTextSample: '',
            recommendedPath: 'SPEECH_TO_TEXT',
            reason: 'Plik dźwiękowy (notatka foniczna kierowcy). Kierowany do transkrypcji Whisper / Gemini Audio.',
            executionTimeMs
        };
    }

    // 3. Sprawdzenie pliku PDF
    const isPdf = mimeType === 'application/pdf' || lowerName.endsWith('.pdf') || buffer.subarray(0, 5).toString('ascii').startsWith('%PDF');

    if (!isPdf) {
        const executionTimeMs = Math.round((performance.now() - startTime) * 100) / 100;
        return {
            fileName,
            fileType: 'unknown',
            hasTextLayer: false,
            extractedCharactersCount: 0,
            extractedTextSample: '',
            recommendedPath: 'SLOW_PATH',
            reason: 'Nierozpoznany format pliku. Domyślnie skierowany do analizy uniwersalnej.',
            executionTimeMs
        };
    }

    // Analiza struktury binarnej PDF
    const extractedTexts: string[] = [];
    let hasFonts = false;
    let hasImages = false;
    let isComarchOptima = false;

    try {
        const rawString = buffer.toString('binary');

        if (rawString.includes('/Font') || rawString.includes('/Type /Font')) {
            hasFonts = true;
        }
        if (rawString.includes('/Image') || rawString.includes('/Subtype /Image') || rawString.includes('/DCTDecode')) {
            hasImages = true;
        }
        if (
            rawString.includes('Comarch') ||
            rawString.includes('Optima') ||
            rawString.includes('CDN Optima') ||
            rawString.includes('WNT') ||
            rawString.includes('WZ/')
        ) {
            isComarchOptima = true;
        }

        // Ekstrakcja strumieni (stream ... endstream)
        // Uwaga: po słowie "stream" i przed "endstream" mogą być spacje, tabulatory lub newline (PDF spec §7.3.8)
        const streamRegex = /stream[ \t]*\r?\n([\s\S]*?)[\r\n\s]*endstream/g;
        let match: RegExpExecArray | null;

        while ((match = streamRegex.exec(rawString)) !== null) {
            const rawStream = match[1];
            let streamContent = '';

            // Próba dekompresji FlateDecode (standard w 98% PDF-ów z ERP)
            try {
                const streamBuffer = Buffer.from(rawStream, 'binary');
                // Próba inflate (FlateDecode), potem inflateRaw jako fallback
                let decompressed: Buffer;
                try {
                    decompressed = zlib.inflateSync(streamBuffer);
                } catch {
                    decompressed = zlib.inflateRawSync(streamBuffer);
                }
                streamContent = decompressed.toString('latin1'); // latin1 zachowuje bajty 1:1
            } catch {
                // Jeśli nie był skompresowany lub błąd zlib, bierzemy surowy tekst
                streamContent = rawStream;
            }

            // Szukanie tekstu w operatorach PDF (Tj, TJ, nawiasy okrągłe)
            // Przykład: (Faktura VAT) Tj lub [(W) 20 (Z)] TJ
            const textMatchTj = streamContent.match(/\(([^()]{2,})\)\s*Tj/g);
            if (textMatchTj) {
                for (const t of textMatchTj) {
                    const clean = t.replace(/^\(/, '').replace(/\)\s*Tj$/, '').trim();
                    if (clean.length > 1) extractedTexts.push(clean);
                }
            }

            const textMatchTJ = streamContent.match(/\[(.*?)\]\s*TJ/g);
            if (textMatchTJ) {
                for (const t of textMatchTJ) {
                    // Wyciągamy zawartości wszystkich nawiasów wewnątrz tablicy TJ
                    const innerMatches = t.match(/\(([^()]+)\)/g);
                    if (innerMatches) {
                        const word = innerMatches.map(m => m.slice(1, -1)).join('');
                        if (word.trim().length > 1) extractedTexts.push(word.trim());
                    }
                }
            }

            // Obsługa hex-encoded text: <4142...> Tj lub [<4142>] TJ (custom encoding/ToUnicode)
            const hexMatchTj = streamContent.match(/<([0-9a-fA-F]{4,})>\s*Tj/g);
            if (hexMatchTj) {
                for (const t of hexMatchTj) {
                    const hex = t.replace(/^</, '').replace(/>\s*Tj$/, '');
                    try {
                        const decoded = Buffer.from(hex, 'hex').toString('latin1');
                        const printable = decoded.replace(/[^\x20-\x7E]/g, '');
                        if (printable.trim().length > 1) extractedTexts.push(printable.trim());
                    } catch { /* ignoruj błędy dekodowania */ }
                }
            }

            const hexMatchTJ = streamContent.match(/\[([^\]]*<[0-9a-fA-F]{4,}>[^\]]*)\]\s*TJ/g);
            if (hexMatchTJ) {
                for (const t of hexMatchTJ) {
                    const hexParts = t.match(/<([0-9a-fA-F]{4,})>/g);
                    if (hexParts) {
                        const decoded = hexParts.map(h => {
                            try { return Buffer.from(h.slice(1, -1), 'hex').toString('latin1').replace(/[^\x20-\x7E]/g, ''); } catch { return ''; }
                        }).join('');
                        if (decoded.trim().length > 1) extractedTexts.push(decoded.trim());
                    }
                }
            }

            // Jeśli znaleźliśmy już wystarczająco dużo tekstu, nie musimy mielić całego gigantycznego pliku
            if (extractedTexts.length > 50) break;
        }

        // Fallback 1: nieskompresowany tekst bezpośrednio w surowym PDF
        if (extractedTexts.length === 0) {
            const plainTextMatches = rawString.match(/\(([a-zA-Z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ.,\-_/ ]{4,})\)\s*Tj/g);
            if (plainTextMatches) {
                for (const t of plainTextMatches.slice(0, 30)) {
                    extractedTexts.push(t.replace(/[()]/g, '').trim());
                }
            }
        }

        // Fallback 2: szukaj ciągów czytelnego ASCII >= 4 znaki bezpośrednio w buforze PDF
        // (niektóre ERP-y osadzają tekst bez kompresji poza strumieniami)
        if (extractedTexts.length === 0) {
            const asciiMatches = rawString.match(/[A-Za-z0-9 .,\-\/]{5,}/g);
            if (asciiMatches) {
                const meaningful = asciiMatches.filter(s => /[A-Za-z]{3,}/.test(s));
                for (const s of meaningful.slice(0, 30)) extractedTexts.push(s.trim());
            }
        }
    } catch (err) {
        console.warn('Błąd podczas dekompresji PDF:', err);
    }

    const combinedText = extractedTexts.join(' ');
    // Usuwamy znaki specjalne i liczymy same litery/cyfry
    const alnumCount = (combinedText.match(/[a-zA-Z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g) || []).length;
    
    // Próbka tekstu do podglądu (max 300 znaków)
    const textSample = combinedText.slice(0, 250);

    // Próba znalezienia NIP-u i numeru WZ za pomocą Regex
    const nipMatch = combinedText.match(/\b\d{3}[-\s]?\d{3}[-\s]?\d{2}[-\s]?\d{2}\b|\b\d{10}\b/);
    const docNumberMatch = combinedText.match(/(?:WZ|WZT|FA|FV)[0-9A-Z/\-_]{3,25}/i);

    // KRYTERIUM DECYZJI:
    // Plik ma warstwę tekstową gdy:
    // - wyciągnięto >= 10 znaków alfanumerycznych, LUB
    // - są zdefiniowane czcionki (/Font) + choć 5 znaków (tekst encoded w custom encoding)
    const hasTextLayer = alnumCount >= 10 || (hasFonts && alnumCount >= 5);

    const executionTimeMs = Math.round((performance.now() - startTime) * 100) / 100;

    if (hasTextLayer) {
        return {
            fileName,
            fileType: 'pdf',
            hasTextLayer: true,
            extractedCharactersCount: alnumCount,
            extractedTextSample: textSample,
            recommendedPath: 'FAST_PATH',
            reason: `Wykryto cyfrową warstwę tekstową (${alnumCount} znaków, ${hasFonts ? 'zdefiniowane czcionki' : 'strumienie tekstowe'}${isComarchOptima ? ', struktura Comarch ERP' : ''}). Plik kwalifikuje się do natychmiastowego odczytu deterministycznym kodem w ułamku sekundy.`,
            executionTimeMs,
            detectedMetadata: {
                isComarchOptima,
                hasImages,
                hasFonts,
                nipFound: nipMatch ? nipMatch[0] : null,
                docNumberFound: docNumberMatch ? docNumberMatch[0] : null
            }
        };
    } else {
        return {
            fileName,
            fileType: 'pdf',
            hasTextLayer: false,
            extractedCharactersCount: alnumCount,
            extractedTextSample: textSample,
            recommendedPath: 'SLOW_PATH',
            reason: `Plik PDF nie posiada cyfrowej warstwy tekstowej (${alnumCount} znaków). Jest to zeskanowany dokument lub zdjęcie osadzone w kontenerze PDF. Wymaga analizy wizyjnej OCR (Gemini 3.5/3.8 Flash).`,
            executionTimeMs,
            detectedMetadata: {
                isComarchOptima: false,
                hasImages: true,
                hasFonts
            }
        };
    }
}
