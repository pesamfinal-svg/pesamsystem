#!/usr/bin/env python3
"""
scripts/detect_text_layer.py
Błyskawiczny program sprawdzający, czy plik posiada cyfrową warstwę tekstową,
czy jest to zdjęcie / zeskanowany obraz bez tekstu.

Zgodny ze specyfikacją PESAM 3.0 (Smart Router: Fast Path vs Slow Path).
Użycie:
    python scripts/detect_text_layer.py sciezka/do/pliku.pdf
"""

import sys
import os
import re
import zlib
import json
import time

def detect_file_text_layer(file_path: str) -> dict:
    start_time = time.perf_counter()
    
    if not os.path.exists(file_path):
        return {"error": f"Plik {file_path} nie istnieje."}
        
    file_name = os.path.basename(file_path)
    lower_name = file_name.lower()
    
    # 1. Obrazy rastrowe / zdjęcia ze smartfona
    image_extensions = ('.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff')
    if lower_name.endswith(image_extensions):
        exec_time = round((time.perf_counter() - start_time) * 1000, 2)
        return {
            "file_name": file_name,
            "file_type": "image",
            "has_text_layer": False,
            "characters_count": 0,
            "recommended_path": "SLOW_PATH",
            "model_to_use": "Gemini 3.5 / 3.8 Flash (Vision LLM)",
            "reason": "Plik to rastrowe zdjęcie/fotografia z telefonu lub skan bez warstwy tekstowej.",
            "execution_time_ms": exec_time,
            "cost_pln": 0.003
        }

    # 2. Audio (notatki foniczne)
    audio_extensions = ('.mp3', '.m4a', '.wav', '.ogg', '.aac')
    if lower_name.endswith(audio_extensions):
        exec_time = round((time.perf_counter() - start_time) * 1000, 2)
        return {
            "file_name": file_name,
            "file_type": "audio",
            "has_text_layer": False,
            "characters_count": 0,
            "recommended_path": "SPEECH_TO_TEXT",
            "model_to_use": "Whisper / Gemini Audio API",
            "reason": "Plik dźwiękowy (nagranie foniczne kierowcy z trasy).",
            "execution_time_ms": exec_time,
            "cost_pln": 0.001
        }

    # 3. Analiza PDF
    if not lower_name.endswith('.pdf'):
        exec_time = round((time.perf_counter() - start_time) * 1000, 2)
        return {
            "file_name": file_name,
            "file_type": "unknown",
            "has_text_layer": False,
            "characters_count": 0,
            "recommended_path": "SLOW_PATH",
            "reason": "Nierozpoznany format pliku.",
            "execution_time_ms": exec_time
        }

    with open(file_path, 'rb') as f:
        content = f.read()

    has_fonts = b'/Font' in content or b'/Type /Font' in content
    has_images = b'/Image' in content or b'/Subtype /Image' in content or b'/DCTDecode' in content
    is_comarch = b'Comarch' in content or b'Optima' in content or b'CDN Optima' in content or b'WZ/' in content

    # Szukanie strumieni i ich dekompresja
    streams = re.findall(b'stream\r?\n(.*?)\r?\nendstream', content, re.DOTALL)
    extracted_text_chunks = []

    for s in streams:
        decompressed = b""
        try:
            decompressed = zlib.decompress(s)
        except Exception:
            decompressed = s

        # Szukanie tekstu w operatorach PDF Tj i TJ
        tj_matches = re.findall(rb'\(([^()]{2,})\)\s*Tj', decompressed)
        for m in tj_matches:
            try:
                decoded = m.decode('utf-8', errors='ignore').strip()
                if len(decoded) > 1:
                    extracted_text_chunks.append(decoded)
            except Exception:
                pass

        tj_array_matches = re.findall(rb'\[(.*?)\]\s*TJ', decompressed, re.DOTALL)
        for arr in tj_array_matches:
            inner = re.findall(rb'\(([^()]+)\)', arr)
            word = "".join(i.decode('utf-8', errors='ignore') for i in inner).strip()
            if len(word) > 1:
                extracted_text_chunks.append(word)

        if len(extracted_text_chunks) > 50:
            break

    joined_text = " ".join(extracted_text_chunks)
    alnum_count = len(re.findall(r'[a-zA-Z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]', joined_text))
    has_text_layer = alnum_count >= 20

    exec_time = round((time.perf_counter() - start_time) * 1000, 2)

    if has_text_layer:
        return {
            "file_name": file_name,
            "file_type": "pdf",
            "has_text_layer": True,
            "characters_count": alnum_count,
            "text_sample": joined_text[:250],
            "recommended_path": "FAST_PATH",
            "processor": "Python pdfplumber / regex parser",
            "reason": f"Wykryto cyfrową warstwę tekstową ({alnum_count} znaków, {has_fonts and 'zdefiniowane czcionki' or 'strumienie tekstu'}). Czysty plik cyfrowy.",
            "execution_time_ms": exec_time,
            "cost_pln": 0.00,
            "is_comarch_optima": is_comarch
        }
    else:
        return {
            "file_name": file_name,
            "file_type": "pdf",
            "has_text_layer": False,
            "characters_count": alnum_count,
            "text_sample": "",
            "recommended_path": "SLOW_PATH",
            "processor": "Gemini 3.5 / 3.8 Flash (Vision LLM)",
            "reason": f"Plik PDF to 'martwy' skan / kserokopia w kontenerze PDF ({alnum_count} znaków). Brak wektorowej warstwy tekstu.",
            "execution_time_ms": exec_time,
            "cost_pln": 0.003,
            "is_comarch_optima": False
        }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Użycie: python scripts/detect_text_layer.py <sciezka_do_pliku>")
        sys.exit(1)
        
    target = sys.argv[1]
    res = detect_file_text_layer(target)
    print(json.dumps(res, indent=2, ensure_ascii=False))
